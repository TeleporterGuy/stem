import { readSettings } from '../workspace/settings';
import { isRecallEnabled } from '../workspace/memory';
import { embedNewMessages } from '../recall/embed-episodic';
import { backfillSummaries, refreshRecentSummaries } from '../recall/summarize';
import { distillNewMessages, shouldConsolidate } from '../recall/distill';
import { adjudicateOpenConflicts } from '../recall/adjudicate';
import { consolidateFacts } from '../recall/consolidate';
import { getMemoryRebuildStatus, runMemoryRebuildStep } from '../recall/rebuild';
import { curateSkills } from '../skills/curate';
import { distillSkillsFromMessages } from '../skills/distill';
import { getEmbeddingsClient } from '../recall/retrieval';
import type { LlmClient } from '../recall/llm';
import type { ChatBackend } from '../backend';

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
      const status = await runMemoryRebuildStep(recallLlm);
      deps.sendToMainWindow('memory:rebuildStatus', status);
      if (status.state === 'running') scheduleMemoryRebuild();
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
        await distillNewMessages(recallLlm);
        // Rolling thread summaries (Level 1.5): revise the summaries of the
        // just-active threads from the same new messages. Own watermark, so a
        // failure here never blocks fact extraction (and vice versa).
        await refreshRecentSummaries(recallLlm);
        // Auto-resolve open fact conflicts (non-explicit pairs only) before the
        // consolidation check, so reactivated winners and rewrite replacements
        // are visible to the same cycle's tidy pass.
        await adjudicateOpenConflicts(recallLlm);
        // Once enough new facts have piled up, clean the set: merge reworded
        // duplicates, apply corrections, drop superseded facts. Same hidden
        // LlmClient seam, so it's invisible to the user like distillation.
        if (shouldConsolidate()) await consolidateFacts(recallLlm);
        // Skills acquisition: a separate single-purpose pass over the same new
        // messages (own watermark) — the in-turn manage_skill nudge alone never
        // fires. Uses the skills model; a write reloads pi so the skill activates.
        const newSkills = await distillSkillsFromMessages(skillsLlm);
        if (newSkills > 0) await deps.runtime().requestSkillReload();
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
      if (client) void embedNewMessages(client);
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
      const res = await curateSkills(skillsLlm);
      if (res.merged || res.patched || res.archived) await deps.runtime().requestSkillReload();
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
      await backfillSummaries(recallLlm, 3);
    } catch {
      // non-fatal
    }
  };
  setTimeout(() => void runSummaryBackfill(), 3 * 60_000);
  setInterval(() => void runSummaryBackfill(), 30 * 60_000);

  // Kick off a distillation pass shortly after startup so any messages captured
  // before the app last quit get turned into durable facts. The episodic embed
  // pass runs too, covering remote embeddings mode (no ready-transition there).
  scheduleDistill(20_000);
  scheduleEpisodicEmbed(25_000);

  return { scheduleMemoryRebuild, scheduleDistill, scheduleEpisodicEmbed };
}
