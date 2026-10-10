// Duplicate merging in the relation check (the `covers` verdicts) and the
// tidy-up's neighbourhood grouping, recent/full scopes and folder exclusion.
// Stateful (shared per-process DB) like the sibling recall suites.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLIDATE_CHUNK, recallStore as store } from '../../src/server/recall/store';
import {
  RELATION_PROMPT_HEADER,
  processPendingRelationChecks,
  sweepFactAgainstNeighbours,
  type FactRelation
} from '../../src/server/recall/reconcile';
import { consolidateFacts, fullTidyDue } from '../../src/server/recall/consolidate';
import * as retrieval from '../../src/server/recall/retrieval';
import type { LlmClient } from '../../src/server/recall/llm';

afterAll(() => store.close());
beforeEach(() => {
  store.resetFacts();
});

const MODEL = 'fake-model';

function verdictLlm(verdict: FactRelation): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    complete: async (prompt: string) => {
      if (!prompt.includes(RELATION_PROMPT_HEADER)) throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
      llm.calls += 1;
      return JSON.stringify({ verdict });
    }
  };
  return llm;
}

function seedFact(
  text: string,
  vec: number[],
  over: { source?: string; confidence?: number; pinned?: boolean; excerpt?: string } = {}
): number {
  const id = store.upsertFact(text, {
    source: over.source ?? 'distilled',
    confidence: over.confidence ?? 0.9,
    evidence: [{
      messageId: null, threadId: null, role: null,
      timestamp: Math.floor(Date.now() / 1000) - 86_400,
      excerpt: over.excerpt ?? `evidence: ${text}`, origin: 'folder_doc', folderId: 'f', relPath: 'x.pdf'
    }]
  })!;
  if (over.pinned) store.setFactPinned(id, true);
  store.upsertFactVector(id, MODEL, Float32Array.from(vec));
  return id;
}

