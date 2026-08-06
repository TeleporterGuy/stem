// The gates and queues around durable facts: the capture/adjudication write
// transactions, the revive-from-expiry flip, the adjudicable-conflict gate that
// drives the relation-check producer, the pending-pair queue's fairness, and the
// lexical tier's two bm25 bars. Stateful, order-dependent (shared per-process DB)
// like the sibling suites.
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ADJUDICATE_ATTEMPTS } from '../../src/server/recall/adjudicate';
import { recallStore as store } from '../../src/server/recall/store';
import * as search from '../../src/server/recall/search';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
  store.resetEpisodic();
});

/** Record the raw SQL every `exec` on the live handle sees while `fn` runs. */
function execTrace(fn: () => void): string[] {
  const handle = store.dbHandle() as unknown as { exec: (sql: string) => void };
  const original = handle.exec.bind(handle);
  const seen: string[] = [];
  handle.exec = (sql: string): void => {
    seen.push(sql);
    original(sql);
  };
  try {
    fn();
  } finally {
    Reflect.deleteProperty(handle, 'exec');
  }
  return seen;
}

function seedConflict(textA: string, textB: string, over: { sourceA?: string; sourceB?: string } = {}) {
  const a = store.upsertFact(textA, over.sourceA ?? 'distilled')!;
  const b = store.upsertFact(textB, over.sourceB ?? 'distilled')!;
  const conflictId = store.createFactConflict(a, b, 'test conflict')!;
  return { a, b, conflictId };
}

describe('write transactions (BUG-004)', () => {
  it('recordMessage takes the write lock up front', () => {
    const trace = execTrace(() => {
      store.recordMessage({ threadId: 't1', turnId: 'u1', role: 'assistant', text: 'Partial reply' });
      store.recordMessage({ threadId: 't1', turnId: 'u1', role: 'assistant', text: 'Partial reply, now complete.' });
    });
    // A deferred BEGIN around this read-then-write can fail with
    // SQLITE_BUSY_SNAPSHOT, which does NOT consult the busy handler — and capture
    // swallows the throw, losing the turn's reply.
    expect(trace.filter((sql) => sql.startsWith('BEGIN'))).toEqual(['BEGIN IMMEDIATE', 'BEGIN IMMEDIATE']);
    // The supersede half still works: the longer reply replaced the shorter one.
    const texts = store.getThreadMessagesAfter('t1', 0).map((m) => m.text);
    expect(texts).toEqual(['Partial reply, now complete.']);
  });

  it('applyAdjudication takes the write lock up front', () => {
    const { a, b, conflictId } = seedConflict('The fee is 129 euro.', 'The fee is 134 euro.');
    const factA = store.getFactDetails(a)!;
    const factB = store.getFactDetails(b)!;
    const trace = execTrace(() => {
      const applied = store.applyAdjudication(
        conflictId,
        { kind: 'winner', winnerId: b },
        { aId: a, aText: factA.text, bId: b, bText: factB.text }
      );
      expect(applied).toBe(true);
    });
    expect(trace.filter((sql) => sql.startsWith('BEGIN'))).toEqual(['BEGIN IMMEDIATE']);
  });

  it('a deferred read-then-write really does fail unhandled when another writer commits', () => {
    // The mechanism the two fixes above avoid, on this SQLite build: in WAL, a
    // read snapshot that another connection has outrun cannot be upgraded, and
    // SQLite returns immediately instead of waiting on busy_timeout.
    const handle = store.dbHandle();
    const other = new DatabaseSync(process.env.STEM_RECALL_DB!);
    let upgradeFailed = false;
    try {
      handle.exec('BEGIN'); // deferred, as the pre-fix code did
      handle.prepare(`SELECT COUNT(*) AS n FROM messages`).get(); // opens the read snapshot
      other.prepare(`INSERT INTO meta(key, value) VALUES('probe', '1')
                     ON CONFLICT(key) DO UPDATE SET value = value || '1'`).run();
      try {
        handle.prepare(`INSERT INTO meta(key, value) VALUES('probe2', '1')
                        ON CONFLICT(key) DO UPDATE SET value = value || '1'`).run();
      } catch {
        upgradeFailed = true;
      }
    } finally {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // already rolled back by the failed upgrade
      }
      other.close();
    }
    expect(upgradeFailed).toBe(true);
  });
});

