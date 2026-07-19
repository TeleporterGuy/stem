import { useRef } from 'react';

/**
 * Return the previous object identity when the new one is shallow-equal. Used
 * for derived maps rebuilt on every store change (e.g. per-thread status dots)
 * whose values only change at turn boundaries — keeping the identity stable is
 * what lets a memoized consumer skip the per-frame streaming re-renders.
 */
export function useShallowStable<T extends Record<string, unknown>>(next: T): T {
  const prevRef = useRef(next);
  const prev = prevRef.current;
  if (prev !== next) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    const equal =
      prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k]);
    if (!equal) prevRef.current = next;
  }
  return prevRef.current;
}
