import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store, V1_FACTS_MIGRATED_KEY } from '../../src/server/recall/store';
import { getMemoryRebuildStatus, runMemoryRebuildStep, startMemoryRebuild } from '../../src/server/recall/rebuild';

// The rebuild's own progress key (private to rebuild.ts). Written directly here to
// stand in for a store that a pre-gate build already advertised the upgrade on.
const REBUILD_KEY = 'memory_rebuild_v2';

afterAll(() => store.close());
beforeEach(() => {
  // Start every case in the state a brand-new install opens in. The v1 flag is
  // sticky by design (it describes the transcripts, which no reset rewrites), so
  // clear it explicitly rather than relying on the resets below.
  store.setMeta(V1_FACTS_MIGRATED_KEY, '0');
  store.resetFacts();
  store.resetEpisodic();
});

describe('memory upgrade offer', () => {
  it('is never made to a new user, whose memories carried provenance from the first message', async () => {
    store.recordMessage({ threadId: 'fresh', role: 'user', text: 'The user just installed Stem.' });
    store.recordMessage({ threadId: 'fresh', role: 'assistant', text: 'Welcome aboard.' });
    expect(getMemoryRebuildStatus().state).toBe('complete');
    // 'complete' hides the card, which is the only entry point — but consent must be
    // inert too, so nothing can spend model calls re-mining what v2 already distilled.
    expect(startMemoryRebuild().state).toBe('complete');
    let calls = 0;
    await runMemoryRebuildStep({
      complete: async () => {
        calls += 1;
        return '{"claims":[]}';
      }
    });
    expect(calls).toBe(0);
  });

  it('ignores rebuild progress a pre-gate build persisted on such a store', () => {
    store.recordMessage({ threadId: 'stale', role: 'user', text: 'Nothing here predates v2.' });
    store.setMeta(
      REBUILD_KEY,
      JSON.stringify({
        state: 'running',
        processedMessages: 0,
        totalMessages: 1,
        cursorMessageId: 1,
        cursorOffset: 0
      })
    );
    expect(getMemoryRebuildStatus().state).toBe('complete');
  });

  it('is made to a store holding facts distilled before v2', () => {
    store.recordMessage({ threadId: 'v1', role: 'user', text: 'The user enjoys astronomy.' });
    store.upsertFact('The user enjoys astronomy', 'legacy');
    expect(getMemoryRebuildStatus().state).toBe('available');
  });

  it('is made on the migration flag alone, for a v1 store that had not distilled yet', () => {
    store.recordMessage({ threadId: 'v1-empty', role: 'user', text: 'Captured before v2 shipped.' });
    store.setMeta(V1_FACTS_MIGRATED_KEY, '1');
    expect(getMemoryRebuildStatus().state).toBe('available');
  });

  it('survives forgetting the facts but not the transcripts it would re-mine', () => {
    store.recordMessage({ threadId: 'wiped', role: 'user', text: 'The user enjoys astronomy.' });
    store.setMeta(V1_FACTS_MIGRATED_KEY, '1');
    store.upsertFact('The user enjoys astronomy', 'legacy');
    expect(startMemoryRebuild().state).toBe('running');
    // Forgetting facts cancels the run and returns it to needing consent again —
    // the pre-v2 history it reads is still there.
    store.resetFacts();
    expect(getMemoryRebuildStatus().state).toBe('available');
    // Clearing that history leaves nothing to reprocess.
    store.resetEpisodic();
    expect(getMemoryRebuildStatus().state).toBe('complete');
  });
});
