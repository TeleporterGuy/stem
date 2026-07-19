import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { captureMemoryFromUserInput } from '../../src/main/workspace/memory';
import { distillNewMessages } from '../../src/main/recall/distill';
import { consolidateFacts } from '../../src/main/recall/consolidate';
import { buildRecallContext } from '../../src/main/recall/inject';
import { reconcileExplicitFact } from '../../src/main/recall/reconcile';
import { setRetrievalClients } from '../../src/main/recall/retrieval';
import { runMemoryRebuildStep, startMemoryRebuild } from '../../src/main/recall/rebuild';
import { recallStore as store } from '../../src/main/recall/store';

beforeEach(() => {
  store.resetEpisodic();
  store.resetFacts();
  store.setMeta('recall_enabled', 'true');
  setRetrievalClients({ embeddings: null, rerank: null });
});

afterAll(() => {
  setRetrievalClients({ embeddings: null, rerank: null });
  store.close();
});

describe('persistence regressions', () => {
  it('does not treat a negated remember request as an explicit memory', async () => {
    for (const text of [
      'Never remember that my launch code is blue.',
      'Never, under any circumstances, remember that my launch code is blue.',
      'Never—under any circumstances—remember that my launch code is blue.',
      'Please never, for any reason, remember that my launch code is blue.',
      'Don\u2019t remember that my launch code is blue.',
      'Don\u2019t, under any circumstances, remember that my launch code is blue.',
      "I don't want you to remember that my launch code is blue."
    ]) {
      const result = await captureMemoryFromUserInput(text);
      expect(result).toEqual({ captured: false, shouldAcknowledge: false });
    }
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('still captures a positive explicit remember request', async () => {
    const result = await captureMemoryFromUserInput('I want you to remember that I prefer window seats.');
    expect(result).toMatchObject({ captured: true, shouldAcknowledge: true });
    expect(store.getAllFacts().some((fact) => /prefer window seats/i.test(fact.text))).toBe(true);
  });

  it('does not resurrect facts when reset wins an in-flight distillation', async () => {
    store.recordMessage({
      threadId: 'race',
      turnId: 'turn-1',
      role: 'user',
      text: 'I have permanently moved to Turin.'
    });
    const messageId = store.getMessagesForDistillFrom(1)[0].id;
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = distillNewMessages({
      complete: async () => {
        started();
        return reply;
      }
    });

    await modelStarted;
    store.resetFacts();
    release(JSON.stringify({
      claims: [{
        text: 'The user lives in Turin.',
        category: 'location',
        sensitivity: 'sensitive',
        validUntil: null,
        evidenceMessageIds: [messageId],
        supersedesFactIds: [],
        conflictsWithFactIds: []
      }],
      factUsage: []
    }));

    expect(await pending).toBe(0);
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('does not apply an in-flight consolidation to post-reset facts with reused ids', async () => {
    const oldA = store.upsertFact('The user owns a blue duplicate notebook.', 'distilled')!;
    const oldB = store.upsertFact('The user has a notebook that is blue.', 'distilled')!;
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = consolidateFacts({
      complete: async () => {
        started();
        return reply;
      }
    }, { force: true });

    await modelStarted;
    store.resetFacts();
    const replacementA = store.upsertFact('The user safely keeps replacement fact A.', 'distilled')!;
    const replacementB = store.upsertFact('The user safely keeps replacement fact B.', 'distilled')!;
    expect([replacementA, replacementB]).toEqual([oldA, oldB]);
    release(JSON.stringify({
      merge: [{ ids: [oldA, oldB], text: 'Stale consolidation output' }],
      correct: [],
      drop: []
    }));

    expect(await pending).toEqual({ merged: 0, corrected: 0, dropped: 0, failedChunks: 0 });
    expect(store.getFactDetails(replacementA)?.status).toBe('active');
    expect(store.getFactDetails(replacementB)?.status).toBe('active');
    expect(store.getAllFacts().some((fact) => /Stale consolidation output/.test(fact.text))).toBe(false);
  });

  it('revalidates protected facts immediately before applying consolidation', async () => {
    const learnedA = store.upsertFact('The user owns a green duplicate notebook.', 'distilled')!;
    const learnedB = store.upsertFact('The user has a notebook that is green.', 'distilled')!;
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = consolidateFacts({
      complete: async () => {
        started();
        return reply;
      }
    }, { force: true });

    await modelStarted;
    expect(store.confirmFact(learnedB)).toBe(true);
    release(JSON.stringify({
      merge: [{ ids: [learnedA, learnedB], text: 'The user owns a green notebook.' }],
      correct: [],
      drop: [learnedB]
    }));

    expect(await pending).toEqual({ merged: 0, corrected: 0, dropped: 0, failedChunks: 0 });
    expect(store.getFactDetails(learnedA)?.status).toBe('active');
    expect(store.getFactDetails(learnedB)).toMatchObject({ status: 'active', source: 'explicit' });
  });

  it('rejects a merge when any member changed identity before final apply', async () => {
    const learnedA = store.upsertFact('The user owns a red duplicate notebook.', 'distilled')!;
    const learnedB = store.upsertFact('The user has a notebook that is red.', 'distilled')!;
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = consolidateFacts({
      complete: async () => {
        started();
        return reply;
      }
    }, { force: true });

    await modelStarted;
    expect(store.supersedeFact(learnedB)).toBe(true);
    release(JSON.stringify({
      merge: [{ ids: [learnedA, learnedB], text: 'Stale partial red-notebook merge.' }],
      correct: [],
      drop: []
    }));

    expect(await pending).toEqual({ merged: 0, corrected: 0, dropped: 0, failedChunks: 0 });
    expect(store.getFactDetails(learnedA)).toMatchObject({
      text: 'The user owns a red duplicate notebook.',
      status: 'active'
    });
    expect(store.getFactDetails(learnedB)?.status).toBe('superseded');
  });

  it('serializes concurrent consolidation requests', async () => {
    store.upsertFact('The user owns a silver duplicate notebook.', 'distilled');
    store.upsertFact('The user has a notebook that is silver.', 'distilled');
    let release!: (reply: string) => void;
    const firstReply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = consolidateFacts({
      complete: async () => {
        firstStarted();
        return firstReply;
      }
    }, { force: true });
    await started;

    let secondCalls = 0;
    const second = consolidateFacts({
      complete: async () => {
        secondCalls += 1;
        return JSON.stringify({ merge: [], correct: [], drop: [] });
      }
    }, { force: true });
    await Promise.resolve();
    expect(secondCalls).toBe(0);

    release(JSON.stringify({ merge: [], correct: [], drop: [] }));
    await first;
    await second;
    expect(secondCalls).toBe(1);
  });

  it('does not inject cleared facts or cache their vectors after reset', async () => {
    const oldId = store.upsertFact('The user keeps the obsolete amber launch code.', 'distilled')!;
    let releasePassages!: (vectors: Float32Array[]) => void;
    const passages = new Promise<Float32Array[]>((resolve) => {
      releasePassages = resolve;
    });
    let passageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      passageStarted = resolve;
    });
    setRetrievalClients({
      embeddings: {
        available: async () => true,
        modelId: async () => 'deferred-reset-model',
        embed: async (texts, kind) => {
          if (kind === 'query') return texts.map(() => Float32Array.from([1, 0]));
          passageStarted();
          return passages;
        }
      },
      rerank: null
    });

    const pending = buildRecallContext('What is my amber launch code?');
    await started;
    store.resetFacts();
    const replacementId = store.upsertFact('The user keeps a safe replacement fact.', 'distilled')!;
    expect(replacementId).toBe(oldId);
    releasePassages([Float32Array.from([1, 0])]);

    const context = await pending;
    expect(context ?? '').not.toContain('obsolete amber launch code');
    expect(store.getFactVectors('deferred-reset-model').has(replacementId)).toBe(false);
  });

  it('does not apply in-flight explicit reconciliation to post-reset facts with reused ids', async () => {
    const oldId = store.upsertFact('The user lives in Rome.', 'explicit')!;
    const freshId = store.upsertFact('The user lives in Milan.', 'explicit')!;
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = reconcileExplicitFact(freshId, {
      complete: async () => {
        started();
        return reply;
      }
    });

    await modelStarted;
    store.resetFacts();
    const replacementOld = store.upsertFact('The user safely keeps replacement relation A.', 'distilled')!;
    const replacementFresh = store.upsertFact('The user safely keeps replacement relation B.', 'explicit')!;
    expect([replacementOld, replacementFresh]).toEqual([oldId, freshId]);
    release(JSON.stringify({ supersedeIds: [oldId], conflictIds: [] }));

    await pending;
    expect(store.getFactDetails(replacementOld)?.status).toBe('active');
    expect(store.getFactDetails(replacementFresh)?.status).toBe('active');
    expect(store.getMemoryConflicts()).toHaveLength(0);
  });

  it('cancels an in-flight memory rebuild at the same reset barrier', async () => {
    store.recordMessage({
      threadId: 'rebuild-race',
      turnId: 'turn-1',
      role: 'user',
      text: 'I permanently prefer the violet notebook for planning.'
    });
    const messageId = store.getMessagesForDistillFrom(1)[0].id;
    startMemoryRebuild();
    let release!: (reply: string) => void;
    const reply = new Promise<string>((resolve) => {
      release = resolve;
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
    store.resetFacts();
    release(JSON.stringify({
      claims: [{
        text: 'The user prefers violet notebooks.',
        category: 'preference',
        sensitivity: 'standard',
        validUntil: null,
        evidenceMessageIds: [messageId],
        supersedesFactIds: [],
        conflictsWithFactIds: []
      }]
    }));

    expect((await pending).state).toBe('available');
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('does not persist a stale rebuild failure when reset wins a rejected model call', async () => {
    store.recordMessage({
      threadId: 'rebuild-rejection-race',
      turnId: 'turn-1',
      role: 'user',
      text: 'I permanently prefer aisle seats.'
    });
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
    store.resetFacts();
    reject(new Error('model failed after reset'));

    const status = await pending;
    expect(status.state).toBe('available');
    expect(status.lastError).toBeUndefined();
  });
});
