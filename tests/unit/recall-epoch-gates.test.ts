// "Reset recall" is a cancellation barrier for every asynchronous episodic
// writer: each pass snapshots getEpisodicGeneration() before its await and drops
// its writes when the epoch moved. These cases drive the barrier from inside the
// fake client/LLM — the reset lands while the call is outstanding, then a fresh
// capture reclaims the erased rowid (id is a plain INTEGER PRIMARY KEY, so the
// VACUUM hands the same id back). Each one persists corrupt state without its gate.
import { afterAll, describe, expect, it } from 'vitest';
import { recallStore as store, V1_FACTS_MIGRATED_KEY } from '../../src/server/recall/store';
import { embedNewMessages } from '../../src/server/recall/embed-episodic';
import { runMemoryRebuildStep, startMemoryRebuild } from '../../src/server/recall/rebuild';
import { backfillSummaryVectors } from '../../src/server/startup/retrieval';

afterAll(() => store.close());

const MODEL = 'epoch-gate-model';

/** The rebuild's own progress key, private to rebuild.ts (see memory-upgrade.test.ts). */
const REBUILD_KEY = 'memory_rebuild_v2';

describe('episodic embed pass', () => {
  it('drops the vectors and the watermark when a reset lands during the embed await', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'G', turnId: 'g1', role: 'user', text: 'the erased message that was mid-embed' });
    const doomedId = store.getMessagesForEmbedding(0, 10)[0].id;
    const client = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[]) => {
        store.resetEpisodic();
        store.recordMessage({ threadId: 'G2', turnId: 'g2', role: 'user', text: 'captured after the reset, still needs embedding' });
        return texts.map(() => Float32Array.from([1, 0]));
      }
    };

    expect(await embedNewMessages(client)).toBe(0);
    const survivors = store.getMessagesForEmbedding(0, 10);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(doomedId); // rowid reuse — the race this gate exists for
    expect(store.getEpisodicVectorStats(MODEL).embeddedCount).toBe(0);
    // The real damage without the gate: a resurrected watermark makes every
    // later pass skip the new message, because the select is `WHERE id > watermark`.
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(0);
    expect(store.getMessagesForEmbedding(store.getMessageEmbedWatermark(MODEL), 10)).toHaveLength(1);
  });

  it('still embeds and watermarks normally when no reset intervenes', async () => {
    store.resetEpisodic();
    store.recordMessage({ threadId: 'G3', turnId: 'g3', role: 'user', text: 'an ordinary message with retrievable signal' });
    const client = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
    };

    expect(await embedNewMessages(client)).toBe(1);
    expect(store.getMessageEmbedWatermark(MODEL)).toBe(store.getMessagesForEmbedding(0, 10)[0].id);
  });
});

describe('summary-vector backfill', () => {
  it('never binds an erased summary\'s embedding to the id a new summary reclaimed', async () => {
    store.resetEpisodic();
    const doomedId = store.upsertSummary({
      threadId: 'sum-erased',
      text: 'A summary about the kitchen renovation budget.',
      firstTs: 1,
      lastTs: 2,
      newMessageCount: 4,
      lastMessageId: 4
    });
    let replacementId: number | null = null;
    const client = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[]) => {
        store.resetEpisodic();
        replacementId = store.upsertSummary({
          threadId: 'sum-fresh',
          text: 'An unrelated summary about balcony gardening.',
          firstTs: 3,
          lastTs: 4,
          newMessageCount: 2,
          lastMessageId: 2
        });
        return texts.map(() => Float32Array.from([1, 0]));
      }
    };

    expect(await backfillSummaryVectors(client, MODEL)).toBe(0);
    expect(replacementId).toBe(doomedId); // same id, different summary
    // Ungated, the erased summary's vector lands on the replacement — which then
    // ranks for the wrong query and is never re-embedded, since it is no longer missing.
    expect(store.getSummariesMissingVector(MODEL).map((s) => s.id)).toEqual([replacementId]);
  });

  it('embeds every missing summary when no reset intervenes', async () => {
    store.resetEpisodic();
    store.upsertSummary({
      threadId: 'sum-ok',
      text: 'A summary that gets its vector as usual.',
      firstTs: 1,
      lastTs: 2,
      newMessageCount: 3,
      lastMessageId: 3
    });
    const client = {
      available: async () => true,
      modelId: async () => MODEL,
      embed: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
    };

    expect(await backfillSummaryVectors(client, MODEL)).toBe(1);
    expect(store.getSummariesMissingVector(MODEL)).toHaveLength(0);
  });
});

describe('memory rebuild', () => {
  it('does not persist a stale failure when an episodic reset wins a rejected model call', async () => {
    // Only a store upgraded from v1 offers the rebuild at all, and resetEpisodic
    // leaves its legacy facts alone — so without the gate the user is shown
    // "Memory rebuild failed" immediately after a clean reset.
    store.resetEpisodic();
    store.setMeta(V1_FACTS_MIGRATED_KEY, '1');
    store.recordMessage({ threadId: 'rebuild-episodic-race', turnId: 'turn-1', role: 'user', text: 'I permanently prefer window seats.' });
    startMemoryRebuild();
    let reject!: (error: Error) => void;
    const reply = new Promise<string>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = runMemoryRebuildStep({
      complete: async () => {
        started();
        return reply;
      }
    });

    await modelStarted;
    store.resetEpisodic();
    reject(new Error('model failed after reset'));

    const status = await pending;
    expect(status.state).not.toBe('failed');
    expect(status.lastError).toBeUndefined();
    expect(store.getMeta(REBUILD_KEY)).toBeNull(); // reset's erasure stands
    store.setMeta(V1_FACTS_MIGRATED_KEY, '0');
  });
});