describe('reviving an expired fact (BUG-006)', () => {
  it('clears the stale expiry so the next sweep cannot re-supersede it', () => {
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const id = store.upsertFact('The user flies to Vienna on 12 July.', { source: 'distilled', validUntil: past })!;
    expect(store.expireFacts()).toBe(1);

    expect(store.upsertFact('The user flies to Vienna on 12 July.', { source: 'explicit' })).toBe(id);
    expect(store.getFactDetails(id)?.status).toBe('active');
    // The revival is worthless if the past expiry survives it: the getter-side
    // sweep retires the fact again within the minute.
    expect(store.getFactDetails(id)?.validUntil).toBeNull();
    store.getFacts();
    expect(store.expireFacts()).toBe(0);
    expect(store.getFactDetails(id)?.status).toBe('active');
    expect(store.getInjectableFacts().map((f) => f.id)).toContain(id);
  });

  it('a revival that carries its own new expiry keeps it', () => {
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const id = store.upsertFact('The user rents a car until Friday.', { source: 'distilled', validUntil: past })!;
    expect(store.expireFacts()).toBe(1);
    store.upsertFact('The user rents a car until Friday.', { source: 'explicit', validUntil: future });
    expect(store.getFactDetails(id)?.validUntil).toBe(future);
    expect(store.getFactDetails(id)?.status).toBe('active');
  });

  it('an unauthorized restatement still leaves the fact retired and expired', () => {
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const id = store.upsertFact('The user is on call this week.', { source: 'distilled', validUntil: past })!;
    expect(store.expireFacts()).toBe(1);
    store.upsertFact('The user is on call this week.', 'distilled');
    expect(store.getFactDetails(id)?.status).toBe('superseded');
    expect(store.getFactDetails(id)?.validUntil).toBe(past);
  });
});

describe('the adjudicable-conflict gate (BUG-007)', () => {
  it('does not count conflicts the adjudicator can never resolve', () => {
    for (let i = 0; i < 12; i++) {
      // An explicit side is filtered out by design — only the user settles these.
      seedConflict(`The invoice ${i} totals 100 euro.`, `The invoice ${i} totals 120 euro.`, { sourceB: 'explicit' });
    }
    for (let i = 0; i < 9; i++) {
      const { conflictId } = seedConflict(`The meeting ${i} is at 09:00.`, `The meeting ${i} is at 10:00.`);
      for (let n = 0; n < MAX_ADJUDICATE_ATTEMPTS; n++) store.bumpAdjudicationAttempts(conflictId);
    }
    // 21 open conflicts, none of them adjudicable: the old gate input switched the
    // relation-check producer off permanently.
    expect(store.countOpenConflicts()).toBe(21);
    expect(store.countAdjudicableConflicts(MAX_ADJUDICATE_ATTEMPTS)).toBe(0);

    seedConflict('The user drives a Skoda.', 'The user drives a Kia.');
    expect(store.countAdjudicableConflicts(MAX_ADJUDICATE_ATTEMPTS)).toBe(1);
  });

  it('the count and the adjudicator selection share one predicate', () => {
    seedConflict('The user lives in Kosice.', 'The user lives in Bratislava.');
    seedConflict('The dog is a beagle.', 'The dog is a collie.', { sourceA: 'explicit' });
    const { conflictId } = seedConflict('The rent is 700 euro.', 'The rent is 750 euro.');
    for (let n = 0; n < MAX_ADJUDICATE_ATTEMPTS; n++) store.bumpAdjudicationAttempts(conflictId);
    const selected = store.getConflictsForAdjudication(100, MAX_ADJUDICATE_ATTEMPTS);
    expect(store.countAdjudicableConflicts(MAX_ADJUDICATE_ATTEMPTS)).toBe(selected.length);
    expect(store.countOpenConflicts()).toBeGreaterThan(selected.length);
  });

  it('a batch of unresolvable conflicts no longer crowds out the adjudicable ones', () => {
    // Oldest first, so the ineligible rows are at the head of the ordering. When
    // the LIMIT was applied before the eligibility filter, a pass hydrated these
    // and then discarded them, doing no work at all.
    for (let i = 0; i < 5; i++) {
      seedConflict(`The fee ${i} is 10 euro.`, `The fee ${i} is 20 euro.`, { sourceA: 'explicit' });
    }
    for (let i = 0; i < 3; i++) seedConflict(`The bus ${i} leaves at 07:00.`, `The bus ${i} leaves at 08:00.`);
    expect(store.getConflictsForAdjudication(3, MAX_ADJUDICATE_ATTEMPTS)).toHaveLength(3);
  });
});

