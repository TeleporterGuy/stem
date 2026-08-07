import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

import { IS_MAC } from './accel';

// Mod-key shortcuts + the "hold the mod key to reveal" helper. The mod key is
// ⌘ (metaKey) on macOS and Ctrl elsewhere.
//
// Two behaviors share one keydown listener:
//   1. A bound combo (e.g. ⌘N / Ctrl+N) fires its handler immediately, on any press.
//   2. The mod key held *alone* for HINT_DELAY ms flips on `hintMode`, which makes
//      each <ShortcutHint> render a keycap next to its control. A real shortcut
//      press, any other key, mod-up, or window blur cancels it — so a quick combo
//      never flashes the hints.
//
// `ChatView` is reused in the Quick Chat window, which has no provider; the default
// context is a no-op so the hook/components degrade silently there (no badges).

export type ShortcutId =
  | 'new-conversation'
  | 'toggle-inspector'
  | 'cycle-effort'
  | 'toggle-speed'
  | 'toggle-format'
  | 'attach'
  | 'stop'
  | 'delete-thread'
  | 'focus-chat-search'
  | 'send';

interface Binding {
  id: ShortcutId;
  /** Keycap glyphs shown in the hint. */
  glyphs: string;
  /** Predicate over a keydown, or null for display-only bindings (e.g. Enter/Send). */
  match: ((e: KeyboardEvent) => boolean) | null;
}

// The platform mod key: ⌘ on macOS, Ctrl elsewhere — each exclusive of the other.
const mod = (e: KeyboardEvent) =>
  IS_MAC ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey;
const isKey = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

/** Hint keycap for a mod-key combo: '⌘N' / '⌘⇧F' on mac, 'Ctrl+N' / 'Ctrl+Shift+F' elsewhere. */
const cap = (key: string, shift = false) =>
  IS_MAC ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;

// Single source of truth for every mod-key shortcut and its hint glyphs.
export const BINDINGS: Binding[] = [
  { id: 'new-conversation', glyphs: cap('N'), match: (e) => mod(e) && !e.shiftKey && isKey(e, 'n') },
  { id: 'toggle-inspector', glyphs: cap('\\'), match: (e) => mod(e) && isKey(e, '\\') },
  { id: 'cycle-effort', glyphs: cap('E'), match: (e) => mod(e) && !e.shiftKey && isKey(e, 'e') },
  { id: 'toggle-speed', glyphs: cap('F', true), match: (e) => mod(e) && e.shiftKey && isKey(e, 'f') },
  { id: 'toggle-format', glyphs: cap('M', true), match: (e) => mod(e) && e.shiftKey && isKey(e, 'm') },
  { id: 'attach', glyphs: cap('U'), match: (e) => mod(e) && !e.shiftKey && isKey(e, 'u') },
  { id: 'focus-chat-search', glyphs: cap('F'), match: (e) => mod(e) && !e.shiftKey && isKey(e, 'f') },
  { id: 'stop', glyphs: cap('.'), match: (e) => mod(e) && isKey(e, '.') },
  // mac: Control (not ⌘) — the only ctrl-based mac binding; no hold-⌘ hint anchors
  // it. Elsewhere Ctrl+X must keep meaning "cut", so deletion moves to Ctrl+Shift+X.
  IS_MAC
    ? { id: 'delete-thread', glyphs: '⌃X', match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && isKey(e, 'x') }
    : {
        id: 'delete-thread',
        glyphs: 'Ctrl+Shift+X',
        match: (e) => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && isKey(e, 'x')
      },
  { id: 'send', glyphs: IS_MAC ? '⏎' : 'Enter', match: null }
];

/** Keycap glyphs for a binding, already platform-formatted ('⌘N' / 'Ctrl+N'). */
export function glyphsFor(id: ShortcutId): string | null {
  return BINDINGS.find((b) => b.id === id)?.glyphs ?? null;
}

type Handler = () => void;

interface ShortcutsCtx {
  /** False under the default context — i.e. no provider, so no shortcut works here. */
  bound: boolean;
  hintMode: boolean;
  register: (id: ShortcutId, handler: Handler) => void;
  unregister: (id: ShortcutId) => void;
}

const NOOP: ShortcutsCtx = {
  bound: false,
  hintMode: false,
  register: () => {},
  unregister: () => {}
};

const Ctx = createContext<ShortcutsCtx>(NOOP);

const HINT_DELAY = 1200;
/** The hold-to-reveal key: the bare mod key itself (⌘ on mac, Ctrl elsewhere). */
const HINT_KEY = IS_MAC ? 'Meta' : 'Control';

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [hintMode, setHintMode] = useState(false);
  const handlers = useRef(new Map<ShortcutId, Handler>());
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    const dismiss = () => {
      clearTimer();
      setHintMode(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A full combo fires its handler regardless of hint state, and cancels any
      // pending reveal so the badges don't flash after the action.
      for (const b of BINDINGS) {
        if (b.match && b.match(e)) {
          const h = handlers.current.get(b.id);
          if (h) {
            e.preventDefault();
            h();
          }
          dismiss();
          return;
        }
      }
      if (e.key === HINT_KEY) {
        // Mod key down alone — arm the delayed reveal once (ignore auto-repeat).
        if (!e.repeat && timer.current === null) {
          timer.current = window.setTimeout(() => setHintMode(true), HINT_DELAY);
        }
      } else {
        // Any other key means the user is committing to something — hide hints.
        dismiss();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === HINT_KEY) dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', dismiss);
      clearTimer();
    };
  }, [clearTimer]);

  const register = useCallback((id: ShortcutId, h: Handler) => {
    handlers.current.set(id, h);
  }, []);
  const unregister = useCallback((id: ShortcutId) => {
    handlers.current.delete(id);
  }, []);

  const api = useMemo<ShortcutsCtx>(
    () => ({ bound: true, hintMode, register, unregister }),
    [hintMode, register, unregister]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Register a handler for a bound shortcut. The latest closure is always called. */
export function useShortcut(id: ShortcutId, handler: Handler) {
  const { register, unregister } = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    register(id, () => ref.current());
    return () => unregister(id);
  }, [id, register, unregister]);
}

/**
 * Whether shortcuts are live in this window. False in Quick Chat, which mounts no
 * provider — so surfaces that *advertise* shortcuts (rather than merely decorating
 * a control that works either way) can stay quiet there.
 */
export function useShortcutsBound(): boolean {
  return useContext(Ctx).bound;
}

/** A keycap, e.g. ⌘N. */
export function Kbd({ glyphs }: { glyphs: string }) {
  return <span className="kbd">{glyphs}</span>;
}

/**
 * A floating keycap anchored to its (position: relative) host control, shown only
 * while ⌘ is held long enough to enter hint mode.
 */
export function ShortcutHint({ id, placement = 'tr' }: { id: ShortcutId; placement?: 'tr' | 'br' }) {
  const { hintMode } = useContext(Ctx);
  const binding = BINDINGS.find((b) => b.id === id);
  if (!hintMode || !binding) return null;
  return (
    <span className={`sc-hint sc-${placement}`} aria-hidden="true">
      <Kbd glyphs={binding.glyphs} />
    </span>
  );
}
