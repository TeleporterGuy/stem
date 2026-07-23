import type { FactDetails } from '../../shared/types';
import { log } from '../log';
import { PENDING_KEY } from './distill';
import type { LlmClient } from './llm';
import { evidenceDateOf } from './reconcile';
import { recallStore, type AdjudicationDecision, type ConflictForAdjudication } from './store';
const { applyAdjudication, bumpAdjudicationAttempts, getConflictsForAdjudication, getFactsGeneration, getMeta, setMeta } = recallStore;

// The autonomous conflict adjudicator: a second look at open conflicts with more
// context than the creation-time reconciler had (evidence excerpts, dates, the
// recorded reason). Runs after every distill/learn cycle, never touches a
// conflict with an explicit side (the store filters those out — the user's word
// is only ever adjudicated by the user), and defaults to keep: an unparseable or
// unsure reply leaves the conflict open for the Conflicts card. Attempts are
// capped so a conflict the model can't crack falls back to manual-only instead
// of burning a call every cycle.

// Exported so tests dispatch fake-LLM replies on the constant instead of a
// brittle regex over prompt wording.
export const ADJUDICATE_PROMPT_HEADER = 'You are resolving a conflict between two remembered facts about the same user.';
const MAX_PER_PASS = 5;
const MAX_REWRITE_FACTS = 4;
export const MAX_ADJUDICATE_ATTEMPTS = 3;

let running = false;

function side(label: 'A' | 'B', f: FactDetails): string {
  const lines = [`${label} [${f.id}] (source: ${f.source}, evidence dated ${evidenceDateOf(f) ?? 'unknown'}): ${f.text}`];
  for (const e of f.evidence.slice(-2)) {
    lines.push(`  evidence (${e.origin}${e.relPath ? `, ${e.relPath}` : ''}): ${e.excerpt.slice(0, 300)}`);
  }
  return lines.join('\n');
}

function buildPrompt(c: ConflictForAdjudication): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${ADJUDICATE_PROMPT_HEADER}

${side('A', c.factA)}

${side('B', c.factB)}

Flagged because: ${c.reason}
Today's date: ${today}.

Decide:
- "a_wins" / "b_wins": one statement is the current truth and the other is outdated or wrong.
- "both_true": both can hold at once — different things (different invoices, contracts), or complementary details about the same thing.
- "rewrite": both are partially right, or a statement bundles several claims of which only some are contested. Replace BOTH with 1-${MAX_REWRITE_FACTS} short atomic third-person statements ("The user ..."), carrying over the natural identifiers and dates from the originals.
- "unclear": you cannot tell — leave the conflict for the user.

Return ONLY JSON {"outcome":"a_wins"|"b_wins"|"both_true"|"rewrite"|"unclear","facts":[]} ("facts" only for rewrite).`;
}

/** Parse the model's reply into a decision; null = leave the conflict open. */
export function parseAdjudication(raw: string, c: ConflictForAdjudication): AdjudicationDecision | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: { outcome?: unknown; facts?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { outcome?: unknown; facts?: unknown };
  } catch {
    return null;
  }
  switch (parsed.outcome) {
    case 'a_wins':
      return { kind: 'winner', winnerId: c.factA.id };
    case 'b_wins':
      return { kind: 'winner', winnerId: c.factB.id };
    case 'both_true':
      return { kind: 'both' };
    case 'rewrite': {
      const texts = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean);
      return texts.length >= 1 && texts.length <= MAX_REWRITE_FACTS ? { kind: 'rewrite', texts } : null;
    }
    default:
      return null;
  }
}

/**
 * Adjudicate up to MAX_PER_PASS eligible open conflicts. Serialized (re-entrant
 * kicks are no-ops) and best-effort: it must never surface a rejection into the
 * background schedulers that fire it.
 */
export async function adjudicateOpenConflicts(llm: LlmClient): Promise<{ resolved: number; skipped: number }> {
  if (running) return { resolved: 0, skipped: 0 };
  running = true;
  let resolved = 0;
  let skipped = 0;
  try {
    const factsGeneration = getFactsGeneration();
    for (const conflict of getConflictsForAdjudication(MAX_PER_PASS, MAX_ADJUDICATE_ATTEMPTS)) {
      // Count the attempt before the call so a crash mid-call still counts
      // toward the cap.
      bumpAdjudicationAttempts(conflict.id);
      let decision: AdjudicationDecision | null = null;
      try {
        decision = parseAdjudication(await llm.complete(buildPrompt(conflict)), conflict);
      } catch {
        decision = null;
      }
      // Reset is a hard cancellation barrier; conflict/fact ids can be reused after.
      if (getFactsGeneration() !== factsGeneration) break;
      if (!decision) {
        skipped += 1;
        continue;
      }
      const applied = applyAdjudication(conflict.id, decision, {
        aId: conflict.factA.id,
        aText: conflict.factA.text,
        bId: conflict.factB.id,
        bText: conflict.factB.text
      });
      if (!applied) {
        skipped += 1;
        continue;
      }
      resolved += 1;
      // Replacement facts are new material for the consolidation pass.
      if (decision.kind === 'rewrite') {
        const pending = (Number.parseInt(getMeta(PENDING_KEY) ?? '0', 10) || 0) + decision.texts.length;
        setMeta(PENDING_KEY, String(pending));
      }
    }
    if (resolved > 0 || skipped > 0) log('adjudicate', 'conflict adjudication pass', { resolved, skipped });
  } catch {
    // Best-effort: store or model failures leave remaining conflicts open.
  } finally {
    running = false;
  }
  return { resolved, skipped };
}
