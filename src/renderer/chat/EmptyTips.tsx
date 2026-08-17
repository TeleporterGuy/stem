import { useEffect, useState } from 'react';
import { Lightbulb, RotateCw } from 'lucide-react';
import { Kbd, useShortcutsBound } from '../shortcuts';
import { useRemoteServer } from '../hooks/useRemoteServer';
import { eligibleTips, tipAt } from './tips';

// Where in the deck to open. Persisted so the rotation keeps advancing across
// restarts instead of replaying the first few tips every launch — renderer-local
// view state, like the other `stem.*` keys.
const SEQ_KEY = 'stem.tipSeq';

function readSeq(): number {
  try {
    const n = Number(localStorage.getItem(SEQ_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** One rotating tip under the new-chat starter cards. See ./tips for the deck. */
export function EmptyTips({ format }: { format: 'md' | 'mdx' }) {
  const bound = useShortcutsBound();
  // Which of the two "where your tools run" tips is the true one here. It lands
  // a frame late on a remote client (see the hook), which at worst shows the
  // local wording once on a screen that is about to re-render anyway.
  const remote = useRemoteServer();
  // Mounted with the empty state only, so the deck steps once per *new chat*
  // rather than once per chat opened.
  const [seq, setSeq] = useState(() => readSeq() + 1);

  useEffect(() => {
    try {
      localStorage.setItem(SEQ_KEY, String(seq));
    } catch {
      /* storage disabled — the tip still rotates for the rest of this session */
    }
  }, [seq]);

  const ctx = { format, bound, remote };
  const tip = tipAt(seq, ctx);
  if (!tip) return null;

  return (
    <div className="empty-tip">
      <Lightbulb className="empty-tip-icon" size={13} aria-hidden="true" />
      <p>
        {tip.keys && <Kbd glyphs={tip.keys} />}
        {tip.text}
      </p>
      {eligibleTips(ctx).length > 1 && (
        <button
          type="button"
          className="empty-tip-next"
          onClick={() => setSeq((s) => s + 1)}
          title="Another tip"
          aria-label="Another tip"
        >
          <RotateCw size={13} />
        </button>
      )}
    </div>
  );
}
