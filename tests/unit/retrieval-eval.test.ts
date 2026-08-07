// Fast tier of the retrieval eval harness: exercises the golden fixture against
// the REAL store/search/inject modules with the FTS (lexical) tier only — no
// model, runs in `npm test`. The scored real-inference tiers live in
// scripts/recall-eval.mjs. This spec pins two things by construction:
//  - direct same-language queries are reachable by FTS (regression anchor), and
//  - lexOverlap:false queries are NOT (the gap semantic retrieval must close).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import * as search from '../../src/server/recall/search';
import * as inject from '../../src/server/recall/inject';
import * as retrieval from '../../src/server/recall/retrieval';
import { ftsSearchSummaries } from '../../src/server/recall/search-core';
import { aggregate, checkFloors, formatViolation, loadFixture, mrr, recallAtK, scoreRanking } from '../eval/score.mjs';
import { seedCorpus } from '../eval/seed.mjs';

const fixture = loadFixture(
  JSON.parse(readFileSync(new URL('../fixtures/recall-golden.json', import.meta.url), 'utf8'))
);

let lookup: ReturnType<typeof seedCorpus>;

beforeAll(() => {
  lookup = seedCorpus(store, fixture);
});
afterAll(() => store.close());

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

  it('checkFloors reports violations, and an absent tier is itself a violation', () => {
    const agg = aggregate([{ tier: 'fts', langPair: 'en->en', metrics: scoreRanking(['y'], ['x']) }]);
    const violations = checkFloors(agg, {
      fts: { 'recall@5': 0.5 },
      hybrid: { 'recall@5': 0.9 }, // tier not run → violated, never skipped
      byLangPair: { 'en->en': { fts: { mrr: 0.5 } } }
    });
    expect(violations).toHaveLength(3);
    expect(violations.some((v) => v.tier === 'hybrid' && v.missing)).toBe(true);
    expect(violations.some((v) => v.langPair === 'en->en')).toBe(true);
  });

  it('a floored tier that degraded to a sibling is reported as a degradation', () => {
    // chooseFacts swallows embedding failures and degrades to `lexical`, so a
    // dead embedder renames the tier rather than lowering its score.
    const agg = aggregate([{ tier: 'facts-lexical', langPair: 'en->en', metrics: scoreRanking(['x'], ['x']) }]);
    const violations = checkFloors(agg, { 'facts-embedding': { 'recall@5': 0.85 } });
    expect(violations).toHaveLength(1);
    expect(violations[0].ran).toEqual(['facts-lexical']);
    expect(formatViolation(violations[0])).toMatch(/DEGRADED to facts-lexical/);
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
    // Only the fts floor: this spec runs one tier, and checkFloors now counts an
    // unrun floored tier as a violation. The full floor set is the eval script's
    // job (scripts/recall-eval.mjs), which runs every tier.
    const violations = checkFloors(aggregate(rows), { fts: fixture.floors.fts });
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

describe('retrieval eval — summaries FTS tier (Recall v3)', () => {
  const summaryQueries = fixture.queries.filter((q: { target: string }) => q.target === 'summaries');

  function summariesFtsRanking(queryText: string): string[] {
    return ftsSearchSummaries(store.dbHandle(), queryText, { limit: 5 })
      .map((h) => lookup.summaryFixtureId(h) ?? `unknown:${h.id}`);
  }

  it('every direct summary query is reachable by FTS (recall@5 = 1)', () => {
    for (const q of summaryQueries.filter((q: { modes: string[] }) => q.modes.includes('direct'))) {
      const r = recallAtK(summariesFtsRanking(q.text), q.expected, 5);
      expect(r, `direct summary query ${q.id} ("${q.text}") missed via FTS`).toBe(1);
    }
  });

  it('every lexOverlap:false summary query is unreachable by FTS — the semantic (sk→en) gap', () => {
    for (const q of summaryQueries.filter((q: { lexOverlap: boolean }) => !q.lexOverlap)) {
      const r = recallAtK(summariesFtsRanking(q.text), q.expected, 5);
      expect(r, `summary query ${q.id} ("${q.text}") unexpectedly reachable by FTS — fix lexOverlap or the summary text`).toBe(0);
    }
  });

  it('summaries FTS aggregate clears its fixture floor', () => {
    const rows = summaryQueries.map((q: { text: string; expected: string[]; langPair: string }) => ({
      tier: 'summaries-fts',
      langPair: q.langPair,
      metrics: scoreRanking(summariesFtsRanking(q.text), q.expected)
    }));
    const violations = checkFloors(aggregate(rows), { 'summaries-fts': fixture.floors['summaries-fts'] });
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

describe('retrieval eval — facts lexical sanity', () => {
  it('a direct facts query surfaces its fact through the lexical tier', async () => {
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    const r = await inject.previewFacts('what am I allergic to?');
    expect(r.tier).toBe('lexical');
    expect(r.facts.some((f) => /birch pollen/.test(f.text))).toBe(true);
  });
});
