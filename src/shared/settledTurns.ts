// The settled-turn race guard, shared by the renderer's session orchestration and
// the main-process mobile bridge.
//
// Both surfaces have the same ordering problem: a turn can finish before the call
// that started it has returned. The renderer would resurrect `activeTurnId` from
// the late response; the bridge would add a busy mark no later event can clear,
// blocking the task scheduler for the life of the process. The rule is identical
// in both places, so it lives in one file rather than being re-derived.
//
// Always keyed by TURN id, never thread id: thread ids recur across turns, so a
// settled thread would suppress the *next* turn's bookkeeping.

/** Bound on the defensive settled-turn race set. Entries normally disappear when
 * their matching start response arrives a moment later. */
export const SETTLED_TURN_CAP = 256;

export type TurnSettledMethod = 'turn/completed' | 'turn/failed' | 'turn/aborted';

export function isSettledMethod(method: string): method is TurnSettledMethod {
  return method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted';
}

/** Terminal events can beat the start-turn IPC response on very fast turns.
 * Remember them briefly so the late response cannot resurrect activeTurnId. */
export class SettledTurns {
  private ids = new Set<string>();

  note(turnId: string): void {
    this.ids.add(turnId);
    if (this.ids.size > SETTLED_TURN_CAP) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest) this.ids.delete(oldest);
    }
  }

  /** True (and forgets the id) when this turn already settled — i.e. its terminal
   * event beat the start IPC response. */
  consume(turnId: string | null | undefined): boolean {
    return turnId ? this.ids.delete(turnId) : false;
  }
}
