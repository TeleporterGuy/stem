import type { StartTurnResult } from '../shared/types';

/**
 * A resent startTurn with the same client-minted turn id answers with the turn
 * that already started instead of starting a second one.
 *
 * The phone loses the HTTP answer when it is backgrounded mid-call, though the
 * server got the prompt and ran it. It then shows the send as failed and the
 * user sends again, which for a new chat minted a second thread with the same
 * question. The client reuses the turn id on that resend; this map turns the
 * resend into "which thread did it land on?".
 *
 * Kept for ten minutes, and only for calls that succeeded — a start that threw
 * left nothing behind, so a retry must really run.
 */
const KEEP_MS = 10 * 60_000;
const started = new Map<string, { at: number; result: Promise<StartTurnResult> }>();

export function startTurnOnce(
  turnId: string | undefined,
  start: () => Promise<StartTurnResult>,
  now: () => number = Date.now
): Promise<StartTurnResult> {
  if (!turnId) return start();
  const t = now();
  for (const [id, entry] of started) if (t - entry.at > KEEP_MS) started.delete(id);
  const known = started.get(turnId);
  if (known) return known.result;
  const result = start();
  started.set(turnId, { at: t, result });
  result.catch(() => {
    // quiet: the caller awaits `result` and gets this same rejection; this only forgets the id.
    if (started.get(turnId)?.result === result) started.delete(turnId);
  });
  return result;
}

/** Tests only. */
export function resetStartTurnOnce(): void {
  started.clear();
}
