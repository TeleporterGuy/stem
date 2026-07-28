import { useEffect, useState } from 'react';
import type { ActiveFacts } from '../../shared/types';

// What Stem remembered for this chat's last turn, and nothing else.
//
// Recall is the reason Stem is worth reaching from a phone at all, and the one
// question a phone answer raises that a desk answer does not is "did it actually
// use what it knows about me?". This answers that and stops: no pinning, no
// forgetting, no conflict resolution — those are destructive, hard to undo on a
// phone, and were kept at the desk by explicit decision.
//
// It is also deliberately out of the way: a disclosure behind a header button
// rather than a panel on screen, closed by default, re-read when the turn that
// might change it finishes.

export function MemoryPeek({ threadId, running }: { threadId: string; running: boolean }) {
  const [facts, setFacts] = useState<ActiveFacts | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // The active set is written at turn start, so a running→idle flip means a fresh
  // one is on disk; re-reading on that edge is what the desktop's Memory tab does.
  useEffect(() => {
    let cancelled = false;
    window.stem
      .getActiveFacts(threadId)
      .then((result) => {
        if (cancelled) return;
        setFacts(result);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, running]);

  const items = facts?.facts ?? [];

  return (
    <div className="m-memory" role="region" aria-label="Memory used in this chat">
      {state === 'loading' && <p className="m-memory-note">Reading what was used…</p>}
      {state === 'failed' && <p className="m-memory-note">Couldn’t read what memory was used.</p>}
      {state === 'ready' && items.length === 0 && (
        <p className="m-memory-note">Nothing from memory was used in this chat’s last turn.</p>
      )}
      {items.length > 0 && (
        <>
          <ul className="m-memory-list">
            {items.map((fact) => (
              <li key={fact.id}>
                <span className="m-memory-text">{fact.text}</span>
                {fact.reason && <span className="m-memory-why">{fact.reason}</span>}
                {fact.disputed && <span className="m-memory-why disputed">conflicting</span>}
              </li>
            ))}
          </ul>
          <p className="m-memory-note">Read-only here — pin or forget a fact on your Mac.</p>
        </>
      )}
    </div>
  );
}
