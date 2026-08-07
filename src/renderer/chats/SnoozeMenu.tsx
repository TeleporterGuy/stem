import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SNOOZE_PRESETS, formatWake } from '../../shared/inbox';

// The snooze popover: four presets that each show the instant they resolve to,
// plus a custom step. Rendered as a .ctx-menu so it inherits the same surface,
// shadow and stacking rung as the chat list's right-click menu — a second
// floating menu vocabulary in the same panel would read as a different app.

export interface SnoozeMenuProps {
  /** Anchor in viewport coordinates (the click that opened it). */
  x: number;
  y: number;
  /** How many threads this snooze will apply to — the bulk case says so. */
  count: number;
  onPick: (until: number) => void;
  onClose: () => void;
}

/** Local datetime string for an <input type="datetime-local"> value. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function SnoozeMenu({ x, y, count, onPick, onClose }: SnoozeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  // Resolved once when the menu opens: the labels must not drift under the
  // pointer while it's on screen.
  const [now] = useState(() => Date.now());

  // Keep the menu inside the window, the way the chat list's context menu does.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad))
    });
  }, [x, y, custom]);

  useEffect(() => {
    const close = () => onClose();
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [onClose]);

  const commitCustom = () => {
    if (!custom) return;
    const at = new Date(custom).getTime();
    // A time already past would snooze to nothing; treat it as a no-op.
    if (Number.isNaN(at) || at <= Date.now()) return;
    onPick(at);
  };

  return (
    <div
      ref={ref}
      className="ctx-menu snooze-menu"
      style={{ left: pos?.x ?? x, top: pos?.y ?? y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ctx-label">{count > 1 ? `Snooze ${count} threads until` : 'Snooze until'}</div>
      {custom === null ? (
        <>
          {SNOOZE_PRESETS
            // Presets collide on some days — on a Friday, "Tomorrow" and "This
            // weekend" are the same 9am. Offering both is a choice that isn't one.
            .map((preset) => ({ preset, at: preset.at(new Date(now)).getTime() }))
            .filter(({ at }, i, all) => all.findIndex((o) => o.at === at) === i)
            .map(({ preset, at }) => (
              <button key={preset.id} onClick={() => onPick(at)}>
                {preset.label}
                <span className="snooze-when">{formatWake(at, now)}</span>
              </button>
            ))}
          <div className="ctx-sep" />
          <button
            onClick={() =>
              // Seed with tomorrow morning so the field is never empty on open.
              setCustom(toLocalInputValue(SNOOZE_PRESETS[1].at(new Date(now))))
            }
          >
            Pick date &amp; time…
          </button>
        </>
      ) : (
        <div className="snooze-custom">
          <input
            type="datetime-local"
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitCustom();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <button className="link-btn" onClick={commitCustom}>
            Snooze
          </button>
        </div>
      )}
    </div>
  );
}
