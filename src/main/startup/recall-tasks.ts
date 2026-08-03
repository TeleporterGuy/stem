import { readSettings } from '../workspace/settings';
import { isRecallEnabled } from '../workspace/memory';
import * as activity from '../activity';
import { embedNewMessages } from '../recall/embed-episodic';
import { backfillSummaries, refreshRecentSummaries } from '../recall/summarize';
import { distillNewMessages, shouldConsolidate } from '../recall/distill';
import { processPendingRelationChecks, relationSweepBackfillDone, stepRelationSweepBackfill } from '../recall/reconcile';
import { adjudicateOpenConflicts } from '../recall/adjudicate';
import { consolidateFacts } from '../recall/consolidate';
import { getMemoryRebuildStatus, runMemoryRebuildStep } from '../recall/rebuild';
import { recallStore } from '../recall/store';
import { curateSkills } from '../skills/curate';
import { getEmbeddingsClient } from '../recall/retrieval';
import type { LlmClient } from '../recall/llm';
import type { ChatBackend } from '../backend';

/**
 * Above this many open conflicts the relation-check pass stops raising new
 * ones. With the adjudicator resolving up to 15 per cycle, a gated backlog is
 * back under the gate within ~two cycles.
 */
const OPEN_CONFLICT_GATE = 20;

export interface RecallTasks {
  /** (Re)arm the debounced confirmed-rebuild stepper (no-op unless running). */
  scheduleMemoryRebuild: () => void;
  /** Debounced post-turn distillation + summary refresh + consolidation pass. */
  scheduleDistill: (delayMs?: number) => void;
  /** Debounced episodic embed pass (message vectors for semantic recall). */
  scheduleEpisodicEmbed: (delayMs?: number) => void;
}

/**
 * Stem Recall's background passes: fact distillation, rolling thread summaries,
 * consolidation, skills acquisition/curation, the confirmed memory rebuild and
 * the dormant summary backfill. All run through the hidden LlmClient seam
 * (a one-shot backend completion on the configured memory/skills model) and are
 * opportunistic — they yield to interactive work via `busyWithin`.
 */
