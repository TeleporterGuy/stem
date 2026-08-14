// The read-only copy of your chats that this phone keeps for the tunnel.
//
// This is src/desktop/offline-cache.ts on a phone, and it is deliberately the
// same contract down to the rules — a phone is the device that loses its network
// constantly (a lift, the Underground, a border), so the case the desktop's cache
// was written for is the phone's ordinary Tuesday.
//
// The three rules, unchanged, because they are what make a cache safe rather than
// merely helpful:
//
//   1. THE CACHE IS NEVER THE SOURCE OF TRUTH WHEN THE SERVER IS REACHABLE.
//      replay() is called from exactly one place — the branch of connection.rpc()
//      where the fetch itself threw (UnreachableError), meaning nothing on the
//      other end answered. A server that answers with an error is a server that
//      is up, and its error is what the screen gets. Reachable and unreachable
//      are decided by the transport, never by the contents of an answer.
//
//   2. IT IS AN OPTIMIZATION, SO IT MAY NEVER BREAK A CALL. Every operation here
//      swallows its own errors. A corrupt database, a full device or a schema
//      from a future build all degrade to "no cache", which is how the app
//      behaved before this file existed.
//
//   3. IT IS BOUNDED. See MAX_CACHED_THREADS.
//
// And the fourth, which is the phone's own: THERE IS NO WRITE PATH. No outbox, no
// queue, no sync. Composing is already gated on `status.reachable` (useThread), so
// this file never has to answer what happens when two sides disagree — it cannot,
// because only one side ever writes.
//
// SCHEMA POLICY: drop and refill, the desktop's policy for the desktop's reason.
// The server still has every byte of this, so the cost of being wrong is one
// catch-up run, and migration code for a file nobody would miss is code kept
// alive for nothing.
//
// The sqlite handle is INJECTED rather than imported. expo-sqlite is a native
// module and cannot load in a Node test process, and everything interesting in
// here — what is kept, what is served, what is evicted — is decision logic that
// deserves to be tested for what it is.

import type { ChatHistory, ChatListResult, ChatSummary } from '@shared/types';

/** Bump to invalidate every cache on every phone. See the schema policy above. */
const SCHEMA_VERSION = 1;

/**
 * How many threads a catch-up run will fetch — the desktop's number, and the
 * reasoning is if anything more pointed here: enough that the chats you would
 * actually open underground are there, few enough that a phone reconnecting on
 * a foreign roaming plan does not spend somebody's data allowance being helpful.
 */
export const PREFETCH_LIMIT = 25;

/**
 * The size bound, in threads rather than bytes or age — the desktop's argument
 * (an old thread you went looking for is exactly the one worth keeping, and
 * measuring bytes on every write decides something the row count already
 * decides), with the desktop's hundred halved. A phone holds one person's recent
 * reading rather than a workstation's whole history, and the prefetch's
 * twenty-five sits comfortably inside fifty so ordinary use never fights the
 * bound.
 */
const MAX_CACHED_THREADS = 50;

/**
 * Quiet period before a catch-up run. Reconnects arrive in bursts — a phone
 * coming out of a tunnel retries on a doubling backoff, and iOS hands the app a
 * foreground event on top of that — so every trigger is debounced into whichever
 * one is last.
 */
const PREFETCH_DEBOUNCE_MS = 2_000;

/** Channels that answer with one thread's transcript, keyed by args[0]. */
const THREAD_CHANNELS = new Set(['chats:open', 'chats:history']);

/** The only whole-answer channel the phone keeps: the list the first screen paints. */
const CHATS_DOCUMENT = 'chats';

