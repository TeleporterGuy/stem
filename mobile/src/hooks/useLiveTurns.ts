// Which threads are working right now, as React state.
//
// The fold itself is in ../transport/live-turns.ts and is pure; this is the
// twenty lines that wire it to the two sources it needs — the `snapshot` control
// frame, which is the server's whole truth as of the moment the stream opened,
// and every backend event after it.
//
// Snapshot REPLACES rather than merges, deliberately: it is the entire answer,
// so a thread missing from it is settled, not merely unmentioned. Merging would
// leave a spinner spinning on a turn that finished while the phone was asleep,
// which is the exact failure the frame was added to remove.

import { useEffect, useState } from 'react';
import { applyLiveTurnEvent, liveTurnsFromSnapshot, type LiveTurnMap } from '../transport/live-turns';
import { useTransport } from '../transport/provider';

export function useLiveTurns(): LiveTurnMap {
  const { connection } = useTransport();
  const [live, setLive] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const offSnapshot = connection.onLiveTurns((snapshot) => setLive(liveTurnsFromSnapshot(snapshot)));
    // applyLiveTurnEvent returns the SAME map when nothing changed, so a streamed
    // token that adds no information re-renders nothing.
    const offEvent = connection.onBackendEvent((event) => setLive((prev) => applyLiveTurnEvent(prev, event)));
    return () => {
      offSnapshot();
      offEvent();
    };
  }, [connection]);

  return live;
}