describe('the pending relation-check queue (BUG-009)', () => {
  /** A fact parked in 'conflicted' by an unrelated conflict — a blocked pair's side. */
  const blockedSide = (): number => {
    const { a } = seedConflict('The user owns a boat.', 'The user owns no boat.', { sourceA: 'explicit' });
    return a;
  };

  it('has an index behind the queue read', () => {
    const idx = store.dbHandle().prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_fact_relation_pending'`
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_fact_relation_pending');
  });

  it('blocked pairs no longer camp at the head of the queue', () => {
    const blocked = blockedSide();
    const stuck: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      stuck.push([store.upsertFact(`The user reads book ${i}.`, 'distilled')!, blocked]);
    }
    expect(store.enqueueRelationChecks(stuck, 'sweep')).toBe(5);
    const readyA = store.upsertFact('The user brews filter coffee.', 'distilled')!;
    const readyB = store.upsertFact('The user grinds beans by hand.', 'distilled')!;
    expect(store.enqueueRelationChecks([[readyA, readyB]], 'sweep')).toBe(1);

    // The five oldest pairs are all blocked by a conflict only the user can
    // settle. They used to fill the whole limit * 4 window, so this pass — and
    // every pass after it — returned nothing at all.
    const pass = store.getPendingRelationChecks(1);
    expect(pass.map((p) => [p.factA.id, p.factB.id])).toEqual([[readyA, readyB]]);
    // Excluded, not settled: the blocked pairs keep their NULL verdict.
    const rows = store.dbHandle().prepare(
      `SELECT verdict FROM fact_relation_checks WHERE fact_a = ? OR fact_b = ?`
    ).all(blocked, blocked) as Array<{ verdict: string | null }>;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.verdict === null)).toBe(true);
  });

  it('a blocked pair comes back the moment its conflict settles', () => {
    const blocked = blockedSide();
    const other = store.upsertFact('The user sails on weekends.', 'distilled')!;
    store.enqueueRelationChecks([[other, blocked]], 'sweep');
    expect(store.getPendingRelationChecks(5)).toHaveLength(0);

    store.resolveMemoryConflict(store.getMemoryConflicts()[0].id, 'keep_both');
    expect(store.getFactDetails(blocked)?.status).toBe('active');
    expect(store.getPendingRelationChecks(5)).toHaveLength(1);
  });

  it('still settles a pair whose side is gone for good', () => {
    const a = store.upsertFact('The user uses Arc Browser.', 'distilled')!;
    const b = store.upsertFact('The user uses Safari.', 'distilled')!;
    store.enqueueRelationChecks([[a, b]], 'sweep');
    store.supersedeFact(b, a);
    expect(store.getPendingRelationChecks(5)).toHaveLength(0);
    const row = store.dbHandle().prepare(
      `SELECT verdict FROM fact_relation_checks WHERE fact_a = ? AND fact_b = ?`
    ).get(Math.min(a, b), Math.max(a, b)) as { verdict: string | null };
    expect(row.verdict).toBe('stale');
  });
});