export function initRecallTasks(deps: {
  runtime: () => ChatBackend;
  /** True while a turn runs on either surface or the user interacted within `idleMs`. */
  busyWithin: (idleMs: number) => boolean;
  /** Direct push to the main window (rebuild status stream). */
  sendToMainWindow: (channel: string, payload: unknown) => void;
}): RecallTasks {
  // Stem Recall: distill durable facts via a hidden backend turn (the swappable
  // LlmClient seam). Debounced so it runs ~after the user goes idle.
  const recallLlm: LlmClient = {
    complete: async (prompt) => deps.runtime().complete(prompt, { model: (await readSettings()).memory.model })
  };
  let rebuildTimer: NodeJS.Timeout | null = null;
  const scheduleMemoryRebuild = (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    if (getMemoryRebuildStatus().state !== 'running') return;
    rebuildTimer = setTimeout(async () => {
      // A confirmed rebuild is opportunistic and must yield to interactive work.
      if (deps.busyWithin(30_000)) {
        scheduleMemoryRebuild();
        return;
      }
      // Stepped: one entry spans the whole rebuild, re-opened by each batch, so
      // the panel shows "340/2100 messages" rather than 200 three-second rows.
      const handle = activity.begin('memory.rebuild', 'Rebuilding memory provenance', { stepped: true });
      const status = await runMemoryRebuildStep(recallLlm);
      deps.sendToMainWindow('memory:rebuildStatus', status);
      activity.progress(handle, { done: status.processedMessages, total: status.totalMessages });
      if (status.state === 'running') {
        // Bank this batch's time; the entry stays open until the rebuild ends.
        activity.yieldStep(handle);
        scheduleMemoryRebuild();
        return;
      }
      if (status.state === 'failed') {
        activity.fail('memory.rebuild', status.lastError ?? 'Memory rebuild failed');
        return;
      }
      activity.end(handle, {
        worked: status.processedMessages > 0,
        detail: `Reprocessed ${status.processedMessages.toLocaleString()} messages`
      });
    }, 2_000);
  };
  scheduleMemoryRebuild();

  // The skills curator gets its OWN model setting (separate from memory) — curation
  // can be a harder task than fact distillation, so it can be pointed at a stronger
  // model. Read fresh each pass so a Settings change applies to the next run.
  const skillsLlm: LlmClient = {
    complete: async (prompt) => deps.runtime().complete(prompt, { model: (await readSettings()).skills.model })
  };

  let distilling = false;
  let distillTimer: NodeJS.Timeout | null = null;
  const scheduleDistill = (delayMs = 15_000): void => {
    if (!isRecallEnabled()) return;
    if (distillTimer) clearTimeout(distillTimer);
    distillTimer = setTimeout(async () => {
      if (distilling) return;
      distilling = true;
      try {
        // Each sub-pass is its own activity row: they have separate watermarks and
        // fail independently, so "memory maintenance, 42 s" would hide which one
        // actually did (or failed to do) the work.
        await activity.track('memory.distill', 'Distilling facts', () => distillNewMessages(recallLlm), (n) => ({
          worked: n > 0,
          detail: `Learned ${n} fact${n === 1 ? '' : 's'}`
        }));
        // Rolling thread summaries (Level 1.5): revise the summaries of the
        // just-active threads from the same new messages. Own watermark, so a
        // failure here never blocks fact extraction (and vice versa).
        await activity.track('memory.summaries', 'Updating chat summaries', () => refreshRecentSummaries(recallLlm), (n) => ({
          worked: n > 0,
          detail: `Summarised ${n} chat${n === 1 ? '' : 's'}`
        }));
        // Classify queued fact pairs (sweep overflow, co-injected discoveries,
        // backfill) BEFORE adjudication, so any conflicts this raises are
        // resolved in the same cycle rather than lingering a full debounce.
        // Depth-gated: when the adjudicator is this far behind, classifying
        // more pairs would only push more facts into 'conflicted' limbo — let
        // the backlog drain first (the queue keeps the pairs).
        await activity.track('memory.relationCheck', 'Cross-checking memory', () => {
          if (recallStore.countOpenConflicts() > OPEN_CONFLICT_GATE) {
            return Promise.resolve({ checked: 0, conflicts: 0, gated: true });
          }
          return processPendingRelationChecks(recallLlm);
        }, (r) => ({
          worked: r.checked > 0,
          detail: 'gated' in r && r.gated
            ? 'Paused while conflicts drain'
            : `Checked ${r.checked} pair${r.checked === 1 ? '' : 's'}, raised ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}`
        }));
        // Auto-resolve open fact conflicts (non-explicit pairs only) before the
        // consolidation check, so reactivated winners and rewrite replacements
        // are visible to the same cycle's tidy pass.
        await activity.track('memory.adjudicate', 'Resolving memory conflicts', () => adjudicateOpenConflicts(recallLlm), (r) => ({
          worked: r.resolved > 0,
          detail: `Resolved ${r.resolved} conflict${r.resolved === 1 ? '' : 's'}`
        }));
        // Once enough new facts have piled up, clean the set: merge reworded
        // duplicates, apply corrections, drop superseded facts. Same hidden
        // LlmClient seam, so it's invisible to the user like distillation.
        if (shouldConsolidate()) {
          await activity.track('memory.consolidate', 'Tidying memory', () => consolidateFacts(recallLlm), (r) => ({
            worked: r.merged + r.corrected + r.dropped > 0,
            detail: `Merged ${r.merged}, corrected ${r.corrected}, dropped ${r.dropped}`
          }));
        }
        // Skills acquisition used to run here as a backlog pass over the same new
        // messages. It's gone: the recall DB stores only prose, so it was
        // reconstructing procedures from narration of tool calls it could never
        // see. Acquisition now happens in settleTurn (skills/settle.ts) off the
        // just-finished turn's real tool trace, which leaves no backlog behind.
      } catch {
        // non-fatal
      } finally {
        distilling = false;
      }
    }, delayMs);
  };

  // Episodic embed pass: keep message vectors current for semantic recall.
  // Debounced off turn/completed (plus one startup pass) and routed through the
  // settings-aware router client, so remote-mode users backfill too — the
  // ready-transition hook in startup/retrieval.ts only covers the local worker
  // coming up.
  let episodicEmbedTimer: NodeJS.Timeout | null = null;
  const scheduleEpisodicEmbed = (delayMs = 10_000): void => {
    if (!isRecallEnabled()) return;
    if (episodicEmbedTimer) clearTimeout(episodicEmbedTimer);
    episodicEmbedTimer = setTimeout(() => {
      const client = getEmbeddingsClient();
      if (!client) return;
      void activity
        .track('memory.episodicEmbed', 'Embedding messages', () => embedNewMessages(client), (n) => ({
          worked: n > 0,
          detail: `Embedded ${n.toLocaleString()} message${n === 1 ? '' : 's'}`
        }))
        .catch(() => {
          // Reported by track(); embedding failures stay non-fatal as before.
        });
    }, delayMs);
  };

  // Skills curator: the Level-2 cleanup of self-authored skills (merge duplicates,
  // patch sloppy bodies, archive stale ones), mirroring fact consolidation. Uses the
  // same hidden LlmClient seam, and is gated by the memory toggle since it's the same
  // kind of background self-improvement pass. On any change, reload so pi rescans skills.
  let curating = false;
  const runCurate = async (): Promise<void> => {
    if (curating || !isRecallEnabled()) return;
    curating = true;
    try {
      const res = await activity.track('skills.curate', 'Curating skills', () => curateSkills(skillsLlm), (r) => ({
        worked: r.merged + r.archived > 0,
        detail: `Merged ${r.merged}, archived ${r.archived}`
      }));
      if (res.merged || res.archived) await deps.runtime().requestSkillReload();
    } catch {
      // non-fatal
    } finally {
      curating = false;
    }
  };
  // A pass shortly after startup, then a low-frequency recurring pass while idle.
  setTimeout(() => void runCurate(), 90_000);
  setInterval(() => void runCurate(), 24 * 60 * 60_000);

  // Summary backfill for dormant threads (history that predates summaries, or
  // fell behind while the app was closed). Opportunistic like the rebuild pass:
  // it must yield to any interactive work, so a skipped pass just waits for the
  // next interval tick.
  const runSummaryBackfill = async (): Promise<void> => {
    if (deps.busyWithin(30_000)) return;
    try {
      await activity.track(
        'memory.summaryBackfill',
        'Summarising older chats',
        () => backfillSummaries(recallLlm, 3),
        (n) => ({ worked: n > 0, detail: `Summarised ${n} chat${n === 1 ? '' : 's'}` })
      );
    } catch {
      // non-fatal
    }
  };
  setTimeout(() => void runSummaryBackfill(), 3 * 60_000);
  setInterval(() => void runSummaryBackfill(), 30 * 60_000);

  // Retroactive relation sweep: facts distilled before the neighbour sweep
  // existed have never been cross-checked against their semantic neighbours.
  // Enumerate their pairs batch-by-batch (vectors only — the model calls happen
  // in the relationCheck pass above) until the cursor covers the store, then
  // stop for good. Opportunistic like the other backfills.
  const runRelationSweepBackfill = async (): Promise<void> => {
    if (!isRecallEnabled() || relationSweepBackfillDone()) return;
    if (deps.busyWithin(30_000)) return;
    try {
      await activity.track(
        'memory.relationSweepBackfill',
        'Mapping related memories',
        () => stepRelationSweepBackfill(),
        (r) => ({ worked: r.enqueued > 0, detail: r.done ? 'Coverage complete' : `Queued ${r.enqueued} pair${r.enqueued === 1 ? '' : 's'}` })
      );
    } catch {
      // non-fatal
    }
  };
  setTimeout(() => void runRelationSweepBackfill(), 4 * 60_000);
  setInterval(() => void runRelationSweepBackfill(), 10 * 60_000);

  // Kick off a distillation pass shortly after startup so any messages captured
  // before the app last quit get turned into durable facts. The episodic embed
  // pass runs too, covering remote embeddings mode (no ready-transition there).
  scheduleDistill(20_000);
  scheduleEpisodicEmbed(25_000);

  return { scheduleMemoryRebuild, scheduleDistill, scheduleEpisodicEmbed };
}
