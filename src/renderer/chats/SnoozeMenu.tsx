import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MORNING_HOUR, SNOOZE_PRESETS, formatWake } from '../../shared/inbox';

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
  /** Opened by keyboard: take focus, so the picker can be finished without a mouse. */
  autoFocus?: boolean;
  onPick: (until: number) => void;
  onClose: () => void;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "HH:MM" for an <input type="time"> value. */
function toTimeValue(hour: number, minute = 0): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Midnight on the 1st of the month `d` falls in. */
function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * The 6×7 grid for a month, Monday-first, padded with the neighbouring months'
 * days so every row is full.
 *
 * Monday-first because the presets already are — "Next week" means Monday, and a
 * grid that started on Sunday would put that preset's day in a different column
 * from where the eye learned to find it. Six rows always, so the popover doesn't
 * change height as you page through months.
 */
function monthGrid(month: Date): Date[] {
  const first = monthStart(month);
  const lead = (first.getDay() + 6) % 7; // Sunday(0) sits at the end of the row
  const start = new Date(first);
  start.setDate(first.getDate() - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function SnoozeMenu({ x, y, count, autoFocus, onPick, onClose }: SnoozeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Which month the calendar is showing, or null while the presets are up.
  const [month, setMonth] = useState<Date | null>(null);
  // The hour a picked day lands on. Pre-filled with the same 9am the presets
  // use, so the common case — "some particular day, whenever" — is one click on
  // a day and nothing else.
  const [time, setTime] = useState(() => toTimeValue(MORNING_HOUR));
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
  }, [x, y, month]);

  useEffect(() => {
    const close = () => onClose();
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [onClose]);

  // Opened from the keyboard there is no pointer to finish the pick with, so the
  // first preset takes focus and the menu becomes arrow-navigable. The custom
  // step focuses its own input, so only claim focus for the preset list.
  useEffect(() => {
    if (autoFocus && month === null) ref.current?.querySelector('button')?.focus();
  }, [autoFocus, month]);

  /**
   * Arrows walk whichever step is showing; Escape backs out of the calendar
   * first, then the whole popover.
   *
   * The two steps are different shapes, so they navigate differently: the preset
   * list is one column (↑/↓ by one), the calendar is a week grid (←/→ by a day,
   * ↑/↓ by a week). Walking the calendar one button at a time with ↓ would take
   * seven presses to move down a row, which is not what a grid means.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (month !== null) setMonth(null);
      else onClose();
      return;
    }
    const grid = month !== null;
    const step =
      e.key === 'ArrowDown' ? (grid ? 7 : 1) : e.key === 'ArrowUp' ? (grid ? -7 : -1) : null;
    const sideways = grid ? (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : null) : null;
    const delta = step ?? sideways;
    if (delta === null) return;
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(
        grid ? '.snooze-day:not(:disabled)' : 'button'
      ) ?? [])
    ];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    // Nothing in the grid focused yet (arriving from the time field): start at
    // the first day you're allowed to pick rather than jumping into the middle.
    if (at === -1) {
      items[0].focus();
      return;
    }
    items[(at + delta + items.length) % items.length].focus();
  };

  /** Snooze to `day` at the chosen time, or nothing if that instant has passed. */
  const pickDay = (day: Date) => {
    const [h, m] = time.split(':').map(Number);
    const at = new Date(day);
    at.setHours(h || 0, m || 0, 0, 0);
    if (at.getTime() <= Date.now()) return;
    onPick(at.getTime());
  };

  return (
    <div
      ref={ref}
      className="ctx-menu snooze-menu"
      style={{ left: pos?.x ?? x, top: pos?.y ?? y }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="ctx-label">{count > 1 ? `Snooze ${count} threads until` : 'Snooze until'}</div>
      {month === null ? (
        <>
          {SNOOZE_PRESETS
            // Presets collide on some days — on a Friday, "Tomorrow" and "This
            // weekend" are the same 9am; on a Sunday, "Tomorrow" and "Next
            // week". Offering both is a choice that isn't one.
            .map((preset) => ({ preset, at: preset.at(new Date(now)).getTime() }))
            .filter(({ at }, i, all) => all.findIndex((o) => o.at === at) === i)
            .map(({ preset, at }) => (
              <button key={preset.id} className="snooze-preset" onClick={() => onPick(at)}>
                {preset.label}
                <span className="snooze-when">{formatWake(at, now)}</span>
              </button>
            ))}
          <div className="ctx-sep" />
          <button onClick={() => setMonth(monthStart(new Date(now)))}>Pick a date…</button>
        </>
      ) : (
        <SnoozeCalendar
          month={month}
          now={now}
          time={time}
          onMonth={setMonth}
          onTime={setTime}
          onPickDay={pickDay}
        />
      )}
    </div>
  );
}

/**
 * The custom step: a month you can page through, where clicking a day snoozes to
 * it — no second button to press.
 *
 * This replaces a single `datetime-local` input, which was the wrong control in
 * three ways. It collapsed to an unreadable sliver in a popover this narrow; its
 * calendar opened as a native window over the app, so picking a date left you
 * back in a menu that still wanted a click on "Snooze"; and it asked for a
 * minute-precise timestamp when almost every real answer is a day.
 *
 * So the day is the commit, and the time is a rider on it with the presets' own
 * 9am already filled in. Days whose chosen instant has already passed are
 * disabled rather than hidden — a calendar missing its first fortnight reads as
 * broken, and greying them out says the same thing without the confusion.
 */
function SnoozeCalendar({
  month,
  now,
  time,
  onMonth,
  onTime,
  onPickDay
}: {
  month: Date;
  now: number;
  time: string;
  onMonth: (month: Date) => void;
  onTime: (time: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const [h, m] = time.split(':').map(Number);
  const days = monthGrid(month);
  const shiftMonth = (by: number) => onMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  // Focus the first pickable day on open, so the grid is arrow-navigable at once.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>('.snooze-day:not(:disabled)')?.focus();
    // Only on entry, not on every month page — paging would otherwise yank
    // focus off the chevron you just pressed and back onto the 1st.
  }, []);

  return (
    <div className="snooze-cal">
      <div className="snooze-cal-head">
        <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          <ChevronLeft size={13} />
        </button>
        <span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="snooze-cal-week">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="snooze-cal-grid" ref={gridRef}>
        {days.map((day) => {
          const at = new Date(day);
          at.setHours(h || 0, m || 0, 0, 0);
          const past = at.getTime() <= now;
          const outside = day.getMonth() !== month.getMonth();
          // Marked so there is still an anchor once you have paged away from
          // this month — the greyed-out past only locates today while you can
          // see where it stops.
          const today = day.toDateString() === new Date(now).toDateString();
          return (
            <button
              key={day.getTime()}
              type="button"
              className={`snooze-day${outside ? ' outside' : ''}${today ? ' today' : ''}`}
              disabled={past}
              aria-label={day.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric'
              })}
              onClick={() => onPickDay(day)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
      <label className="snooze-cal-time">
        <span>at</span>
        <input type="time" value={time} aria-label="Wake time" onChange={(e) => onTime(e.target.value)} />
      </label>
    </div>
  );
}
