
import type { FactDetails } from '../../shared/types';
import type { LlmClient } from './llm';
import { getEmbeddingsClient } from './retrieval';
import { cosineSim } from './vector';
import { newestEvidenceTs, recallStore } from './store';
const {
  createFactConflict, enqueueRelationChecks, getAllFacts, getFactDetails, getFactsGeneration,
  getFactsMissingVector, getFactVectors, getInjectableFacts, getMeta, getPendingRelationChecks,
  isRelationChecked, recordRelationResult, recordRelationVerdict, setMeta, supersedeFact,
  upsertFactVectorForSnapshot
} = recallStore;

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

// ---------------------------------------------------------------------------
// The neighbour sweep: extractor-independent truth maintenance.
//
// The extractor's supersedesFactIds only ever name facts it was shown, so a
// stale fact worded differently from the new one ("switched to Firefox" vs
// "uses Arc rather than Zen") survives every update that should have retired
// it — and, being topically perfect, keeps winning injection. The sweep takes
// candidate selection away from the model: every new fact is compared against
// its top embedding neighbours, and classifyRelation decides the relation.
// Verdicts are memoized in fact_relation_checks so no pair costs two model
// calls, ever.

/** Only pairs at least this semantically close are worth a classify call. */
export const SWEEP_MIN_COSINE = 0.55;
/** Neighbours examined per new fact. */
export const SWEEP_NEIGHBOURS = 5;
/** Conflict reason for sweep- and queue-discovered disagreements. */
export const SWEEP_CONFLICT_REASON = 'A semantically similar memory may contradict this fact.';

/** Mutable classify-call budget shared across one distillation pass. */
export interface SweepBudget {
  remaining: number;
}

