import type { ConnectedFolder } from '../../shared/types';
import { isRecallEnabled } from '../workspace/memory';
import { readSettings } from '../workspace/settings';
import { learnAllIndexedFolders, scanAllIndexedFolders } from '../folder-index';
import type { LlmClient } from '../recall/llm';
import type { ChatBackend } from '../backend';

export interface FolderIndexTasks {
  /** Debounced scan+embed pass over every indexed connected folder. */
  scheduleFolderIndexScan: (delayMs?: number) => void;
  /** Debounced doc-distill drain over folders in 'new'/'all' learn mode. */
  scheduleFolderLearn: (delayMs?: number) => void;
}

/** How often the periodic rescan looks for changed/removed files. */
const RESCAN_INTERVAL_MS = 15 * 60_000;

/**
 * Background indexing of indexed connected folders: a startup kick, a
 * low-frequency periodic rescan (mirror folders change from outside the app —
 * an editor, a sync tool), and a schedule hook for "index just toggled on".
 * Scans are incremental (mtime/size cursor in each folder's index DB) and
 * internally re-entrancy-guarded, so overlapping kicks are cheap no-ops. Like
 * the other maintenance passes they yield to interactive work via busyWithin.
 *
 * Fact learning chains after each scan: folders in 'new'/'all' learn mode
 * drain their pending docs through hidden one-shot completions on the folder's
 * model (falling back to the Settings → Memory model), yielding to interactive
 * work between batches.
 */
export function initFolderIndexTasks(deps: {
  runtime: () => ChatBackend;
  /** True while a turn runs on either surface or the user interacted within `idleMs`. */
  busyWithin: (idleMs: number) => boolean;
}): FolderIndexTasks {
  let timer: NodeJS.Timeout | null = null;
  let learnTimer: NodeJS.Timeout | null = null;

  // Model read fresh per call, so a Settings/folder change applies to the next
  // batch — the same pattern as the recall/skills LlmClients.
  const makeLlm = (folder: ConnectedFolder): LlmClient => ({
    complete: async (prompt) =>
      deps.runtime().complete(prompt, { model: folder.learnModel ?? (await readSettings()).memory.model })
  });

  const scheduleFolderLearn = (delayMs = 5_000): void => {
    if (!isRecallEnabled()) return;
    if (learnTimer) clearTimeout(learnTimer);
    learnTimer = setTimeout(() => {
      if (deps.busyWithin(30_000)) {
        scheduleFolderLearn(60_000);
        return;
      }
      void learnAllIndexedFolders({
        makeLlm,
        shouldYield: () => deps.busyWithin(30_000)
      }).then((yielded) => {
        if (yielded) scheduleFolderLearn(60_000);
      });
    }, delayMs);
  };

  const scheduleFolderIndexScan = (delayMs = 2_000): void => {
    if (!isRecallEnabled()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (deps.busyWithin(30_000)) {
        scheduleFolderIndexScan(30_000);
        return;
      }
      // Learning follows every scan — a fresh scan is what surfaces new/changed
      // docs as pending, and the drain no-ops when nothing is.
      void scanAllIndexedFolders().then(() => scheduleFolderLearn(2_000));
    }, delayMs);
  };

  scheduleFolderIndexScan(30_000);
  setInterval(() => scheduleFolderIndexScan(1_000), RESCAN_INTERVAL_MS);

  return { scheduleFolderIndexScan, scheduleFolderLearn };
}
