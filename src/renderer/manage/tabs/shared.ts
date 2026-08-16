import { useSyncExternalStore } from 'react';
import type {
  ModelSummary
} from '../../../shared/types';

// Icon-button feedback: a fast local call finishes before the spin animation shows
// a single visible frame, which reads as "nothing happened". Hold the spinning
// state until the animation lands on a whole rotation (cycle length must match
// link-btn-spin in styles.css), so short jobs show one clean turn and longer jobs
// stop without a mid-rotation snap.
const SPIN_CYCLE_MS = 900;
export async function holdFullSpin<T>(work: Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work;
  } finally {
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, SPIN_CYCLE_MS - (elapsed % SPIN_CYCLE_MS)));
  }
}

// A long model-driven job started from a tab (Tidy up, Consolidate) outlives the
// tab that started it: switching tabs unmounts the component, and useState there
// would forget both the spinner and the eventual outcome — the job keeps running
// with no indication, and its result message lands in an unmounted component.
// So each such job gets a module-level store; the component subscribes and just
// renders whatever is true right now, whether or not it watched the job start.
export interface JobState {
  running: boolean;
  /** Outcome of the last finished run, shown under the button until the next run. */
  msg: string | null;
}
export function createJobStore() {
  let state: JobState = { running: false, msg: null };
  const listeners = new Set<() => void>();
  const set = (next: JobState) => {
    state = next;
    for (const l of listeners) l();
  };
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getState: () => state,
    /** For neighbouring actions (e.g. Reset) that report into the same message slot. */
    setMsg(msg: string | null) {
      set({ ...state, msg });
    },
    /**
     * Start the job unless one is already running (a remounted tab resets no
     * state here, so a second click mid-run stays a no-op). `work` must catch
     * its own failures and resolve to the outcome message either way.
     */
    start(work: () => Promise<string | null>) {
      if (state.running) return;
      set({ running: true, msg: null });
      void work().then(
        (msg) => set({ running: false, msg }),
        () => set({ running: false, msg: null })
      );
    }
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
export function useJob(store: JobStore): JobState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export interface ModelTabProps {
  models: ModelSummary[];
  modelId: string | null;
  onSelectModel: (id: string) => void;
}

// Active-facts debug surface, fed from App. Lets the Memory→Facts tab show which
// durable facts this chat injected last turn (and preview the current draft).
export interface ActiveFactsViewProps {
  /** The open chat, or null for a fresh draft (no last-turn set yet). */
  activeThreadId: string | null;
  /** Active chat's running flag — flips drive a refetch of the last injected set. */
  activeRunning: boolean;
  /** Whether draft preview is toggled on (owned by App so it resets on send). */
  previewActive: boolean;
  /** Live draft text, mirrored from the composer while preview is on. */
  previewDraft: string;
  onTogglePreview: () => void;
}