/** Top embedding neighbours of `factId` among the other active facts. */
function neighbourIdsOf(factId: number, vectors: Map<number, Float32Array>, activeIds: Set<number>): number[] {
  const own = vectors.get(factId);
  if (!own) return [];
  const scored: Array<{ id: number; score: number }> = [];
  for (const [id, vec] of vectors) {
    if (id === factId || !activeIds.has(id)) continue;
    const score = cosineSim(own, vec);
    if (score >= SWEEP_MIN_COSINE) scored.push({ id, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SWEEP_NEIGHBOURS)
    .map((s) => s.id);
}

/**
 * Sweep one freshly written fact against its embedding neighbours.
 *
 * Authority mirrors the extractor-named path in distill.ts exactly: the sweep
 * may auto-supersede a neighbour only when the model says the NEW fact
 * supersedes it, the new fact is directly user-stated AND still undisputed,
 * and the neighbour is neither explicit nor pinned. Every other non-compatible
 * verdict raises an ordinary conflict for the adjudicator/Conflicts card.
 * Pairs beyond the pass's classify budget are queued for the background pass
 * instead of judged inline, so a chatty session can't stall distillation.
 *
 * A `conflicted` fresh fact still gets swept (conflict-only): raising one
 * extractor-named conflict must not switch off the extractor-independent
 * safety net for the very fact that just proved contentious.
 *
 * Returns false when a facts reset invalidated the pass (mirror of
 * raiseVerified in distill.ts) — the caller must stop writing.
 */
export async function sweepFactAgainstNeighbours(
  factId: number,
  model: string,
  llm: LlmClient,
  opts: { directUser: boolean; skipIds?: ReadonlySet<number>; budget?: SweepBudget }
): Promise<boolean> {
  const factsGeneration = getFactsGeneration();
  const fresh = getFactDetails(factId);
  if (!fresh || (fresh.status !== 'active' && fresh.status !== 'conflicted')) return true;
  const activeIds = new Set(getAllFacts().filter((f) => f.status === 'active').map((f) => f.id));
  const targets = neighbourIdsOf(factId, getFactVectors(model), activeIds)
    .filter((id) => !opts.skipIds?.has(id))
    .filter((id) => !isRelationChecked(factId, id));
  for (const targetId of targets) {
    if (opts.budget && opts.budget.remaining <= 0) {
      enqueueRelationChecks([[factId, targetId]], 'sweep');
      continue;
    }
    const target = getFactDetails(targetId);
    if (!target || target.status !== 'active') continue;
    if (opts.budget) opts.budget.remaining -= 1;
    const verdict = await classifyRelation(
      { text: target.text, evidenceDate: evidenceDateOf(target) },
      { text: fresh.text, evidenceDate: evidenceDateOf(fresh) },
      llm
    );
    if (getFactsGeneration() !== factsGeneration) return false;
    // The classify call was async: only act if both sides are still the rows
    // the model judged.
    const currentTarget = getFactDetails(targetId);
    const currentFresh = getFactDetails(factId);
    if (!currentTarget || currentTarget.status !== 'active' || currentTarget.text !== target.text) continue;
    if (!currentFresh || currentFresh.text !== fresh.text) return true;
    recordRelationResult(factId, targetId, verdict, 'sweep');
    if (verdict === 'compatible') continue;
    // Re-read the fresh fact's status at act time: a conflict raised earlier in
    // this very loop flips it to 'conflicted', and a disputed fact must not
    // retire neighbours on its own say-so.
    const mayAutoSupersede =
      verdict === 'b_supersedes_a' && opts.directUser && currentFresh.status === 'active'
      && currentTarget.source !== 'explicit' && !currentTarget.pinned;
    if (mayAutoSupersede) {
      supersedeFact(targetId, factId);
    } else {
      createFactConflict(targetId, factId, SWEEP_CONFLICT_REASON);
    }
  }
  return true;
}

/**
 * Classify queued pairs (sweep overflow, co-injection discoveries, backfill).
 * Deliberately conflict-only: rows here have no directUser authority attached,
 * so a supersede-direction verdict still just raises a conflict and lets the
 * adjudicator — which runs right after this pass in the distill chain — apply
 * its own, capped authority.
 */
export async function processPendingRelationChecks(
  llm: LlmClient,
  limit = 25
): Promise<{ checked: number; conflicts: number }> {
  let checked = 0;
  let conflicts = 0;
  const factsGeneration = getFactsGeneration();
  for (const pending of getPendingRelationChecks(limit)) {
    const verdict = await classifyRelation(
      { text: pending.factA.text, evidenceDate: evidenceDateOf(pending.factA) },
      { text: pending.factB.text, evidenceDate: evidenceDateOf(pending.factB) },
      llm
    );
    if (getFactsGeneration() !== factsGeneration) break;
    const a = getFactDetails(pending.factA.id);
    const b = getFactDetails(pending.factB.id);
    // 'stale' is terminal — reserve it for sides that are gone, superseded, or
    // reworded. A side that merely entered another conflict while we were
    // classifying stays pending: it returns to 'active' when that conflict
    // settles, and killing the pair here would leave it unjudged forever.
    const gone = (f: typeof a, snap: { text: string }): boolean =>
      !f || f.status === 'superseded' || f.text !== snap.text;
    if (gone(a, pending.factA) || gone(b, pending.factB)) {
      recordRelationVerdict(pending.id, 'stale');
      continue;
    }
    if (a!.status !== 'active' || b!.status !== 'active') continue;
    recordRelationVerdict(pending.id, verdict);
    checked += 1;
    if (verdict !== 'compatible') {
      createFactConflict(pending.factA.id, pending.factB.id, SWEEP_CONFLICT_REASON);
      conflicts += 1;
    }
  }
  return { checked, conflicts };
}

// ---------------------------------------------------------------------------
// Retroactive backfill: enumerate neighbour pairs for facts that predate the
// sweep. Enumeration is vectors-only (no model calls); the pairs land in the
// same pending queue processPendingRelationChecks drains over idle time.

const BACKFILL_CURSOR_KEY = 'relation_sweep_cursor';
const BACKFILL_DONE_KEY = 'relation_sweep_done';

export function relationSweepBackfillDone(): boolean {
  return getMeta(BACKFILL_DONE_KEY) === '1';
}

/**
 * Advance the backfill by one batch of active facts: embed any missing vectors
 * for the batch, enqueue each fact's ≥SWEEP_MIN_COSINE neighbours, move the
 * cursor. Returns how many pairs were queued and whether the whole store has
 * been covered. A missing/unready embeddings client leaves the cursor alone —
 * the pass just retries on a later tick.
 */
export async function stepRelationSweepBackfill(batchSize = 25): Promise<{ done: boolean; enqueued: number }> {
  if (relationSweepBackfillDone()) return { done: true, enqueued: 0 };
  const factsGeneration = getFactsGeneration();
  const emb = getEmbeddingsClient();
  if (!emb || !(await emb.available())) return { done: false, enqueued: 0 };
  const model = (await emb.modelId()) ?? '';
  if (!model || getFactsGeneration() !== factsGeneration) return { done: false, enqueued: 0 };

  const cursor = Number.parseInt(getMeta(BACKFILL_CURSOR_KEY) ?? '0', 10) || 0;
  const active = getAllFacts().filter((f) => f.status === 'active');
  const batch = active.filter((f) => f.id > cursor).sort((a, b) => a.id - b.id).slice(0, batchSize);
  if (batch.length === 0) {
    setMeta(BACKFILL_DONE_KEY, '1');
    return { done: true, enqueued: 0 };
  }

  // Same embed-then-snapshot-write pattern as consolidate's chunkFacts: the
  // batch's facts must have vectors or their neighbourhoods are invisible.
  const batchIds = new Set(batch.map((f) => f.id));
  const missing = getFactsMissingVector(model).filter((f) => batchIds.has(f.id));
  if (missing.length > 0) {
    const vecs = await emb.embed(missing.map((f) => f.text), 'passage');
    if (getFactsGeneration() !== factsGeneration) return { done: false, enqueued: 0 };
    missing.forEach((f, i) => upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, model, vecs[i]));
  }

  const vectors = getFactVectors(model);
  const activeIds = new Set(active.map((f) => f.id));
  const pairs: Array<[number, number]> = [];
  for (const fact of batch) {
    for (const id of neighbourIdsOf(fact.id, vectors, activeIds)) pairs.push([fact.id, id]);
  }
  const enqueued = enqueueRelationChecks(pairs, 'backfill');
  setMeta(BACKFILL_CURSOR_KEY, String(batch[batch.length - 1].id));
  return { done: false, enqueued };
}
