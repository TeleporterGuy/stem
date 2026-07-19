import { useSyncExternalStore } from 'react';
import { EMPTY_STATE, type ThreadState } from '../chatState';

export type ThreadStates = Record<string, ThreadState>;

/**
 * External store for per-thread chat state, shared by the main window and the
 * Quick Chat overlay (each window holds its own instance — the sharing is the
 * code, not the data). Unlike useState, reads are synchronous (`snapshot`/
 * `getThread`), which replaces the ref-mirror pattern both windows used to keep
 * event handlers and IPC continuations off stale closures.
 */
export class SessionStore {
  private states: ThreadStates = {};
  private listeners = new Set<() => void>();

  snapshot(): ThreadStates {
    return this.states;
  }

  getThread(key: string): ThreadState | undefined {
    return this.states[key];
  }

  update(updater: (prev: ThreadStates) => ThreadStates): void {
    const next = updater(this.states);
    if (next === this.states) return;
    this.states = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Patch one thread's slice (functional, so concurrent updates never clobber). */
  patch(key: string, patchFn: (s: ThreadState) => Partial<ThreadState>): void {
    this.update((prev) => {
      const base = prev[key] ?? EMPTY_STATE;
      return { ...prev, [key]: { ...base, ...patchFn(base) } };
    });
  }

  replace(key: string, state: ThreadState): void {
    this.update((prev) => ({ ...prev, [key]: state }));
  }

  remove(key: string): void {
    this.update((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** React binding: re-render on store changes, reading the stable snapshot object. */
export function useThreadStates(store: SessionStore): ThreadStates {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot()
  );
}
