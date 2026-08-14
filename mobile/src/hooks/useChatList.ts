// The chat list, kept current.
//
// One RPC (`chats:list`) and four reasons to run it again. They are worth naming
// because between them they are the whole of "the phone is live", and the shape
// of the answer — refetch, rather than patch what is on screen from the event —
// is deliberate. The desktop's offline cache makes the same choice for the same
// reason (see the SETTLED_TURN_METHODS comment in src/desktop/proxy.ts):
// reassembling a thread's summary from the deltas that went past would be a
// second, worse implementation of something the server already does, and it would
// be wrong in a different way on every screen that tried it.
//
//   pairing        there is a server to ask, and nothing has been asked yet.
//   chats:changed  a background subject write renamed a thread. Its own channel
//                  precisely because "ask for the list again" is the only
//                  sensible response to it.
//   a settled turn a turn finished, so some thread's preview and updatedAt have
//                  moved. Debounced, because several can settle at once.
//   resync         the stream could not be resumed and everything on screen is
//                  now of unknown age. Immediate, not debounced: this one means
//                  what is displayed may be wrong rather than merely old.
//
// A reconnect refetches too, but only from the second one on — the first is the
// stream opening after the load that pairing already triggered.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSettledMethod } from '@shared/settledTurns';
import type { ChatListResult } from '@shared/types';
import { useTransport } from '../transport/provider';

/** Long enough to swallow a burst of terminal events, short enough to feel live. */
const REFETCH_DEBOUNCE_MS = 400;

export interface ChatListState {
  list: ChatListResult | null;
  /** A request is in flight. Also true for the very first load. */
  loading: boolean;
  /** The last failure, or null. Kept alongside `list`, not instead of it: a stale
   * list plus "couldn't refresh" beats an empty screen. */
  error: string | null;
  refresh: () => void;
}

export function useChatList(): ChatListState {
  const { connection, status } = useTransport();
  const [list, setList] = useState<ChatListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Answers from superseded requests are dropped rather than raced. */
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenStream = useRef(false);

  const cancelPending = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const fetchNow = useCallback(async () => {
    cancelPending();
    if (!connection.status().paired) return;
    const mine = ++request.current;
    setLoading(true);
    try {
      const answer = await connection.rpc('chats:list');
      if (mine !== request.current) return;
      setList(answer);
      setError(null);
    } catch (e) {
      if (mine !== request.current) return;
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, [cancelPending, connection]);

  const schedule = useCallback(() => {
    cancelPending();
    timer.current = setTimeout(() => {
      timer.current = null;
      void fetchNow();
    }, REFETCH_DEBOUNCE_MS);
  }, [cancelPending, fetchNow]);

  useEffect(() => {
    if (!status.paired) {
      // Unpaired: the list belonged to a server this phone no longer has a
      // credential for, and leaving it on screen would be showing somebody
      // else's data.
      request.current += 1;
      cancelPending();
      setList(null);
      setError(null);
      setLoading(false);
      return;
    }
    void fetchNow();
  }, [status.paired, fetchNow, cancelPending]);

  useEffect(() => {
    if (!status.streaming) return;
    if (!seenStream.current) {
      seenStream.current = true;
      return;
    }
    schedule();
  }, [status.streaming, schedule]);

  useEffect(() => {
    const offResync = connection.onResync(() => {
      void fetchNow();
    });
    const offChanged = connection.onPush('chats:changed', schedule);
    const offBackend = connection.onBackendEvent((event) => {
      if (isSettledMethod(event.method)) schedule();
    });
    return () => {
      offResync();
      offChanged();
      offBackend();
    };
  }, [connection, fetchNow, schedule]);

  useEffect(() => cancelPending, [cancelPending]);

  return { list, loading, error, refresh: fetchNow };
}
