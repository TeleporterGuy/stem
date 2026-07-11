import {
  createFactConflict,
  getFactDetails,
  getInjectableFacts,
  supersedeFact
} from './store';
import type { LlmClient } from './llm';

interface ReconcileReply {
  supersedeIds?: unknown;
  conflictIds?: unknown;
}

/**
 * Does `incoming` actually contradict `existing`, or do they merely describe the
 * same subject?
 *
 * An extractor's `supersedesFactIds` is a *claim* that the new text replaces the
 * old one, and it is routinely wrong: two facts about the same appointment ("…€85
 * due at registration" and "…a Slovak interpreter was secured") are complementary,
 * not contradictory. Raising a user-facing conflict on that assertion alone floods
 * the Conflicts card with pairs that are both true. So when we lack the authority
 * to supersede outright, we ask instead of assuming.
 *
 * Defaults to `false` (no conflict) whenever the model is unreachable or
 * unparseable: a missed contradiction is quietly adjudicated by the consolidation
 * pass later, while a false conflict demands the user resolve something that isn't
 * broken.
 */
export async function contradicts(existing: string, incoming: string, llm: LlmClient): Promise<boolean> {
  const prompt = `Two statements describe the same user. Decide whether they can BOTH be true at once.

A: ${existing}
B: ${incoming}

Statements about the same subject that add different details (a payment, an interpreter, a companion) are COMPATIBLE. Only statements that assert different values for the same attribute — a different date, place, price, or status — are INCOMPATIBLE.

Return ONLY JSON {"compatible": true} or {"compatible": false}.`;
  try {
    const raw = await llm.complete(prompt);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return false;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { compatible?: unknown };
    return parsed.compatible === false;
  } catch {
    return false;
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
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return;
    parsed = JSON.parse(raw.slice(start, end + 1)) as ReconcileReply;
  } catch {
    return;
  }
  const valid = new Set(candidates.map((f) => f.id));
  for (const id of ids(parsed.supersedeIds)) {
    if (valid.has(id)) supersedeFact(id, factId);
  }
  for (const id of ids(parsed.conflictIds)) {
    if (valid.has(id)) createFactConflict(id, factId, 'A new explicit memory may contradict this fact.');
  }
}
