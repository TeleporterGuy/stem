// The busy signal the scheduler reads (liveTurnCount → busyWithin → isUserActive),
// and the recall background passes yield to.
//
// This used to be two disjoint counters — the desktop's own run-state and the
// phone bridge's set of threads a phone had started — neither of which could see
// the other. It is one server-side set now, folded out of the backend event
// stream, so it answers for every connected device at once.
//
// Driving it from events rather than from a start-turn response is also what
// retires the race the bridge needed SettledTurns for: there is no longer a way
// for a terminal event to arrive before the mark it is meant to clear. The cases
// that guard covered are kept below, stated in the new terms.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLiveTurns,
  liveTurnCount,
  liveTurnSnapshot,
  noteTurnEvent
} from '../../src/server/live-turns';

beforeEach(() => {
  clearLiveTurns();
});

describe('marking a thread busy', () => {
  it('starts on the turn\'s first event and clears on its terminal one', () => {
    noteTurnEvent('item/started', 'thread-1');
    expect(liveTurnCount()).toBe(1);

    noteTurnEvent('turn/completed', 'thread-1');
    expect(liveTurnCount()).toBe(0);

    // A turn that only ever streams text counts too — the first delta is as
    // good a "this thread is working" as the first item.
    noteTurnEvent('item/agentMessage/delta', 'thread-1');
    expect(liveTurnCount()).toBe(1);
    noteTurnEvent('turn/aborted', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });

  it('counts each thread once, however many events it produces', () => {
    for (const method of ['item/started', 'item/agentMessage/delta', 'item/agentMessage/delta']) {
      noteTurnEvent(method, 'thread-1');
    }
    noteTurnEvent('item/started', 'thread-2');
    expect(liveTurnCount()).toBe(2);
    noteTurnEvent('turn/failed', 'thread-1');
    expect(liveTurnCount()).toBe(1);
  });

  it('leaves no mark when the turn settles with nothing having streamed', () => {
    // The old race, in its new shape: the mark is made by an EARLIER event of the
    // same turn, so a terminal event that arrives first has nothing to strand.
    // Before the split this had to be guarded, because the mark came from the
    // start-turn response and could land after the terminal event.
    noteTurnEvent('turn/completed', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });

  it('does not let one turn settling suppress the next turn on the same thread', () => {
    // Thread ids recur across turns. A settled thread must not be remembered as
    // settled, or the next turn on it would never register as busy.
    noteTurnEvent('turn/completed', 'thread-1');
    noteTurnEvent('item/started', 'thread-1');
    expect(liveTurnCount()).toBe(1);
  });
});

describe('the backend going away', () => {
  it('clears every mark on a process-level event', () => {
    noteTurnEvent('item/started', 'thread-1');
    noteTurnEvent('item/started', 'thread-2');
    // process/exit carries no threadId: no turn survived it, so a stuck mark here
    // would defer every scheduled task for the life of the process.
    noteTurnEvent('process/exit', undefined);
    expect(liveTurnCount()).toBe(0);
  });

  it('ignores anything that is neither a start nor a settle', () => {
    noteTurnEvent('item/completed', 'thread-1');
    noteTurnEvent('turn/started', 'thread-1');
    expect(liveTurnCount()).toBe(0);
  });
});

// The same fold, read as an answer rather than a count: what a client is told the
// instant its event stream connects, so a turn that kept running while it was
// away shows as active instead of finished.
describe('the snapshot a connecting client gets', () => {
  it('names each live thread and the turn running in it', () => {
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('item/agentMessage/delta', 'thread-2', 'turn-b');
    expect(liveTurnSnapshot()).toEqual([
      { threadId: 'thread-1', turnId: 'turn-a' },
      { threadId: 'thread-2', turnId: 'turn-b' }
    ]);
  });

  it('carries the newest turn of a thread, not the one that started it', () => {
    // The turn id is what a client's Stop interrupts. An id from the previous
    // turn of the same thread would interrupt nothing.
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('turn/completed', 'thread-1', 'turn-a');
    noteTurnEvent('item/started', 'thread-1', 'turn-b');
    expect(liveTurnSnapshot()).toEqual([{ threadId: 'thread-1', turnId: 'turn-b' }]);
  });

  it('is empty once every turn has settled', () => {
    noteTurnEvent('item/started', 'thread-1', 'turn-a');
    noteTurnEvent('turn/aborted', 'thread-1', 'turn-a');
    // Emptiness is an answer, not an absence of one: a client reading this is
    // told its spinner should stop, which is the whole point of being sent it.
    expect(liveTurnSnapshot()).toEqual([]);
  });
});
