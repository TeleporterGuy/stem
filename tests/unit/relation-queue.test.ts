// The background classify pass over fact_relation_checks: what it refuses to
// spend a model call on, and what its counters mean. Stateful, order-dependent
// (shared per-process DB) like the sibling suites.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import {
  RELATION_PROMPT_HEADER,
  processPendingRelationChecks,
  type FactRelation
} from '../../src/server/recall/reconcile';
import type { LlmClient } from '../../src/server/recall/llm';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
});

const MODEL = 'fake-model';

/** A counting LLM that answers every relation prompt with a fixed verdict. */
function verdictLlm(verdict: FactRelation, onCall?: () => void): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    complete: async (prompt: string) => {
      if (!prompt.includes(RELATION_PROMPT_HEADER)) throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
      llm.calls += 1;
      onCall?.();
      return JSON.stringify({ verdict });
    }
  };
  return llm;
}

/** Seed a fact with a vector and one dated evidence row. */
function seedFact(text: string, vec: number[]): number {
  const id = store.upsertFact(text, {
    source: 'distilled',
    evidence: [{
      messageId: null, threadId: null, role: null,
      timestamp: Math.floor(Date.now() / 1000) - 86_400,
      excerpt: `evidence: ${text}`, origin: 'folder_doc', folderId: 'f', relPath: 'x.pdf'
    }]
  })!;
  store.upsertFactVector(id, MODEL, Float32Array.from(vec));
  return id;
}

const relationRows = () =>
  store.dbHandle().prepare('SELECT fact_a AS a, fact_b AS b, verdict, origin FROM fact_relation_checks ORDER BY id').all() as
    Array<{ a: number; b: number; verdict: string | null; origin: string }>;

describe('processPendingRelationChecks does not re-litigate a settled pair', () => {
  it('settles a pending row as stale when the pair already went through the conflict machinery', async () => {
    const a = seedFact('The fee is 129 euro per month.', [1, 0, 0]);
    const b = seedFact('The fee is 134 euro per month.', [0.99, 0.1, 0]);
    // An over-budget sweep queues the pair; a later pass raises the conflict on
    // it anyway, and the user keeps both. Both sides return to 'active' and the
    // conflict row goes 'resolved' — leaving the NULL row eligible again.
    store.enqueueRelationChecks([[a, b]], 'sweep');
    const conflictId = store.createFactConflict(a, b, 'raised by a later pass')!;
    store.resolveMemoryConflict(conflictId, 'keep_both');
    expect(store.getFactDetails(a)?.status).toBe('active');
    expect(store.getFactDetails(b)?.status).toBe('active');

    const llm = verdictLlm('contradicts');
    // Before the fix this classified the pair and called createFactConflict
    // again — idx_fact_conflict_pair is partial on status='open', so a second
    // open conflict was inserted and the user's decision came back.
    expect(await processPendingRelationChecks(llm)).toEqual({ checked: 0, conflicts: 0 });
    expect(llm.calls).toBe(0);
    expect(store.getMemoryConflicts()).toHaveLength(0);
    expect(relationRows()[0].verdict).toBe('stale');
  });
});

describe('processPendingRelationChecks spends calls only on rows it can still use', () => {
  it('does not classify a later pair that a conflict raised earlier in the same batch invalidated', async () => {
    const a = seedFact('The fee is 129 euro per month.', [1, 0, 0]);
    const b = seedFact('The fee is 134 euro per month.', [0.99, 0.1, 0]);
    const c = seedFact('The fee rose to 141 euro per month.', [0.98, 0.2, 0]);
    // Both pairs are hydrated while every side is still active; judging (a, b)
    // flips a and b to 'conflicted' and invalidates (a, c) mid-batch.
    store.enqueueRelationChecks([[a, b], [a, c]], 'sweep');
    const llm = verdictLlm('contradicts');
    expect(await processPendingRelationChecks(llm)).toEqual({ checked: 1, conflicts: 1 });
    // Before the fix the second pair was classified first and re-checked after,
    // so the call was made and then thrown away.
    expect(llm.calls).toBe(1);
    const [first, second] = relationRows();
    expect(first).toMatchObject({ a, b, verdict: 'contradicts' });
    // The invalidated pair stays pending — 'conflicted' is temporary, and the
    // pair is judged once that conflict settles.
    expect(second).toMatchObject({ a, b: c, verdict: null });
  });

  it('counts a call spent on a row that went invalid mid-call, so the activity row is honest', async () => {
    const a = seedFact('The user has a UZ Gent appointment on 17 July.', [1, 0, 0]);
    const b = seedFact('A Slovak interpreter was secured for the appointment.', [0.99, 0.1, 0]);
    const other = seedFact('The user lives in Bratislava.', [0, 1, 0]);
    store.enqueueRelationChecks([[a, b]], 'coinject');
    // Something else disputes a while this pair's classify call is in flight.
    const llm = verdictLlm('contradicts', () => {
      store.createFactConflict(a, other, 'a concurrent dispute');
    });
    // The verdict is discarded (a is no longer active), but the call was paid
    // for: before the fix this reported "Checked 0 pairs" after a real call.
    expect(await processPendingRelationChecks(llm)).toEqual({ checked: 1, conflicts: 0 });
    expect(llm.calls).toBe(1);
    expect(relationRows()[0].verdict).toBeNull();
  });
});