describe('duplicate verdicts in the relation check', () => {
  it('retires the covered fact into the covering one, keeping its evidence, without a conflict', async () => {
    const full = seedFact('The user has a ChatGPT Pro subscription billed to Awantech s.r.o.', [1, 0, 0], { excerpt: 'old proof' });
    const fresh = seedFact('The user pays for ChatGPT Pro.', [0.98, 0.1, 0], { excerpt: 'new proof' });
    // A = the existing neighbour, B = the fresh fact: A covers B.
    expect(await sweepFactAgainstNeighbours(fresh, MODEL, verdictLlm('a_covers_b'), { directUser: false })).toBe(true);
    expect(store.getFactDetails(fresh)?.status).toBe('superseded');
    expect(store.getFactDetails(fresh)?.supersededBy).toBe(full);
    expect(store.getFactDetails(full)?.status).toBe('active');
    expect(store.getFactDetails(full)?.evidence.map((e) => e.excerpt).sort()).toEqual(['new proof', 'old proof']);
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('retires an older, thinner neighbour when the fresh fact covers it', async () => {
    const thin = seedFact('The user speaks Slovak.', [1, 0, 0]);
    const fresh = seedFact('The user is a native Slovak speaker with C1 English.', [0.97, 0.2, 0]);
    await sweepFactAgainstNeighbours(fresh, MODEL, verdictLlm('b_covers_a'), { directUser: false });
    expect(store.getFactDetails(thin)?.status).toBe('superseded');
    expect(store.getFactDetails(thin)?.supersededBy).toBe(fresh);
    expect(store.getFactDetails(fresh)?.status).toBe('active');
  });

  it('keeps both when the covered side is the more trusted one', async () => {
    const rich = seedFact('The user is Vladimir, a DevOps consultant at Awantech.', [1, 0, 0], { confidence: 0.55 });
    const userSaid = seedFact('The user is a DevOps consultant.', [0.97, 0.2, 0], { confidence: 0.9 });
    await sweepFactAgainstNeighbours(userSaid, MODEL, verdictLlm('a_covers_b'), { directUser: true });
    expect(store.getFactDetails(rich)?.status).toBe('active');
    expect(store.getFactDetails(userSaid)?.status).toBe('active');
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('never retires an explicit or pinned fact, and never merges across sources', async () => {
    const explicit = seedFact('The user works at Awantech.', [1, 0, 0], { source: 'explicit' });
    const pinned = seedFact('The user is employed by Awantech.', [0.99, 0.05, 0], { pinned: true });
    const doc = seedFact('Awantech employs the user.', [0.98, 0.1, 0], { source: 'folder:abc', confidence: 0.9 });
    const fresh = seedFact('The user works for Awantech s.r.o. as a consultant.', [0.97, 0.15, 0]);
    await sweepFactAgainstNeighbours(fresh, MODEL, verdictLlm('b_covers_a'), { directUser: true });
    expect(store.getFactDetails(explicit)?.status).toBe('active');
    expect(store.getFactDetails(pinned)?.status).toBe('active');
    expect(store.getFactDetails(doc)?.status).toBe('active');
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('the background queue merges duplicates and counts them', async () => {
    const a = seedFact('The user has a dog named Rex.', [1, 0, 0]);
    const b = seedFact('The user owns Rex, a dog.', [0.99, 0.1, 0]);
    store.enqueueRelationChecks([[a, b]], 'backfill');
    expect(await processPendingRelationChecks(verdictLlm('a_covers_b'))).toEqual({ checked: 1, conflicts: 0, merged: 1 });
    expect(store.getFactDetails(b)?.status).toBe('superseded');
    expect(store.getFactDetails(a)?.status).toBe('active');
  });
});

describe('tidy-up grouping and scope', () => {
  // Every prompt the tidy model saw, as the list of ids in it.
  let prompts: number[][] = [];
  const recordingLlm: LlmClient = {
    complete: async (prompt: string) => {
      prompts.push([...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1])));
      return JSON.stringify({ merge: [], correct: [], drop: [] });
    }
  };
  // Vectors come from a "topic:<n>" tag in the text: same topic → same direction.
  const topicEmbeddings = {
    available: async () => true,
    modelId: async () => MODEL,
    embed: async (texts: string[]) => texts.map((t) => {
      const n = Number(/topic:(\d+)/.exec(t)?.[1] ?? 0);
      const v = new Float32Array(32);
      v[n % 32] = 1;
      return v;
    })
  };

  beforeEach(() => {
    prompts = [];
    retrieval.setRetrievalClients({ embeddings: topicEmbeddings, rerank: null });
    store.setConsolidateChunkSize(6);
  });
  afterEach(() => {
    retrieval.setRetrievalClients({ embeddings: null, rerank: null });
    store.setConsolidateChunkSize(DEFAULT_CONSOLIDATE_CHUNK);
  });

  const seedTopic = (topic: number, i: number, source = 'distilled'): number =>
    store.upsertFact(`The user fact ${i} topic:${topic}`, { source, confidence: 0.9 })!;

  it('puts every fact in a prompt with its same-topic neighbours, however far apart their ids', async () => {
    const byTopic = new Map<number, number[]>();
    // 4 topics × 3 facts, interleaved so id order never groups a topic.
    for (let i = 0; i < 12; i++) {
      const topic = i % 4;
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), seedTopic(topic, i)]);
    }
    await consolidateFacts(recordingLlm, { force: true });
    for (const ids of byTopic.values()) {
      expect(prompts.some((p) => ids.every((id) => p.includes(id)))).toBe(true);
    }
    expect(prompts.every((p) => p.length <= 6)).toBe(true);
  });

  it('never shows folder facts to the tidy model', async () => {
    for (let i = 0; i < 8; i++) seedTopic(i, i);
    const doc = seedTopic(1, 99, 'folder:abc');
    await consolidateFacts(recordingLlm, { force: true });
    expect(prompts.flat()).not.toContain(doc);
  });

  it('a recent pass reviews only new facts and their neighbours; nothing new means no call', async () => {
    const old: number[] = [];
    for (let i = 0; i < 12; i++) old.push(seedTopic(i, i));
    await consolidateFacts(recordingLlm, { force: true });
    prompts = [];

    await consolidateFacts(recordingLlm, { scope: 'recent' });
    expect(prompts).toHaveLength(0);

    const fresh = seedTopic(3, 50);
    await consolidateFacts(recordingLlm, { scope: 'recent' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(fresh);
    expect(prompts[0]).toContain(old[3]); // its same-topic neighbour
    expect(prompts[0].length).toBeLessThan(old.length);
  });

  it('the daily full pass is due once a day, and never with auto tidy-up off', async () => {
    for (let i = 0; i < 8; i++) seedTopic(i, i);
    store.setMeta('consolidate_full_at', '0');
    expect(fullTidyDue()).toBe(true);
    await consolidateFacts(recordingLlm, { scope: 'full' });
    expect(fullTidyDue()).toBe(false);
    expect(fullTidyDue(Date.now() / 1000 + 25 * 3600)).toBe(true);
    const threshold = store.getTidyThreshold();
    store.setTidyThreshold(0);
    expect(fullTidyDue(Date.now() / 1000 + 25 * 3600)).toBe(false);
    store.setTidyThreshold(threshold);
  });
});
