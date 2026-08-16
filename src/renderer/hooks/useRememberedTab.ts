import { useCallback, useState } from 'react';

/**
 * A tab choice that outlives the panel it belongs to.
 *
 * The manage panel renders one tab at a time, so every sub-tab unmounts the
 * moment you look at something else — plain state drops you back on the first
 * sub-tab every single time you come back. That is fine for a two-way switch
 * you always want to land on the same side of; it is not fine once a tab has
 * four sub-tabs and you are working in the fourth.
 *
 * Renderer-local, like the composer's per-turn picks: which tab you were on is
 * a view preference, not something the server or another device needs. Storage
 * that refuses to answer (a locked-down quota, private mode) costs you the
 * memory, never the tab switch.
 */
export function useRememberedTab<T extends string>(
  key: string,
  values: readonly T[],
  fallback: T
): [T, (next: T) => void] {
  const [tab, setTabState] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      // Validated against the current tab list, not trusted: a renamed or
      // removed tab must not leave the panel rendering nothing.
      return saved && (values as readonly string[]).includes(saved) ? (saved as T) : fallback;
    } catch {
      return fallback;
    }
  });

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Not worth failing a tab switch over.
      }
    },
    [key]
  );

  return [tab, setTab];
}