/**
 * One channel, used for both directions — which is where this file is SMALLER
 * than the desktop's rather than different from it, and worth saying why.
 *
 * Deliberately not kept: settings. The desktop caches it because its renderer
 * will not paint without a settings document; the phone reads it in exactly one
 * place (resolving an `append` instructions approval, see useApprovals) and that
 * read is followed immediately by a resolve RPC which cannot happen offline
 * anyway. A cached answer there would buy a card that can be filled in and not
 * submitted.
 *
 * Also deliberately not kept: the Inbox mutators, even though every one of them
 * answers with a whole fresh ChatListResult and would refresh the copy for free.
 * The desktop's asymmetry lesson is what forbids it — the same table decides
 * what may be SERVED, and serving a list in reply to `inbox:setArchived` would
 * tell the screen that a write which never left the phone had succeeded.
 */
function documentFor(channel: string): string | null {
  return channel === 'chats:list' ? CHATS_DOCUMENT : null;
}

/**
 * The sqlite surface this file uses, and nothing more. expo-sqlite's
 * SQLiteDatabase satisfies it (see ./sqlite.ts); so does an object literal in a
 * test.
 */
export interface CacheDatabase {
  execSync(source: string): void;
  runSync(source: string, params: SqlParams): unknown;
  getFirstSync<T>(source: string, params: SqlParams): T | null;
  getAllSync<T>(source: string, params: SqlParams): T[];
  closeSync(): void;
}

export type SqlParams = (string | number | null)[];

