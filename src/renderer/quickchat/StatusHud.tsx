import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { QuickChatStatus } from '../../shared/types';
import { formatAccelerator } from '../accel';
import chimeUrl from '../assets/chime.wav';

// The bottom-left status pill, shown while the overlay is hidden and a turn runs.
// It only reflects state pushed from the main process (`quickchat:status`); it
// never runs turns itself. Clicking it re-summons the overlay to read the answer.
export function StatusHud() {
  const [status, setStatus] = useState<QuickChatStatus | null>(null);

  useEffect(() => {
    return window.stem.onQuickChatStatus(setStatus);
  }, []);

  // Off-mac finish chime: main has no system sound to spawn there, so it asks
  // this always-alive (hidden, never closed) window to play a bundled asset.
  useEffect(() => {
    return window.stem.onHudPlayChime(() => {
      void new Audio(chimeUrl).play().catch(() => {
        // Best-effort, like the mac afplay path.
      });
    });
  }, []);

  if (!status) return null;
  const finished = status.phase === 'finished';
  // The follow-me pill (reveal === 'main') tracks a main-window thread, so it
  // raises the main window and prompts a plain click; the overlay pill prompts
  // the real summon key when one is bound.
  const toMain = status.reveal === 'main';
  const hint = !toMain && status.shortcut ? `${formatAccelerator(status.shortcut)} open` : 'click to open';

  return (
    <div className="hud-root">
      <button
        className={`hud-pill${finished ? ' finished' : ''}`}
        onClick={() => (toMain ? window.stem.revealMain() : window.stem.revealQuickChat())}
      >
        {finished ? (
          <span className="hud-check" aria-hidden="true">
            <Check size={13} />
          </span>
        ) : (
          <span className="activity-dots" aria-hidden="true">
            <span className="activity-dot" />
            <span className="activity-dot" />
            <span className="activity-dot" />
          </span>
        )}
        <span className="hud-label">{status.label}</span>
        {finished && <span className="hud-hint">{hint}</span>}
      </button>
    </div>
  );
}
