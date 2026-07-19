import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/main/recall/store';

beforeAll(() => {
  const path = process.env.STEM_RECALL_DB!;
  const db = new DatabaseSync(path);
  // Simulate a partially upgraded v1 database: one v2 column exists, the rest do
  // not. The production migration must be idempotent and preserve ids/vectors.
  db.exec(`
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      norm TEXT UNIQUE,
      source TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE fact_vectors (
      fact_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(fact_id, model)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT INTO facts(id, text, norm, source, category, updated_at) VALUES(7, ?, ?, 'distilled', 'location', 1234)`)
    .run('The user lives in Rome', 'the user lives in rome');
  const vector = Float32Array.from([0.25, 0.75]);
  db.prepare(`INSERT INTO fact_vectors(fact_id, model, dim, vec, updated_at) VALUES(7, 'v1-model', 2, ?, 1234)`)
    .run(Buffer.from(vector.buffer));
  db.close();
});

describe('Recall v3 additive migration', () => {
  it('upgrades a partially migrated v1 database without changing data', () => {
    const fact = store.getFactDetails(7)!;
    expect(fact.text).toBe('The user lives in Rome');
    expect(fact.category).toBe('location');
    // Backfilled columns must land on the same defaults a fresh CREATE TABLE gives,
    // or an upgraded store gates injection differently from a new one.
    expect(fact.sensitivity).toBe('standard');
    expect(fact.confidence).toBe(0.8);
    expect(fact.status).toBe('active');
    expect(fact.createdAt).toBe(1234);
    expect(Array.from(store.getFactVectors('v1-model').get(7)!)).toEqual([0.25, 0.75]);
    expect(store.getMeta('recall_schema_version')).toBe('3');
  });

  it('backfills v3 usage columns with neutral defaults', () => {
    const fact = store.getFactDetails(7)!;
    expect(fact.timesInjected).toBe(0);
    expect(fact.timesUsed).toBe(0);
    expect(fact.lastUsedAt).toBeNull();
  });

  it('creates the v3 summary tables on upgrade', () => {
    expect(store.listThreadSummaries()).toEqual([]);
    const id = store.upsertSummary({
      threadId: 't-migrated',
      text: 'Discussed the Rome move.',
      firstTs: 1000,
      lastTs: 2000,
      newMessageCount: 4,
      lastMessageId: 12
    });
    expect(id).not.toBeNull();
    expect(store.listThreadSummaries()).toHaveLength(1);
    store.deleteThreadSummary(id!);
  });

  it('is idempotent on a second open', () => {
    store.close();
    expect(store.getFactDetails(7)?.text).toBe('The user lives in Rome');
    expect(store.getMeta('recall_schema_version')).toBe('3');
  });
});
