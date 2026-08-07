import type { ModelSummary } from '../../shared/types';
import { IS_MAC } from '../accel';
import { glyphsFor, type ShortcutId } from '../shortcuts';

// The tip deck for the new-chat screen. One tip shows at a time: a list would
// out-weigh the starter cards and turn the calmest screen in the app into a
// manual, whereas a single rotating line teaches the same set over many new
// chats and costs one row of height.
//
// Data + selection live here as pure functions so the eligibility rules are
// unit-testable without React; EmptyTips.tsx is just the rendering.

export interface TipContext {
  format: 'md' | 'mdx';
  model: ModelSummary | null;
  /** Shortcuts are live in this window — false in Quick Chat, which has no provider. */
  bound: boolean;
}

export interface Tip {
  id: string;
  /** Keycap ahead of the text, taken from BINDINGS so it stays platform-correct. */
  shortcut?: ShortcutId;
  /** Literal keycap, for keys that aren't a bound shortcut (the hold-to-reveal mod key). */
  keys?: string;
  text: string;
  /** Hidden when the thing the tip talks about isn't available right now. */
  when?: (ctx: TipContext) => boolean;
}

const hasFast = (m: ModelSummary | null) => !!m?.serviceTiers.some((t) => t.id === 'priority');

export const TIPS: Tip[] = [
  {
    id: 'hint-mode',
    keys: IS_MAC ? '⌘' : 'Ctrl',
    text: 'Hold the modifier key for a moment and every shortcut on screen labels itself.'
  },
  {
    id: 'note',
    text: 'Start a message with // to file it straight into memory as a note — no reply, no turn.'
  },
  {
    id: 'attach',
    shortcut: 'attach',
    text: 'Attach a file — or just drop one anywhere on the composer.'
  },
  {
    id: 'format',
    shortcut: 'toggle-format',
    text: 'Switch between rich replies and plain Markdown without leaving the chat.'
  },
  {
    id: 'effort',
    shortcut: 'cycle-effort',
    text: 'Cycle reasoning effort when a question deserves more thinking than the last one.',
    when: (c) => (c.model?.supportedEfforts.length ?? 0) > 0
  },
  {
    id: 'speed',
    shortcut: 'toggle-speed',
    text: 'Flip to the Fast tier for 1.5× replies when you are in a hurry.',
    when: (c) => hasFast(c.model)
  },
  {
    id: 'search',
    shortcut: 'focus-chat-search',
    text: 'Jump straight to the search box to find any past conversation.'
  },
  {
    id: 'archive',
    shortcut: 'archive-thread',
    text: 'Archive the thread you are reading and land on the next one waiting.'
  },
  {
    id: 'snooze',
    shortcut: 'snooze-thread',
    text: 'Snooze a thread until you actually want it back — press it again to wake one.'
  },
  {
    id: 'unread',
    shortcut: 'toggle-read',
    text: 'Mark the open thread unread, so the Inbox hands it back to you later.'
  },
  {
    id: 'inspector',
    shortcut: 'toggle-inspector',
    text: 'Hide the side panel when you want the chat to have the whole window.'
  },
  {
    id: 'stop',
    shortcut: 'stop',
    text: 'Stop a reply mid-stream — everything written so far stays put.'
  },
  {
    id: 'learn',
    text: 'After a reply you liked, send /learn to save how it was done as a reusable skill.',
    // Quick Chat wires neither /learn nor the shortcut provider.
    when: (c) => c.bound
  },
  {
    id: 'rich-replies',
    text: 'Replies can carry live charts, quizzes and forms — ask for one and it renders inline.',
    when: (c) => c.format === 'mdx'
  }
];

/**
 * The tips worth showing right now. A tip is dropped when the thing it talks
 * about isn't there — no Fast tier on this model, no effort levels, Markdown
 * mode — and every shortcut tip is dropped in a window where nothing is bound,
 * since advertising a key that does nothing is worse than saying nothing.
 */
export function eligibleTips(ctx: TipContext): Tip[] {
  return TIPS.filter((t) => {
    if ((t.shortcut || t.id === 'hint-mode') && !ctx.bound) return false;
    return t.when ? t.when(ctx) : true;
  });
}

/**
 * The tip at `seq` in the deck. Stepping a counter rather than picking at random
 * is what makes the deck a deck: random repeats itself and never promises to get
 * through the set, while a counter shows every tip before repeating any.
 */
export function tipAt(seq: number, ctx: TipContext): Tip | null {
  const list = eligibleTips(ctx);
  if (list.length === 0) return null;
  // seq only ever grows, but a corrupted stored value shouldn't blank the screen.
  const s = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  return list[((s % list.length) + list.length) % list.length];
}

/** The keycap to render ahead of a tip, or null when it isn't about a key. */
export function tipGlyphs(tip: Tip): string | null {
  return tip.shortcut ? glyphsFor(tip.shortcut) : (tip.keys ?? null);
}
