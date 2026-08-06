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

const live = new Set<string>();

/**
 * Fold one backend event into the set. A `threadId` of undefined means a
 * process-level event (process/exit): the backend is gone and no turn survived
 * it, so everything clears.
 */
export function noteTurnEvent(method: string, threadId: string | undefined): void {
  if (!threadId) {
    live.clear();
    return;
  }
  // The same two methods the desktop's follow-me pill has always treated as "this
  // thread is working": the first item of a turn, or its first token.
  if (method === 'item/started' || method === 'item/agentMessage/delta') live.add(threadId);
  else if (isSettledMethod(method)) live.delete(threadId);
}

/** Threads still streaming — the scheduler's defer/preempt signal. */
export function liveTurnCount(): number {
  return live.size;
}

/** Drop every mark (tests; a fresh server). */
export function clearLiveTurns(): void {
  live.clear();
}
