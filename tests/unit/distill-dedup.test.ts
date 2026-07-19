// Write-time semantic dedup of distilled facts (never silent-drop): a
// near-duplicate candidate is still inserted, but fast-tracks the consolidation
// pass by forcing consolidate_pending past the tidy threshold. Fake embedders;
// threshold calibration itself lives in scripts/recall-eval.mjs (duplicatePairs).
// Stateful, order-dependent (shared per-process DB) like the sibling suites.
import { afterAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/main/recall/store';
import * as distill from '../../src/main/recall/distill';
import * as retrieval from '../../src/main/recall/retrieval';

afterAll(() => store.close());

const MODEL = 'fake-model';
let seq = 0;

/** Advance the corpus so the next distill run has fresh input. */
function newMessage(text: string): void {
  seq += 1;
  store.recordMessage({ threadId: 'D', turnId: `d${seq}`, role: 'user', text: `${text} (turn ${seq})` });
}

function llmReturning(facts: string[]) {
  return { complete: async () => JSON.stringify(facts) };
}

/** Fake embedder: /rex/i texts map to [1,0], everything else to a unique-ish [0,1]. */
function keyedEmbeddings(kinds?: Array<string | undefined>) {
  return {
    available: async () => true,
    modelId: async () => MODEL,
    embed: async (texts: string[], kind?: 'query' | 'passage') => {
      kinds?.push(kind);
      return texts.map((t) => Float32Array.from(/rex/i.test(t) ? [1, 0] : [0, 1]));
    }
  };
}

function pending(): number {
  return Number.parseInt(store.getMeta(distill.PENDING_KEY) ?? '0', 10) || 0;
}

describe('upsertFact return id', () => {
  it('returns the row id on insert and the SAME id on a norm-conflict update; null on empty', () => {
    store.resetFacts();
    const id = store.upsertFact('The user has a parrot named Koko', 'distilled');
    expect(typeof id).toBe('number');
    expect(store.upsertFact('the user has a parrot named koko.', 'explicit')).toBe(id);
    expect(store.upsertFact('   ')).toBeNull();
  });
});

describe('knownFactsBlock dedup hint', () => {
  it('surfaces an old transcript-related fact that recency alone would drop past the cap', () => {
    store.resetFacts();
    const oldId = store.upsertFact('The user keeps a telescope named Kepler on the balcony', 'distilled')!;
    // Age the fact, then bury it under a full cap of newer facts.
    store.dbHandle().prepare('UPDATE facts SET updated_at = updated_at - 86400 WHERE id = ?').run(oldId);
    for (let i = 0; i < distill.KNOWN_FACTS_CAP; i++) {
      store.upsertFact(`The user filler fact number ${i} about topic ${i}`, 'distilled');
    }
    // Recency-only view: the old fact fell out of the window.
    expect(distill.knownFactsBlock()).not.toContain('Kepler');
    // With the transcript as context, the lexical probe pulls it back in — this
    // is exactly the fact a re-extraction would otherwise restate as a dupe.
    const block = distill.knownFactsBlock('we talked about the telescope kepler and stargazing on the balcony');
    expect(block).toContain('Kepler');
    expect(block).toContain('do not restate');
    // The cap still holds.
    expect((block.match(/- \[fact:/g) ?? []).length).toBeLessThanOrEqual(distill.KNOWN_FACTS_CAP);
  });
});

describe('distill write-time dedup', () => {
  it('low-sim candidates: count-only pending bump, vectors cached, embedded as passages', async () => {
    store.resetFacts();
    store.setMeta(distill.PENDING_KEY, '0');
    const kinds: Array<string | undefined> = [];
    retrieval.setRetrievalClients({ embeddings: keyedEmbeddings(kinds), rerank: null });
    try {
      newMessage('background chatter that produces two novel facts');
      const wrote = await distill.distillNewMessages(
        llmReturning(['The user has a dog named Rex', 'The user paints watercolors'])
      );
      expect(wrote).toBe(2);
      expect(pending()).toBe(2); // no dup → plain count bump
      expect(kinds).toEqual(['passage']); // symmetric fact↔fact comparison, one batch call
      expect(store.getFactsMissingVector(MODEL)).toEqual([]); // bonus cache kicked in
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });

  it('a near-duplicate of an EXISTING fact is still inserted but fast-tracks consolidation', async () => {
    store.setMeta(distill.PENDING_KEY, '0');
    retrieval.setRetrievalClients({ embeddings: keyedEmbeddings(), rerank: null });
    try {
      newMessage('the user mentions their dog rex again in new words');
      // Maps to [1,0], as does the cached "dog named Rex" vector → cosine 1 ≥ threshold.
      const wrote = await distill.distillNewMessages(llmReturning(['The user owns a dog called Rex']));
      expect(wrote).toBe(1);
      expect(store.getAllFacts().some((f) => /dog called Rex/.test(f.text))).toBe(true); // inserted, not dropped
      expect(pending()).toBe(store.getTidyThreshold()); // max(0+1, threshold) → consolidation next tick
      expect(distill.shouldConsolidate()).toBe(true);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });

  it('detects two rewordings of the same fact within a single batch', async () => {
    store.resetFacts();
    store.setMeta(distill.PENDING_KEY, '0');
    retrieval.setRetrievalClients({ embeddings: keyedEmbeddings(), rerank: null });
    try {
      newMessage('one turn where the model emits the same fact twice');
      const wrote = await distill.distillNewMessages(
        llmReturning(['The user has a dog named Rex', 'The user keeps a dog, Rex'])
      );
      expect(wrote).toBe(2);
      expect(pending()).toBe(Math.max(2, store.getTidyThreshold())); // intra-batch dup seen
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });

  it('with embeddings unavailable, behavior is exactly the pre-dedup path', async () => {
    store.resetFacts();
    store.setMeta(distill.PENDING_KEY, '0');
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    newMessage('a turn distilled with no embedding model configured');
    const wrote = await distill.distillNewMessages(llmReturning(['The user has a dog named Rex']));
    expect(wrote).toBe(1);
    expect(pending()).toBe(1); // count-only; no fast-track possible
    expect(store.getFactsMissingVector(MODEL).length).toBe(1); // nothing cached either
  });

  it('a throwing embedder degrades the same way (facts written, no fast-track)', async () => {
    store.resetFacts();
    store.setMeta(distill.PENDING_KEY, '0');
    retrieval.setRetrievalClients({
      embeddings: {
        available: async () => true,
        modelId: async () => MODEL,
        embed: async () => {
          throw new Error('worker died');
        }
      },
      rerank: null
    });
    try {
      newMessage('a turn distilled while the embedder is broken');
      expect(await distill.distillNewMessages(llmReturning(['The user has a canary']))).toBe(1);
      expect(pending()).toBe(1);
      expect(store.getAllFacts().some((f) => /canary/.test(f.text))).toBe(true);
    } finally {
      retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    }
  });
});
