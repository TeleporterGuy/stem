import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InboxEntry, InboxState } from '../../shared/inbox';
import { toMs } from '../../shared/inbox';
import { inboxStorePath } from './paths';

// The Stem-owned inbox store: per-thread read / archived / snoozed state for the
// Chats panel's Inbox mode. Same shape as the chat-folder store next door —
// serialized read-modify-write, atomic temp+rename, and a corrupt file degrading
// to "everything is in the Inbox and read" rather than breaking the app.
//
// What it does NOT hold is any notion of *when* a thread last changed: that is
// the backend session file's mtime, which arrives on each ChatSummary. Archive
// and snooze are stored as the instant the user acted, and the renderer compares
// the two — see src/shared/inbox.ts for why that gives resurrection for free.

interface InboxFile extends InboxState {
  version: 1;
}

function coerceEntry(raw: unknown): InboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const entry: InboxEntry = {};
  const readAt = num(r.readAt);
  if (readAt !== undefined) entry.readAt = readAt;
  const archivedAt = num(r.archivedAt);
  if (archivedAt !== undefined) entry.archivedAt = archivedAt;
  const snoozedAt = num(r.snoozedAt);
  if (snoozedAt !== undefined) entry.snoozedAt = snoozedAt;
  const snoozedUntil = num(r.snoozedUntil);
  if (snoozedUntil !== undefined) entry.snoozedUntil = snoozedUntil;
  if (r.forcedUnread === true) entry.forcedUnread = true;
  return Object.keys(entry).length ? entry : null;
}

function coerce(parsed: unknown, fallbackBaseline: number): InboxFile {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const entries: Record<string, InboxEntry> = {};
  if (raw.entries && typeof raw.entries === 'object') {
    for (const [threadId, value] of Object.entries(raw.entries as Record<string, unknown>)) {
      const entry = coerceEntry(value);
      if (entry) entries[threadId] = entry;
    }
  }
  return {
    version: 1,
    baseline:
      typeof raw.baseline === 'number' && Number.isFinite(raw.baseline) ? raw.baseline : fallbackBaseline,
    entries
  };
}

// Serialize writes through a promise chain so concurrent IPC calls can't
// interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeFileAtomic(store: InboxFile): Promise<void> {
  const path = inboxStorePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  // rename is atomic on the same volume — readers never see a half-written file.
  await rename(tmp, path);
}

/**
 * Read the store, creating it on first use.
 *
 * The creating write is what makes the Inbox a clean slate on upgrade: `baseline`
 * is stamped once, and every thread whose last activity predates it counts as
 * already read. Without it, the first launch would mark every thread you have
 * ever created unread — a badge count nobody can burn down, which is how a new
 * unread indicator gets ignored forever.
 */
export function readInbox(): Promise<InboxState> {
  return enqueue(async () => {
    try {
      return coerce(JSON.parse(await readFile(inboxStorePath(), 'utf8')), 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const fresh = coerce({}, Date.now());
        await writeFileAtomic(fresh).catch(() => undefined);
        return fresh;
      }
      // Corrupt/unreadable: degrade to "everything in the Inbox, nothing unread"
      // rather than throwing. Baseline 0 would flag every thread unread, so keep
      // the clean-slate promise by treating now as the baseline.
      return coerce({}, Date.now());
    }
  });
}

/** Read, mutate, persist atomically. All public mutators funnel through here. */
function update(mutate: (store: InboxFile) => void): Promise<InboxState> {
  return enqueue(async () => {
    let store: InboxFile;
    try {
      store = coerce(JSON.parse(await readFile(inboxStorePath(), 'utf8')), 0);
    } catch {
      store = coerce({}, Date.now());
    }
    mutate(store);
    await writeFileAtomic(store);
    return store;
  });
}

/** Get (creating) the entry for a thread so a mutator can patch it in place. */
function entryOf(store: InboxFile, threadId: string): InboxEntry {
  const existing = store.entries[threadId];
  if (existing) return existing;
  const fresh: InboxEntry = {};
  store.entries[threadId] = fresh;
  return fresh;
}

/** Drop an entry that no longer says anything, so the file doesn't accrete noise. */
function prune(store: InboxFile, threadId: string): void {
  const entry = store.entries[threadId];
  if (entry && Object.keys(entry).length === 0) delete store.entries[threadId];
}

// ---- public API. Every mutator takes a list so bulk actions are the same path. ----

export function setArchived(threadIds: string[], archived: boolean): Promise<InboxState> {
  const now = Date.now();
  return update((store) => {
    for (const threadId of threadIds) {
      const entry = entryOf(store, threadId);
      if (archived) {
        entry.archivedAt = now;
        // Archiving is a decision about the thread; leaving it snoozed as well
        // would make un-archiving put it somewhere the user didn't ask for.
        delete entry.snoozedAt;
        delete entry.snoozedUntil;
      } else {
        delete entry.archivedAt;
      }
      prune(store, threadId);
    }
  });
}

/** Snooze until `until` (ms), or `null` to wake the threads now. */
export function setSnooze(threadIds: string[], until: number | null): Promise<InboxState> {
  const now = Date.now();
  return update((store) => {
    for (const threadId of threadIds) {
      const entry = entryOf(store, threadId);
      if (until != null && until > now) {
        entry.snoozedAt = now;
        entry.snoozedUntil = until;
        // A snoozed thread is by definition back in play at its wake time, so it
        // can't stay archived too.
        delete entry.archivedAt;
      } else {
        delete entry.snoozedAt;
        delete entry.snoozedUntil;
      }
      prune(store, threadId);
    }
  });
}

export function setRead(threadIds: string[], read: boolean): Promise<InboxState> {
  const now = Date.now();
  return update((store) => {
    for (const threadId of threadIds) {
      const entry = entryOf(store, threadId);
      if (read) {
        entry.readAt = now;
        delete entry.forcedUnread;
      } else {
        entry.forcedUnread = true;
      }
      prune(store, threadId);
    }
  });
}

/**
 * Mark every listed thread read in one write. Takes the caller's chat list rather
 * than stamping the baseline forward: a thread the backend hasn't listed yet (a
 * brand-new chat mid-turn) must not be silently marked read.
 */
export function markAllRead(chats: { threadId: string; updatedAt: number }[]): Promise<InboxState> {
  const now = Date.now();
  return update((store) => {
    for (const chat of chats) {
      // Stamp the thread's own mtime when it is in the future relative to `now`
      // (clock skew on a networked home dir), so the row can't stay stubbornly bold.
      const entry = entryOf(store, chat.threadId);
      entry.readAt = Math.max(now, toMs(chat.updatedAt));
      delete entry.forcedUnread;
    }
  });
}

/** Drop a thread's inbox state when the chat itself is deleted. */
export function removeInboxEntry(threadId: string): Promise<InboxState> {
  return update((store) => {
    delete store.entries[threadId];
  });
}
