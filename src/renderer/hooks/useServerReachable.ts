import { useEffect, useState } from 'react';

// Whether Stem's server is answering right now.
//
// Distinct from useRemoteServer(), which asks whether the server is on another
// machine — a fact settled at launch that never moves. This one moves: a train
// goes into a tunnel, a laptop lid closes, a container rolls. When it is false
// the window is running on the client's own read-only cache (see
// src/desktop/offline-cache.ts): chats can be read, nothing can be sent, and
// anything that only exists on the server says so rather than rendering an empty
// state that reads as "you have none of these".
//
// Shared across every component that asks, because they must never disagree —
// a banner saying "offline" over a composer that still accepts typing is worse
// than either alone. One subscription, one answer, fanned out.

/** null until the first answer lands; assume connected until told otherwise. */
let reachable: boolean | null = null;
const listeners = new Set<(value: boolean) => void>();
let subscribed = false;

function publish(value: boolean): void {
  if (reachable === value) return;
  reachable = value;
  for (const listener of listeners) listener(value);
}

/**
 * Ask once, then listen. The ask is not redundant with the push: the first
 * transition can happen before this window exists — a launch with no network
 * discovers it while fetching the channel list, which is the first thing a
 * launch does — and a push into a window that is not there yet is a push nobody
 * hears. The push is what keeps it current afterwards.
 */
function subscribe(): void {
  if (subscribed || !window.stem) return;
  subscribed = true;
  window.stem.onConnectionChanged(publish);
  void window.stem
    .connectionState()
    .then((state) => publish(state.reachable))
    .catch(() => undefined);
}

/** True when Stem cannot reach its server, and the window is reading from cache. */
export function useOffline(): boolean {
  const [value, setValue] = useState(reachable === false);
  useEffect(() => {
    subscribe();
    const listener = (next: boolean): void => setValue(!next);
    listeners.add(listener);
    // A subscription that mounts after the answer already landed still needs it.
    if (reachable !== null) setValue(!reachable);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
