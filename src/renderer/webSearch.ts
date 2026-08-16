// The web-search switch, shared by every control that flips it: the composer
// button in the main window, the one in Quick Chat, and the Settings checkboxes.
//
// There is no separate "default" to remember — the two per-surface settings ARE
// the remembered position. The server reads `webSearch.main` / `webSearch.quickChat`
// when a turn starts (src/server/index.ts), so a click here decides the next turn
// and still stands after a restart, whether it came from the composer or Settings.
// That is also why Quick Chat can be left off while main stays on.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebSearchSettings } from '../shared/types';

/** Which of the two independent switches a control edits. */
export type WebSearchSurface = 'main' | 'quickChat';

/** Just the two per-surface flags — the backend/credential fields never matter here. */
type Flags = Pick<WebSearchSettings, 'main' | 'quickChat'>;

// A window-local nudge so the composer button and the Settings checkbox — same
// renderer, two copies of one boolean — can't disagree after either is clicked.
// Across windows the settings file is the channel: each window re-reads on focus,
// which for Quick Chat is the moment it is summoned.
const EVENT = 'stem:web-search';

/** Tell the rest of this window that the flags just changed. */
export function broadcastWebSearch(flags: Flags): void {
  window.dispatchEvent(new CustomEvent<Flags>(EVENT, { detail: flags }));
}

/**
 * Keep a Settings pane's own copy of the flags in step with the composer buttons,
 * which sit in the same window and write the same two booleans.
 */
export function useWebSearchSync(apply: (flags: Flags) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const onChanged = (e: Event) => applyRef.current((e as CustomEvent<Flags>).detail);
    window.addEventListener(EVENT, onChanged as EventListener);
    return () => window.removeEventListener(EVENT, onChanged as EventListener);
  }, []);
}

/**
 * The switch for one surface: its current position, and a setter that persists.
 * `reload` is exposed for windows with their own "I'm visible again" signal.
 */
export function useWebSearch(surface: WebSearchSurface) {
  // Optimistic until the first read lands — matches the shipped default, so the
  // button doesn't flicker off-then-on for the majority who leave search on.
  const [enabled, setEnabled] = useState(true);

  const reload = useCallback(() => {
    if (!window.stem) return;
    window.stem
      .getSettings()
      .then((s) => setEnabled(s.webSearch[surface]))
      .catch(() => undefined);
  }, [surface]);

  useEffect(() => {
    reload();
    const onChanged = (e: Event) => setEnabled((e as CustomEvent<Flags>).detail[surface]);
    window.addEventListener('focus', reload);
    window.addEventListener(EVENT, onChanged as EventListener);
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener(EVENT, onChanged as EventListener);
    };
  }, [reload, surface]);

  const toggle = useCallback(
    (next: boolean) => {
      setEnabled(next); // paint it immediately; the write is a round trip to the server
      window.stem
        .updateWebSearch({ [surface]: next })
        .then((s) => {
          setEnabled(s.webSearch[surface]);
          broadcastWebSearch(s.webSearch);
        })
        .catch(() => reload()); // write failed — show what is actually saved
    },
    [surface, reload]
  );

  return { enabled, toggle, reload };
}
