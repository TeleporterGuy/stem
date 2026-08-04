// The Memory audit surface answers "what did Stem tell this turn?", which is a
// question about the PAST. Everything here guards the one way that goes wrong:
// reconstructing a historical flag from a fact's present state, so a conflict
// raised (or resolved) afterwards rewrites what an earlier turn is shown to have
// seen. See BUG-021.
import { afterAll, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/main/recall/store';
import { dispatchLocal } from '../../src/main/ipc/guard';
import { registerMemoryIpc } from '../../src/main/ipc/memory';
import type { IpcDeps } from '../../src/main/ipc/deps';
import type { ActiveFacts } from '../../src/shared/types';

// Registration only records handlers; `memory:activeFacts` reads none of these.
registerMemoryIpc({} as IpcDeps);

const peek = (threadId: string): Promise<ActiveFacts | null> =>
  dispatchLocal('memory:activeFacts', [threadId]) as Promise<ActiveFacts | null>;

afterAll(() => store.close());

describe('Memory Peek shows the turn as it happened', () => {
  it('does not backdate a conflict raised after the turn', async () => {
    store.resetFacts();
    const a = store.upsertFact('The user ships the release on a Tuesday', 'distilled')!;
    const b = store.upsertFact('The user ships the release on a Thursday', 'distilled')!;

    // The turn saw a settled fact.
    store.setActiveFacts('THREAD-FP', [{ id: a, reason: 'lexical', disputed: false }], 'lexical');
    store.createFactConflict(a, b, 'contradictory release days');

    expect(store.getFactDetails(a)?.status).toBe('conflicted');
    const facts = (await peek('THREAD-FP'))!.facts;
    expect(facts.map((f) => f.id)).toEqual([a]);
    expect(facts[0].disputed).toBeUndefined();
  });

  it('does not erase a dispute the turn actually carried', async () => {
    store.resetFacts();
    const a = store.upsertFact('The user prefers the aisle seat', 'distilled')!;
    const b = store.upsertFact('The user prefers the window seat', 'distilled')!;
    const conflictId = store.createFactConflict(a, b, 'contradictory seat preference')!;

    // The turn injected `a` as the disputed representative...
    store.setActiveFacts('THREAD-FN', [{ id: a, reason: 'lexical', disputed: true }], 'lexical');
    // ...and only afterwards was the conflict settled, putting `a` back to active.
    store.resolveMemoryConflict(conflictId, 'keep_both');

    expect(store.getFactDetails(a)?.status).toBe('active');
    expect((await peek('THREAD-FN'))!.facts[0].disputed).toBe(true);
  });

  it('falls back to current status only for rows written before the flag existed', async () => {
    store.resetFacts();
    const a = store.upsertFact('The user runs the standup at nine', 'distilled')!;
    const b = store.upsertFact('The user runs the standup at ten', 'distilled')!;
    store.createFactConflict(a, b, 'contradictory standup time');

    // A pre-upgrade row: a bare id, carrying no answer at all. Guessing from the
    // live status is wrong, but it is the only signal such a row leaves behind.
    store.setActiveFacts('THREAD-LEGACY', [a], 'lexical');
    expect((await peek('THREAD-LEGACY'))!.facts[0].disputed).toBe(true);
  });
});
