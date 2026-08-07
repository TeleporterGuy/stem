// Which threads have a turn in flight, on any surface of any client.
//
// This is the server-side replacement for two things that used to be counted
// separately and could disagree: the desktop asking itself "is one of my windows
// streaming", and the phone bridge keeping its own set of threads a phone had
// started. Neither could see the other, which is why the scheduler needed both.
// The server sees every backend event, so it can answer for every device at once
// — and that is the only answer that stays right when there is more than one.
//
// Driven purely from the event stream, never from a start-turn response. That is
// what retires the settled-turn race the bridge needed a guard for: a terminal
// event can no longer arrive before the mark it is supposed to clear, because the
// mark is made by an earlier event of the same turn.

import { isSettledMethod } from '../shared/settledTurns';

/** Thread id → the turn currently running in it (empty string when unknown). */
const live = new Map<string, string>();

/**
 * Fold one backend event into the set. A `threadId` of undefined means a
 * process-level event (process/exit): the backend is gone and no turn survived
 * it, so everything clears.
 */
export function noteTurnEvent(method: string, threadId: string | undefined, turnId?: string): void {
  if (!threadId) {
    live.clear();
    return;
  }
  // The same two methods the desktop's follow-me pill has always treated as "this
  // thread is working": the first item of a turn, or its first token.
  if (method === 'item/started' || method === 'item/agentMessage/delta') {
    // Later events of the same turn re-assert the same id; a NEW turn in the same
    // thread overwrites it, which is what a client resuming needs — the turn id is
    // what its Stop button interrupts, and an id from the previous turn would
    // interrupt nothing.
    live.set(threadId, turnId ?? live.get(threadId) ?? '');
  } else if (isSettledMethod(method)) live.delete(threadId);
}

/** Threads still streaming — the scheduler's defer/preempt signal. */
export function liveTurnCount(): number {
  return live.size;
}

/**
 * What is running right now, for a client that has just (re)connected.
 *
 * A client that was away cannot tell "this turn is still going" from "this turn
 * finished and I missed the event": both look like a thread that stopped
 * producing deltas. Answering it from here means the answer comes from the same
 * fold that every other consumer reads, rather than from a second count that
 * could disagree — and it is the whole of the answer, so a thread absent from it
 * is settled, not merely unmentioned.
 */
export function liveTurnSnapshot(): { threadId: string; turnId: string | null }[] {
  return [...live].map(([threadId, turnId]) => ({ threadId, turnId: turnId || null }));
}

/** Drop every mark (tests; a fresh server). */
export function clearLiveTurns(): void {
  live.clear();
}
