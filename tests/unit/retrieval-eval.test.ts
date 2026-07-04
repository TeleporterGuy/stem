// Fast tier of the retrieval eval harness: exercises the golden fixture against
// the REAL store/search/inject modules with the FTS (lexical) tier only — no
// model, runs in `npm test`. The scored real-inference tiers live in
// scripts/recall-eval.mjs. This spec pins two things by construction:
//  - direct same-language queries are reachable by FTS (regression anchor), and
//  - lexOverlap:false queries are NOT (the gap semantic retrieval must close).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as store from '../../src/main/recall/store';
import * as search from '../../src/main/recall/search';
import * as inject from '../../src/main/recall/inject';
import * as retrieval from '../../src/main/recall/retrieval';
import { aggregate, checkFloors, loadFixture, mrr, recallAtK, scoreRanking } from '../eval/score.mjs';
import { seedCorpus } from '../eval/seed.mjs';

const fixture = loadFixture(
  JSON.parse(readFileSync(new URL('../fixtures/recall-golden.json', import.meta.url), 'utf8'))
);

let lookup: ReturnType<typeof seedCorpus>;

beforeAll(() => {
  lookup = seedCorpus(store, fixture);
});
afterAll(() => store.closeForTest());

/** FTS-tier ranking for one episodic query, as fixture ids (rank order preserved). */
function ftsRanking(queryText: string): string[] {
  return search
    .searchMemory(queryText, { limit: 5 })
    .map((h) => lookup.messageFixtureId(h) ?? `unknown:${h.id}`);
}

const episodic = fixture.queries.filter((q: { target: string }) => q.target === 'episodic');

describe('retrieval eval — scorer math', () => {
  it('recallAtK counts any expected id in the top k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['c'], 3)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], ['c'], 2)).toBe(0);
    expect(recallAtK([], ['c'], 5)).toBe(0);
    expect(recallAtK(['a', 'b'], ['b', 'z'], 2)).toBe(1); // any-of semantics
  });

  it('mrr is the reciprocal rank of the first expected hit', () => {
    expect(mrr(['a', 'b', 'c'], ['a'])).toBe(1);
    expect(mrr(['a', 'b', 'c'], ['c'])).toBeCloseTo(1 / 3);
    expect(mrr(['a', 'b'], ['z'])).toBe(0);
  });

  it('aggregate means per tier and per (tier, langPair)', () => {
    const rows = [
      { tier: 'fts', langPair: 'en->en', metrics: scoreRanking(['x'], ['x']) },
      { tier: 'fts', langPair: 'sk->en', metrics: scoreRanking(['y'], ['x']) }
    ];
    const agg = aggregate(rows);
    expect(agg.byTier.fts['recall@5']).toBeCloseTo(0.5);
    expect(agg.byTier.fts.n).toBe(2);
    expect(agg.byTierLangPair.fts['en->en']['recall@5']).toBe(1);
    expect(agg.byTierLangPair.fts['sk->en']['recall@5']).toBe(0);
  });

  it('checkFloors reports violations and skips absent tiers', () => {
    const agg = aggregate([{ tier: 'fts', langPair: 'en->en', metrics: scoreRanking(['y'], ['x']) }]);
    const violations = checkFloors(agg, {
      fts: { 'recall@5': 0.5 },
      hybrid: { 'recall@5': 0.9 }, // tier not run → skipped, not violated
      byLangPair: { 'en->en': { fts: { mrr: 0.5 } } }
    });
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.tier === 'hybrid')).toBe(false);
    expect(violations.some((v) => v.langPair === 'en->en')).toBe(true);
  });

  it('loadFixture rejects an expected id that is not in the corpus', () => {
    const broken = JSON.parse(JSON.stringify(fixture));
    broken.queries[0].expected = ['m-no-such-message'];
    expect(() => loadFixture(broken)).toThrow(/not in corpus/);
  });
});

describe('retrieval eval — FTS tier over the golden corpus', () => {
  it('every direct query is reachable by FTS (recall@5 = 1)', () => {
    for (const q of episodic.filter((q: { modes: string[] }) => q.modes.includes('direct'))) {
      const r = recallAtK(ftsRanking(q.text), q.expected, 5);
      expect(r, `direct query ${q.id} ("${q.text}") missed via FTS`).toBe(1);
    }
  });

  it('every lexOverlap:false query is unreachable by FTS (recall@5 = 0) — the semantic gap', () => {
    for (const q of episodic.filter((q: { lexOverlap: boolean }) => !q.lexOverlap)) {
      const r = recallAtK(ftsRanking(q.text), q.expected, 5);
      expect(r, `query ${q.id} ("${q.text}") unexpectedly reachable by FTS — fix lexOverlap or the corpus`).toBe(0);
    }
  });

  it('FTS aggregate clears the fixture floors', () => {
    const rows = episodic.map((q: { text: string; expected: string[]; langPair: string }) => ({
      tier: 'fts',
      langPair: q.langPair,
      metrics: scoreRanking(ftsRanking(q.text), q.expected)
    }));
    const violations = checkFloors(aggregate(rows), fixture.floors);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

describe('retrieval eval — facts lexical sanity', () => {
  it('a direct facts query surfaces its fact through the lexical tier', async () => {
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    const prevThreshold = store.getFactThreshold();
    store.setFactThreshold(1); // force ranking (22 corpus facts ≤ default 40 would inject all)
    try {
      const r = await inject.previewFacts('what am I allergic to?');
      expect(r.tier).toBe('lexical');
      expect(r.facts.some((f) => /birch pollen/.test(f.text))).toBe(true);
    } finally {
      store.setFactThreshold(prevThreshold);
    }
  });
});
