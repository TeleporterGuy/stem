
import type { FactDetails } from '../../shared/types';
import type { LlmClient } from './llm';
import { newestEvidenceTs, recallStore } from './store';
const { createFactConflict, getFactDetails, getFactsGeneration, getInjectableFacts, supersedeFact } = recallStore;

interface ReconcileReply {
  supersedeIds?: unknown;
  conflictIds?: unknown;
}

/** How two fact texts relate; the `supersedes` verdicts carry direction. */
export type FactRelation = 'compatible' | 'contradicts' | 'a_supersedes_b' | 'b_supersedes_a';

export interface RelationSide {
  text: string;
  /** ISO date (YYYY-MM-DD) of the side's newest evidence, or null when unknown. */
  evidenceDate: string | null;
}

// Exported so tests dispatch fake-LLM replies on the constant instead of a
// brittle regex over prompt wording.
export const RELATION_PROMPT_HEADER = 'Two statements describe the same user. Decide how they relate.';

/** Evidence timestamp → ISO date for the relation prompt. */
export function isoDate(ts: number | null): string | null {
  return ts == null ? null : new Date(ts * 1000).toISOString().slice(0, 10);
}

/** The newest-evidence date of a fact, formatted for a RelationSide. */
export function evidenceDateOf(details: FactDetails | null): string | null {
  return details ? isoDate(newestEvidenceTs(details)) : null;
}

/**
 * How does `b` (the incoming claim) relate to `a` (the existing fact)?
 *
 * An extractor's `supersedesFactIds`/`conflictsWithFactIds` is a *claim* about the
 * relation, and it is routinely wrong: two facts about the same appointment ("…€85
 * due at registration" and "…a Slovak interpreter was secured") are complementary,
 * not contradictory. Raising a user-facing conflict on that assertion alone floods
 * the Conflicts card with pairs that are both true — so we classify instead of
 * assuming. The supersede verdicts exist for temporal succession (a renewal, a
 * price change): same attribute of the same thing, one side clearly the newer
 * state. Callers decide whether they have the authority to act on them.
 *
 * Defaults to `'compatible'` whenever the model is unreachable or unparseable: a
 * missed contradiction is quietly adjudicated by a later pass, while a false
 * conflict demands the user resolve something that isn't broken.
 */
export async function classifyRelation(a: RelationSide, b: RelationSide, llm: LlmClient): Promise<FactRelation> {
  const prompt = `${RELATION_PROMPT_HEADER}

A (evidence dated ${a.evidenceDate ?? 'unknown'}): ${a.text}
B (evidence dated ${b.evidenceDate ?? 'unknown'}): ${b.text}

Classify:
- "compatible": they add different details about the same subject (a payment, an interpreter, a companion), or they concern DIFFERENT things entirely (different invoice numbers, different contracts, different policies). Both can be true at once.
- "b_supersedes_a" / "a_supersedes_b": both state the same attribute of the SAME thing (the same domain, contract, policy, recurring fee) and one is clearly the newer state — a renewal, a price change, an update. Prefer dates stated INSIDE the statements over the evidence dates; evidence dates are file or message times and can lie.
- "contradicts": they assert different values for the same attribute and there is no way to tell which is current.

Return ONLY JSON {"verdict":"compatible"|"contradicts"|"a_supersedes_b"|"b_supersedes_a"}.`;
  try {
    const raw = await llm.complete(prompt);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return 'compatible';
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { verdict?: unknown };
    return parsed.verdict === 'contradicts' || parsed.verdict === 'a_supersedes_b' || parsed.verdict === 'b_supersedes_a'
      ? parsed.verdict
      : 'compatible';
  } catch {
    return 'compatible';
  }
}

function ids(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((n): n is number => Number.isInteger(n)))]
    : [];
}

/**
 * Reconcile one newly explicit memory against a bounded active snapshot. The
 * model may propose candidates, but the store enforces authority: this function
 * is only called for a new explicit fact, so it may supersede older facts; an
 * ambiguous relation becomes a visible conflict instead.
 */
export async function reconcileExplicitFact(factId: number, llm: LlmClient): Promise<void> {
  try {
    await reconcile(factId, llm);
  } catch {
    // Best-effort: the fact itself is already durable. Callers fire this off the
    // acknowledgement path, so a store or model failure must not surface as an
    // unhandled rejection in the main process.
  }
}

async function reconcile(factId: number, llm: LlmClient): Promise<void> {
  const factsGeneration = getFactsGeneration();
  const fresh = getFactDetails(factId);
  if (!fresh || fresh.source !== 'explicit') return;
  const candidates = getInjectableFacts()
    .filter((f) => f.id !== factId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80);
  if (candidates.length === 0) return;
  const prompt = `A user explicitly asked a personal assistant to remember a new fact.

New explicit fact:
[${fresh.id}] ${fresh.text}

Existing facts:
${candidates.map((f) => `[${f.id}] ${f.text} (source:${f.source})`).join('\n')}

Return ONLY JSON {"supersedeIds":[],"conflictIds":[]}.
- supersedeIds: older facts directly made false or obsolete by the new fact.
- conflictIds: facts that may conflict but cannot confidently be resolved.
- Related but simultaneously true facts belong in neither list.
- Use only ids listed above.`;
  let parsed: ReconcileReply;
  try {
    const raw = await llm.complete(prompt);
    if (getFactsGeneration() !== factsGeneration) return;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return;
    parsed = JSON.parse(raw.slice(start, end + 1)) as ReconcileReply;
  } catch {
    return;
  }
  // Reset is a hard cancellation barrier and fact ids can be reused afterward.
  // Re-check both the epoch and the authority of the initiating fact immediately
  // before applying any model-proposed relationship.
  if (getFactsGeneration() !== factsGeneration) return;
  const currentFresh = getFactDetails(factId);
  if (!currentFresh || currentFresh.status !== 'active' || currentFresh.source !== 'explicit') return;
  const valid = new Set(
    candidates
      .filter((candidate) => {
        const current = getFactDetails(candidate.id);
        return current?.status === 'active' && current.text === candidate.text;
      })
      .map((candidate) => candidate.id)
  );
  for (const id of ids(parsed.supersedeIds)) {
    if (valid.has(id)) supersedeFact(id, factId);
  }
  for (const id of ids(parsed.conflictIds)) {
    if (valid.has(id)) createFactConflict(id, factId, 'A new explicit memory may contradict this fact.');
  }
}