/** Runs one call against the server, aborting when `signal` says to. */
export type PrefetchCall = (channel: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;

export interface OfflineCache {
  /** Write-through: keep this answer if it is one of the ones worth keeping. */
  record(channel: string, args: unknown[], result: unknown): void;
  /**
   * The cached answer for a call the server could not be REACHED for, flagged
   * `offline` so the screen can say where it came from — or undefined when there
   * is nothing, which leaves the caller to fail as it always did.
   */
  replay(channel: string, args: unknown[]): unknown;
  /** Ask for a bounded catch-up run, coalescing a burst of triggers into one. */
  schedulePrefetch(call: PrefetchCall): void;
  /** Abandon anything in flight or pending — the link dropped again, or we quit. */
  cancel(): void;
  /**
   * Forget everything. Called on unpair: what is in here belongs to a server this
   * phone no longer holds a credential for, and a cache that outlived its pairing
   * would show one person's chats to whoever pairs the phone next.
   */
  clear(): void;
  /** Release the database handle (tests; a hard reset). */
  close(): void;
}

export interface OfflineCacheDeps {
  /** Opens (or creates) the database. Called lazily, at most once. */
  open: () => CacheDatabase;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export function createOfflineCache(deps: OfflineCacheDeps): OfflineCache {
  const log = deps.log ?? ((): void => undefined);

  /** undefined = not opened yet; null = tried and failed, never try again. */
  let db: CacheDatabase | null | undefined;

  /**
   * updatedAt per thread as of the last chat list we saw. It is what tells a
   * thread body apart from a stale one, and it arrives on the LIST rather than on
   * the transcript — chats:open answers with messages and a title, and nothing
   * about when the thread last moved.
   */
  const updatedAt = new Map<string, number>();

  function open(): CacheDatabase | null {
    if (db !== undefined) return db;
    db = null;
    try {
      const handle = deps.open();
      handle.execSync('PRAGMA journal_mode = WAL;');
      const version = handle.getFirstSync<{ user_version?: number }>('PRAGMA user_version', [])
        ?.user_version;
      if (version !== SCHEMA_VERSION) {
        handle.execSync('DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS threads;');
      }
      handle.execSync(`
        CREATE TABLE IF NOT EXISTS documents (
          name      TEXT PRIMARY KEY,
          payload   TEXT NOT NULL,
          cached_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS threads (
          thread_id  TEXT PRIMARY KEY,
          updated_at INTEGER NOT NULL,
          payload    TEXT NOT NULL,
          cached_at  INTEGER NOT NULL
        );
      `);
      handle.execSync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      db = handle;
      seedWatermarks();
    } catch (e) {
      // A corrupt file, a device with no space left, a native module that is not
      // in this build. "No cache" is a supported state; failing to start is not.
      log('the offline chat cache could not be opened', { error: String((e as Error)?.message ?? e) });
    }
    return db;
  }

  /**
   * Reload the updatedAt map from the chat list already on disk, so the first
   * catch-up run after a relaunch diffs against what this phone really has rather
   * than re-fetching all twenty-five.
   */
  function seedWatermarks(): void {
    const list = readDocument<ChatListResult>(CHATS_DOCUMENT);
    for (const chat of list?.chats ?? []) updatedAt.set(chat.threadId, chat.updatedAt);
  }

  function writeDocument(name: string, value: unknown): void {
    const handle = open();
    if (!handle) return;
    try {
      handle.runSync(
        `INSERT INTO documents (name, payload, cached_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at`,
        [name, JSON.stringify(value), Date.now()]
      );
    } catch (e) {
      log('could not cache a document', { name, error: String((e as Error)?.message ?? e) });
    }
  }

  function readDocument<T>(name: string): T | null {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.getFirstSync<{ payload: string }>('SELECT payload FROM documents WHERE name = ?', [
        name
      ]);
      return row ? (JSON.parse(row.payload) as T) : null;
    } catch {
      return null;
    }
  }

  /**
   * Keep one thread's transcript, then enforce the bound. Pruning here rather
   * than on a timer is what makes the bound true at every instant rather than
   * true on average.
   */
  function writeThread(threadId: string, history: unknown): void {
    const handle = open();
    if (!handle) return;
    try {
      handle.runSync(
        `INSERT INTO threads (thread_id, updated_at, payload, cached_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at,
                                              payload    = excluded.payload,
                                              cached_at  = excluded.cached_at`,
        [threadId, updatedAt.get(threadId) ?? 0, JSON.stringify(history), Date.now()]
      );
      handle.runSync(
        `DELETE FROM threads WHERE thread_id NOT IN
           (SELECT thread_id FROM threads ORDER BY updated_at DESC, cached_at DESC LIMIT ?)`,
        [MAX_CACHED_THREADS]
      );
    } catch (e) {
      log('could not cache a thread', { threadId, error: String((e as Error)?.message ?? e) });
    }
  }

  function readThread(threadId: string): ChatHistory | null {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.getFirstSync<{ payload: string }>(
        'SELECT payload FROM threads WHERE thread_id = ?',
        [threadId]
      );
      return row ? (JSON.parse(row.payload) as ChatHistory) : null;
    } catch {
      return null;
    }
  }

  /**
   * Forget threads the server no longer lists. A chat deleted at the desk that
   * went on showing here would be the cache contradicting a server it can
   * perfectly well reach, which is the one thing it must never do.
   */
  function dropVanished(chats: readonly ChatSummary[]): void {
    const handle = open();
    if (!handle) return;
    try {
      const live = new Set(chats.map((c) => c.threadId));
      const rows = handle.getAllSync<{ id: string }>('SELECT thread_id AS id FROM threads', []);
      for (const { id } of rows) {
        if (!live.has(id)) handle.runSync('DELETE FROM threads WHERE thread_id = ?', [id]);
      }
    } catch {
      // Leaving a stale row is survivable; it is bounded and the next list retries.
    }
  }

  /** What this phone already holds, as the staleness rule wants to see it. */
  function cachedWatermarks(): Map<string, number> {
    const handle = open();
    if (!handle) return new Map();
    try {
      const rows = handle.getAllSync<{ id: string; at: number }>(
        'SELECT thread_id AS id, updated_at AS at FROM threads',
        []
      );
      return new Map(rows.map((r) => [r.id, r.at]));
    } catch {
      return new Map();
    }
  }

  // ---- prefetch ----

  /** The run in flight, so cancel() and the next trigger can both reach it. */
  let inFlight: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  async function runPrefetch(call: PrefetchCall): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    try {
      const list = (await call('chats:list', [], controller.signal)) as ChatListResult | null;
      // record() ran inside the call, so the watermarks and the pruning are
      // already applied by the time the diff below reads them back.
      const wanted = staleByUpdatedAt(list?.chats ?? [], cachedWatermarks(), PREFETCH_LIMIT);
      for (const threadId of wanted) {
        if (controller.signal.aborted) return;
        // chats:history, not chats:open: the open pre-warms the backend's session
        // for the thread (src/server/index.ts), so walking a list through it would
        // queue twenty-five session switches behind whatever the user is doing.
        await call('chats:history', [threadId], controller.signal);
      }
      if (wanted.length) log('filled the offline cache', { threads: wanted.length });
    } catch (e) {
      // The link went away again mid-run, or we were cancelled. Either way the
      // next connect schedules another one, and it picks up where this stopped —
      // every thread it did fetch is already cached.
      if (!controller.signal.aborted) {
        log('the catch-up run stopped early', { error: String((e as Error)?.message ?? e) });
      }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  function stopPrefetch(): void {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    inFlight?.abort();
    inFlight = null;
  }

  return {
    record(channel, args, result) {
      if (result === undefined || result === null) return;
      if (documentFor(channel)) {
        const list = result as ChatListResult;
        updatedAt.clear();
        for (const chat of list.chats ?? []) updatedAt.set(chat.threadId, chat.updatedAt);
        dropVanished(list.chats ?? []);
        writeDocument(CHATS_DOCUMENT, result);
        return;
      }
      if (THREAD_CHANNELS.has(channel) && typeof args[0] === 'string') {
        writeThread(args[0], result);
      }
    },

    replay(channel, args) {
      if (documentFor(channel)) {
        const value = readDocument<ChatListResult>(CHATS_DOCUMENT);
        // The flag the plan names, on both answers that are ABOUT chats: an answer
        // that says where it came from, so nothing downstream has to infer it from
        // the shape of what it got.
        return value ? { ...value, offline: true } : undefined;
      }
      if (THREAD_CHANNELS.has(channel) && typeof args[0] === 'string') {
        const history = readThread(args[0]);
        return history ? { ...history, offline: true } : undefined;
      }
      return undefined;
    },

    schedulePrefetch(call) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        // One run at a time. A second trigger while one is running is not lost —
        // the run it would have started is the run already in progress, and
        // whatever changed after it started is picked up by the next connect.
        if (inFlight) return;
        void runPrefetch(call);
      }, PREFETCH_DEBOUNCE_MS);
    },

    cancel: stopPrefetch,

    clear() {
      stopPrefetch();
      updatedAt.clear();
      const handle = open();
      if (!handle) return;
      try {
        handle.execSync('DELETE FROM documents; DELETE FROM threads;');
      } catch (e) {
        log('could not clear the offline cache', { error: String((e as Error)?.message ?? e) });
      }
    },

    close() {
      stopPrefetch();
      try {
        db?.closeSync();
      } catch {
        // Closing a handle we already lost is not worth a line in the log.
      }
      db = undefined;
      updatedAt.clear();
    }
  };
}

/**
 * The threads a catch-up run should fetch: newest first, those never cached or
 * whose cached copy predates the server's `updatedAt`, capped at `limit`.
 *
 * The twin of staleByUpdatedAt in src/desktop/offline-cache.ts, re-stated rather
 * than imported: that file lives under src/desktop/, which Metro does not put in
 * the phone's bundle (only src/shared/ is aliased, see metro.config.js). Copying
 * it is safe in a way copying the pairing rule was not — this decides only which
 * threads a prefetch fetches early, so the two drifting costs a redundant fetch
 * rather than a wrong answer.
 */
export function staleByUpdatedAt(
  chats: readonly ChatSummary[],
  cached: ReadonlyMap<string, number>,
  limit: number
): string[] {
  const wanted: string[] = [];
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (wanted.length >= limit) break;
    const have = cached.get(chat.threadId);
    if (have === undefined || have < chat.updatedAt) wanted.push(chat.threadId);
  }
  return wanted;
}
