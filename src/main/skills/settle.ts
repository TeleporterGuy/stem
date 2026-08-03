import type { SettledTurnTrace } from '../pi/normalize';
import type { LlmClient } from '../recall/llm';
import type { SkillsMode } from '../../shared/types';
import { authorSkill, type AuthorOutcome } from './author';
import { readSkillRecord } from './store';

// The end-of-turn pass: after a turn that did real work, decide whether it left
// behind a procedure worth keeping.
//
// The gate in front of the model call is deterministic and cheap, and that is the
// whole point. Backtested over 547 turns of local history, 73% of turns call no
// tools at all — so a tool-count gate is free on nearly three turns in four, and
// the model is only asked the expensive question about the ~12% where something
// actually happened. The alternative, asking on every turn, is what the previous
// system did, and it produced 25 skills of which 23 were never used.
//
// One clause the backtest killed: "or the turn recovered from an error". It reads
// well — a procedure someone got right only after a dead end is exactly the kind
// worth saving — but all five recovery turns in the corpus already had four or
// more tool calls, so the clause added no coverage at all. Dead-end-and-recover
// is a coding-agent shape; this is a personal assistant. Recovery still earns its
// keep in ROUTING (a turn that loaded a skill and then failed should patch it),
// just not in firing.

/**
 * Tool calls a turn needs before it is worth a model call. Backtest: >=4 fires on
 * 12.2% of turns, >=6 on 9.0%. Five splits them, and is the number to re-derive
 * against the corpus rather than argue about — the harvester in
 * scripts/skill-fixtures.mjs rebuilds the same sample.
 */
export const SKILL_GATE_MIN_TOOL_CALLS = 5;

export type SettleDecision =
  | { fire: false; reason: 'below-gate' | 'tainted' | 'scheduled' | 'mode-off' }
  | { fire: true; existing?: { name: string; description: string; body: string } };

/**
 * Should this turn be offered to the author, and as a create or a patch?
 *
 * Pure and separately testable on purpose: the reasons a turn is skipped are the
 * part worth pinning, and three of the four are about restraint rather than cost.
 * `tainted` means the turn read inside a folder the user marked do-not-memorize —
 * a skill written from it would launder that content into a file that is injected
 * on later turns, which is exactly what the flag exists to prevent. `scheduled`
 * means nobody is watching, so neither a card nor a silent write is honest.
 */
export function decideSettle(turn: SettledTurnTrace, mode: SkillsMode): SettleDecision {
  if (mode === 'off') return { fire: false, reason: 'mode-off' };
  if (turn.memoryTainted) return { fire: false, reason: 'tainted' };
  if (turn.isScheduled) return { fire: false, reason: 'scheduled' };
  if (turn.trace.length < SKILL_GATE_MIN_TOOL_CALLS) return { fire: false, reason: 'below-gate' };

  // The turn already had a skill loaded: improve that one rather than adding a
  // near-duplicate beside it. Where several were loaded, take the first — it
  // ranked highest against this message, so it is the one the turn was actually
  // working from.
  for (const slug of turn.skillsUsed) {
    const record = readSkillRecord(slug);
    if (record) return { fire: true, existing: { name: record.name, description: record.description, body: record.body } };
  }
  return { fire: true };
}

export interface SettleOutcome {
  decision: SettleDecision;
  author?: AuthorOutcome;
}

/**
 * Run the pass for one settled turn. Returns what happened without writing
 * anything: the caller routes the draft through the same SkillBridge the live
 * tool uses, so the mode, the card, and the validator all behave identically
 * whichever surface proposed the skill.
 */
export async function settleSkills(
  turn: SettledTurnTrace,
  mode: SkillsMode,
  llm: LlmClient,
  opts: { focus?: string } = {}
): Promise<SettleOutcome> {
  const decision = decideSettle(turn, mode);
  if (!decision.fire) return { decision };
  const author = await authorSkill(llm, {
    trace: turn.trace,
    userText: turn.userText,
    assistantText: turn.assistantText,
    existing: decision.existing,
    focus: opts.focus
  });
  return { decision, author };
}
