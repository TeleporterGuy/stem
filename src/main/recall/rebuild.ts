import type { MemoryRebuildStatus } from '../../shared/types';

import {
  buildDistillBatch,
  DISTILL_INSTRUCTIONS,
  knownFactsBlock,
  parseClaims,
  type DistillCursor
} from './distill';
import { classifyRelation, evidenceDateOf } from './reconcile';
import type { LlmClient } from './llm';
import { recallStore, type StoredMessage } from './store';
const { createFactConflict, getFactDetails, getFactsGeneration, getMeta, messageCount, setMeta, supersedeFact, upsertFact } = recallStore;

const REBUILD_KEY = 'memory_rebuild_v2';

function initialStatus(): MemoryRebuildStatus {
  const total = messageCount();
  return {
    state: total > 0 ? 'available' : 'complete',
    processedMessages: 0,
    totalMessages: total,
    cursorMessageId: 1,
    cursorOffset: 0
  };
}

function save(status: MemoryRebuildStatus): MemoryRebuildStatus {
  setMeta(REBUILD_KEY, JSON.stringify(status));
  return status;
}

export function getMemoryRebuildStatus(): MemoryRebuildStatus {
  const raw = getMeta(REBUILD_KEY);
  if (!raw) return initialStatus();
  try {
    const parsed = JSON.parse(raw) as MemoryRebuildStatus;
    if (parsed && typeof parsed.cursorMessageId === 'number') {
      return { ...parsed, totalMessages: Math.max(parsed.totalMessages, messageCount()) };
    }
  } catch {
    // Reset corrupt progress without touching memories.
  }
  return initialStatus();
}

export function startMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  if (current.state === 'paused' || current.state === 'failed') return save({ ...current, state: 'running', lastError: undefined });
  if (current.state === 'complete') return current;
  return save({ ...initialStatus(), state: 'running' });
}

export function pauseMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  return current.state === 'running' ? save({ ...current, state: 'paused' }) : current;
}

export function resumeMemoryRebuild(): MemoryRebuildStatus {
  const current = getMemoryRebuildStatus();
  return current.state === 'paused' || current.state === 'failed'
    ? save({ ...current, state: 'running', lastError: undefined })
    : current;
}

function evidenceFor(ids: number[], messages: Map<number, StoredMessage>) {
  return ids.map((id) => messages.get(id)).filter((m): m is StoredMessage => !!m);
}

/** Process exactly one bounded rebuild batch; caller schedules subsequent idle steps. */
export async function runMemoryRebuildStep(llm: LlmClient): Promise<MemoryRebuildStatus> {
  const status = getMemoryRebuildStatus();
  if (status.state !== 'running') return status;
  const factsGeneration = getFactsGeneration();
  const cursor: DistillCursor = { messageId: status.cursorMessageId, offset: status.cursorOffset };
  const batch = buildDistillBatch(cursor);
  if (!batch) return save({ ...status, state: 'complete', processedMessages: status.totalMessages });

  try {
    const reply = await llm.complete(
      `${DISTILL_INSTRUCTIONS}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.` +
      `${knownFactsBlock(batch.messages.map((m) => m.text).join('\n'))}\n\nTranscript:\n${batch.transcript}`
    );
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    const claims = parseClaims(reply);
    const messages = new Map(batch.messages.map((m) => [m.id, m]));
    for (const claim of claims) {
      if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
      const validIds = claim.evidenceMessageIds.filter((id) => messages.has(id));
      // Backfilled evidence is provenance, not authority (see distill.ts): only a
      // claim whose own citations resolved gets 0.9 confidence and supersede power.
      const cited = validIds.length > 0;
      const fallback = batch.messages.filter((m) => m.role === 'user').map((m) => m.id);
      const evidenceMessages = evidenceFor(cited ? validIds : fallback, messages);
      const directUser = cited && evidenceMessages.some((m) => m.role === 'user');
      const factId = upsertFact(claim.text, {
        source: 'distilled',
        category: claim.category,
        sensitivity: claim.sensitivity,
        confidence: directUser ? 0.9 : 0.55,
        validUntil: claim.validUntil,
        evidence: evidenceMessages.map((m) => ({
          messageId: m.id,
          threadId: m.threadId,
          role: m.role,
          timestamp: m.ts,
          excerpt: m.text,
          origin: directUser && m.role === 'user' ? 'user_message' : 'assistant_claim'
        }))
      });
      if (factId == null) continue;
      // The rebuild re-reads transcripts that distillation already mined, so its
      // "supersedes"/"conflicts" links land overwhelmingly on restatements of the
      // same fact. Only a classified disagreement is worth a user-facing conflict.
      const incomingDate = evidenceDateOf(getFactDetails(factId));
      const raiseVerified = async (targetId: number, reason: string): Promise<boolean> => {
        const target = getFactDetails(targetId);
        if (!target || target.id === factId || target.status !== 'active') return true;
        const verdict = await classifyRelation(
          { text: target.text, evidenceDate: evidenceDateOf(target) },
          { text: claim.text, evidenceDate: incomingDate },
          llm
        );
        if (getFactsGeneration() !== factsGeneration) return false;
        if (verdict === 'compatible') return true;
        const current = getFactDetails(targetId);
        if (current && current.status === 'active' && current.text === target.text) {
          createFactConflict(targetId, factId, reason);
        }
        return true;
      };
      for (const targetId of claim.supersedesFactIds) {
        const target = getFactDetails(targetId);
        if (!target || target.id === factId) continue;
        if (directUser && target.source !== 'explicit') {
          supersedeFact(targetId, factId);
        } else if (!(await raiseVerified(targetId, 'Rebuilt evidence may contradict this fact.'))) {
          return getMemoryRebuildStatus();
        }
      }
      for (const targetId of claim.conflictsWithFactIds) {
        if (claim.supersedesFactIds.includes(targetId)) continue;
        if (!(await raiseVerified(targetId, 'Rebuilt evidence is ambiguous.'))) {
          return getMemoryRebuildStatus();
        }
      }
    }
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    const completedMessages = batch.messages.filter((m) => m.id < batch.nextCursor.messageId).length;
    // Re-read: the model call above takes seconds, and the user may have paused
    // meanwhile. Persist this batch's progress, but never resurrect 'running' over
    // a pause the user asked for while we were in flight.
    const latest = getMemoryRebuildStatus();
    return save({
      ...latest,
      processedMessages: Math.min(latest.totalMessages, status.processedMessages + completedMessages),
      cursorMessageId: batch.nextCursor.messageId,
      cursorOffset: batch.nextCursor.offset,
      lastError: undefined
    });
  } catch (error) {
    // A reset invalidates the in-flight model call and clears rebuild progress.
    // Its rejection must not recreate that progress as a stale failed run.
    if (getFactsGeneration() !== factsGeneration) return getMemoryRebuildStatus();
    const latest = getMemoryRebuildStatus();
    return save({
      ...latest,
      state: 'failed',
      lastError: error instanceof Error ? error.message : 'Memory rebuild failed'
    });
  }
}