describe('the lexical tier bm25 bars (BUG-003, BUG-016)', () => {
  const SENSITIVE = 'The user takes insulin for diabetes management';

  it('lets both bars stand down together below the corpus threshold', () => {
    store.upsertFact(SENSITIVE, { category: 'health', sensitivity: 'sensitive', confidence: 0.9 });
    store.upsertFact('The user manages the offsite budget spreadsheet', { confidence: 0.9 });
    expect(store.countFacts()).toBeLessThan(search.FACT_LEXICAL_GATE_MIN_FACTS);

    // An ACCEPTED trade-off, not an oversight — pinned so it is a deliberate
    // decision to revisit rather than a silent regression. Below the threshold
    // bm25 carries no relevance signal (see the measurement in the next test), so
    // the sensitivity bar cannot tell this incidental 'management' overlap from a
    // question genuinely about the user's health. Standing the bar up here would
    // block BOTH, making sensitive facts unreachable by keyword in a small store;
    // standing it down admits both. We keep them reachable and rely on the
    // semantic tier's scale-free 0.82 cosine gate for the real protection.
    const ranked = search.rankFactsLexically('any management tips for my team offsite?', 3);
    expect(ranked.map((f) => f.text)).toContain(SENSITIVE);
    expect(ranked.map((f) => f.text)).toContain('The user manages the offsite budget spreadsheet');
  });

  it('cannot separate a direct match from an incidental one by bm25 in a small store', () => {
    // The measurement behind the always-on sensitivity bar, pinned so nobody
    // re-attempts a threshold-shaped fix. In a small store bm25 ranks the two
    // cases the WRONG way round, so no bar — absolute, corpus-scaled, or relative
    // to the query's own pool — can admit the direct match and reject the
    // incidental one. Both are single-term, single-hit matches; only IDF could
    // tell them apart, and IDF is what collapses here.
    const direct = store.upsertFact('The user has diabetes', { sensitivity: 'sensitive', confidence: 0.9 })!;
    store.upsertFact('The user owns a hidden sailboat', { confidence: 0.55 });
    const [directHit] = store.factTermSearch(search.buildMatchQuery('what should I know about my diabetes?')!, 4);
    expect(directHit.id).toBe(direct);

    store.resetFacts();
    const incidental = store.upsertFact(SENSITIVE, { sensitivity: 'sensitive', confidence: 0.9 })!;
    store.upsertFact('The user has diabetes', { sensitivity: 'sensitive', confidence: 0.9 });
    store.upsertFact('The user owns a hidden sailboat', { confidence: 0.55 });
    const [leakHit] = store.factTermSearch(search.buildMatchQuery('any management tips for my team offsite?')!, 4);
    expect(leakHit.id).toBe(incidental);

    // Scores are negative, more-negative = stronger. The match we WANT is the
    // weaker of the two: the direct hit sits on SQLite's clamped-IDF floor while
    // the incidental one is five orders of magnitude stronger.
    expect(directHit.score).toBeCloseTo(-0.000001, 6);
    expect(leakHit.score).toBeLessThan(directHit.score);
  });

  it('sizes the noise ceiling against every fact row, not just the active ones', () => {
    // A retired fact keeps its facts_fts row, so it still feeds bm25's IDF and
    // avgdl. Counting only active facts leaves the ceiling standing down forever
    // on a store that has consolidated away most of its history.
    for (let i = 0; i < 40; i++) {
      const id = store.upsertFact(`Retired note ${i} about the os release train`, 'distilled')!;
      store.supersedeFact(id);
    }
    store.upsertFact('The current note about the os release train', 'distilled');
    expect(store.countFacts()).toBeGreaterThanOrEqual(search.FACT_LEXICAL_GATE_MIN_FACTS);

    // 'os' is in every indexed row, so its IDF — and the hit's bm25 — collapses to
    // noise. Two characters, so the trigram fill (≥3) can't put it back either.
    const ranked = search.rankFactsLexically('os', 3);
    expect(ranked).toHaveLength(0);
  });
});
