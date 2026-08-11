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
import { SHORTCUTS, chordFor, keycapFor, type Chord, type ShortcutId } from '../shared/shortcut-defs';

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

// Which shortcuts exist, what they are called, and which keys they use all live in
// ../shared/shortcut-defs — the platform-neutral table the docs page is generated
// from. This module is the half that needs a browser: keydown predicates, the
// IS_MAC keycaps, and the React plumbing around them.
export type { ShortcutId };

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
// The literal Control key. On macOS ⌃ is a modifier of its own, so this is not
// `mod`; off macOS the two are the same key and the two predicates coincide.
const control = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey;
const isKey = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

/**
 * The keydown predicate for a chord. A chord that leaves `shift` unset ignores the
 * Shift state — see the field's note in shortcut-defs; every other modifier must
 * match exactly, so AltGr typing and Super combos never trigger a shortcut.
 */
const matcher =
  (chord: Chord) =>
  (e: KeyboardEvent): boolean => {
    if (!(chord.mod ? mod(e) : control(e))) return false;
    if (chord.shift !== undefined && e.shiftKey !== chord.shift) return false;
    return isKey(e, chord.key.toLowerCase());
  };

// Every mod-key shortcut, resolved for the platform this renderer is running on:
// the shared table supplies the keys and the keycap text, this file supplies the
// predicate that reads a real keydown.
export const BINDINGS: Binding[] = SHORTCUTS.map((def) => ({
  id: def.id,
  glyphs: keycapFor(def, IS_MAC),
  match: def.bound === false ? null : matcher(chordFor(def, IS_MAC))
}));

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
