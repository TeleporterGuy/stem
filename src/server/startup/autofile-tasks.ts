import * as activity from '../activity';
import { autoFileSweep } from '../chats/autofile';
import type { ChatSummary } from '../../shared/types';
import type { ChatBackend } from '../backend';

/** How often the sweep looks for chats that have gone idle since the last one. */
const SWEEP_INTERVAL_MS = 30 * 60_000;
/** The first sweep after boot: late enough to stay out of startup's way. */
const FIRST_SWEEP_MS = 5 * 60_000;

/**
 * Filing idle chats into folders (Settings → App → File idle chats into
 * folders; see server/chats/autofile.ts for the policy). A sweep shortly
 * after boot, then one every half hour. Opportunistic like the recall passes:
 * it skips a tick while the user is busy, and stops mid-sweep when they come
 * back, leaving the rest for the next tick.
 */
export function initAutoFileTasks(deps: {
  runtime: () => ChatBackend;
  /** True while a turn runs on either surface or the user interacted within `idleMs`. */
  busyWithin: (idleMs: number) => boolean;
  /** The chats the chat list shows — mail sessions and scheduled-run threads already out. */
  listChats: () => Promise<ChatSummary[]>;
  /** A chat moved: the clients re-read the list. */
  onFiled: (threadId: string) => void;
}): void {
  let sweeping = false;
  const runSweep = async (): Promise<void> => {
    if (sweeping || deps.busyWithin(30_000)) return;
    sweeping = true;
    try {
      // The detail names the chats and where they went: a move the user didn't
      // make, and the activity feed is the one place that says it happened.
      await activity.track(
        'chats.autoFile',
        'Filing idle chats',
        () =>
          autoFileSweep({
            // Not priority: nobody is waiting on this.
            complete: (prompt, opts) => deps.runtime().complete(prompt, opts),
            listChats: deps.listChats,
            readMessages: async (id) => (await deps.runtime().readThread(id)).messages,
            onFiled: deps.onFiled,
            shouldYield: () => deps.busyWithin(30_000)
          }),
        (r) => ({
          worked: r.filed.length > 0,
          detail: r.filed.map((f) => `${f.title} → ${f.folder}`).join('; ')
        })
      );
    } catch {
      // quiet: autoFileSweep never throws, and track() would have failed the row.
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void runSweep(), FIRST_SWEEP_MS);
  setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
}
