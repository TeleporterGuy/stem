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
