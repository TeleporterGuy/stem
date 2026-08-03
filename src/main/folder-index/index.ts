import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectedFolder, FolderIndexStatus } from '../../shared/types';
import { effectiveLearnMode, listConnectedFolders } from '../workspace/connected-folders';
import { folderIndexDbPath, folderIndexDir } from '../workspace/paths';
import { isRecallEnabled } from '../workspace/memory';
import { getEmbeddingsClient } from '../recall/retrieval';
import { hybridSearchDocs, type CoreDocHit, type EmbedQueryFn } from '../recall/search-core';
import type { LlmClient } from '../recall/llm';
import { recallStore } from '../recall/store';
import { log } from '../log';
import * as activity from '../activity';
import { embedMissingDocVectors } from './embed';
import { learnFolderBatch } from './learn';
import { scanFolder } from './scan';
import { FolderIndexStore } from './store';

// Orchestrator for indexed connected folders: owns the per-folder store
// handles, the periodic scan+embed pass, retrieval across all indexes (the
// recall injection leg), and the reconcile that drops indexes whose folder was
// disconnected or un-indexed. Also writes manifest.json so the stem-recall MCP
// server discovers indexes without a pi restart.

/** What the stem-recall MCP server needs to search an index (see manifest()). */
interface ManifestEntry {
  id: string;
  label: string;
  path: string;
  memorize: boolean;
  dbFile: string;
}

/** A cross-folder hit: the core hit plus which folder it came from. */
export interface FolderDocHit extends CoreDocHit {
  folderId: string;
  folderLabel: string;
  /** True when the folder is connected memorize:false — injection must taint the turn. */
  private: boolean;
  /**
   * True when this hit may feed fact learning: the folder's effective learn
   * mode isn't 'off' (which already implies memorize:true). The runtime logs
   * eligible injected excerpts for the distill pass to cite.
   */
  learnEligible: boolean;
}

const stores = new Map<string, FolderIndexStore>();

function storeFor(folderId: string): FolderIndexStore {
  let store = stores.get(folderId);
  if (!store) {
    store = new FolderIndexStore(() => folderIndexDbPath(folderId));
    stores.set(folderId, store);
  }
  return store;
}

/** Indexed, present folders from the registry. */
async function indexedFolders() {
  return (await listConnectedFolders()).filter((f) => f.index && !f.missing);
}

/**
 * Drop one folder's index entirely: close the handle and delete the DB file
 * (plus WAL/SHM siblings). Called when the folder is disconnected or its
 * index option is turned off.
 */
export async function dropFolderIndex(folderId: string): Promise<void> {
  stores.get(folderId)?.close();
  stores.delete(folderId);
  const base = folderIndexDbPath(folderId);
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${base}${suffix}`, { force: true }).catch(() => undefined);
  }
}

/** Write the manifest the stem-recall MCP server re-reads on every tool call. */
async function writeManifest(entries: ManifestEntry[]): Promise<void> {
  await mkdir(folderIndexDir(), { recursive: true });
  const path = join(folderIndexDir(), 'manifest.json');
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, folders: entries }, null, 2), 'utf8');
  await rename(tmp, path); // Atomic: the MCP server may read mid-write.
}

/**
 * Reconcile disk with the registry: delete index DBs for folders that are no
 * longer connected or no longer indexed, and rewrite the manifest. Cheap; safe
 * to call after any connected-folders mutation.
 */
export async function syncFolderIndexes(): Promise<void> {
  try {
    const folders = await listConnectedFolders();
    const indexedIds = new Set(folders.filter((f) => f.index).map((f) => f.id));
    let names: string[] = [];
    try {
      names = await readdir(folderIndexDir());
    } catch {
      // Dir doesn't exist yet — nothing to reconcile.
    }
    for (const name of names) {
      const m = name.match(/^(.+)\.sqlite$/);
      if (m && !indexedIds.has(m[1])) await dropFolderIndex(m[1]);
    }
    await writeManifest(
      folders
        .filter((f) => f.index)
        .map((f) => ({
          id: f.id,
          label: f.label,
          path: f.path,
          memorize: f.memorize,
          dbFile: folderIndexDbPath(f.id)
        }))
    );
  } catch (err) {
    log('folder-index', 'sync failed', { error: (err as Error).message });
  }
}

// One scan pass at a time; overlapping kicks (startup + toggle + interval) no-op.
let scanning = false;

/**
 * Scan every indexed folder (incremental), then top up missing doc vectors.
 * Never throws; per-folder failures are logged and skipped so one bad folder
 * can't starve the others.
 */
export async function scanAllIndexedFolders(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    await syncFolderIndexes();
    const folders = await indexedFolders();
    for (const f of folders) {
      await mkdir(folderIndexDir(), { recursive: true });
      const store = storeFor(f.id);
      const scanHandle = activity.begin('folders.scan', `Scanning ${f.label}`, { detail: f.label });
      try {
        const res = await scanFolder(store, f.path);
        activity.end(scanHandle, {
          worked: res.indexed > 0 || res.removed > 0,
          detail: `${f.label} — ${res.indexed} indexed, ${res.removed} removed`
        });
        if (res.indexed > 0 || res.removed > 0) {
          log('folder-index', `scanned ${f.label}`, { indexed: res.indexed, removed: res.removed });
        }
      } catch (err) {
        activity.fail('folders.scan', err, `Scanning ${f.label}`);
        log('folder-index', `scan failed for ${f.label}`, { error: (err as Error).message });
        continue;
      }
      const emb = getEmbeddingsClient();
      if (emb) {
        const embedHandle = activity.begin('folders.embed', `Embedding ${f.label}`, { detail: f.label });
        const written = await embedMissingDocVectors(store, emb);
        activity.end(embedHandle, {
          worked: written > 0,
          detail: `${f.label} — ${written.toLocaleString()} document${written === 1 ? '' : 's'}`
        });
      }
    }
  } finally {
    scanning = false;
  }
}

/** Index health per indexed folder id, for the Folders tab. */
export async function getFolderIndexStatuses(): Promise<Record<string, FolderIndexStatus>> {
  const out: Record<string, FolderIndexStatus> = {};
  for (const f of await indexedFolders()) {
    try {
      const status = storeFor(f.id).readStatus();
      try {
        status.learn.facts = recallStore.countFactsBySource(`folder:${f.id}`);
      } catch {
        // Recall DB unavailable → the count stays 0.
      }
      out[f.id] = status;
    } catch {
      // A folder whose index DB can't open just has no status yet.
    }
  }
  return out;
}

/**
 * Seed a folder's learn marks for 'new' mode: everything currently indexed
 * counts as already learned, so only files added/changed from now on distill.
 * Also how switching away from a running 'all' sweep cancels its backlog.
 */
export async function seedFolderLearnMarks(folderId: string): Promise<void> {
  try {
    storeFor(folderId).stampAllLearned();
  } catch (err) {
    log('folder-learn', 'seeding learn marks failed', { folderId, error: (err as Error).message });
  }
}

// One learn drain at a time; overlapping kicks (post-scan + mode change) no-op.
let learningActive = false;
const LEARN_BATCH_PAUSE_MS = 2_000;

/**
 * Drain pending doc distillation across folders in 'new'/'all' mode, one batch
 * per iteration. The registry is re-read every iteration, so switching a
 * folder's mode down mid-drain cancels its remaining backlog. Stops (without
 * error) when a batch makes no progress — a failed model call retries on the
 * next scheduled kick rather than hammering in a tight loop. Returns true when
 * it stopped because `shouldYield` asked it to (caller should reschedule soon).
 */
export async function learnAllIndexedFolders(opts: {
  makeLlm: (folder: ConnectedFolder) => LlmClient;
  /** Checked between batches; true → stop now, caller reschedules. */
  shouldYield?: () => boolean;
}): Promise<boolean> {
  if (learningActive) return false;
  learningActive = true;
  // Stepped activity entry: the drain yields to interactive work and resumes on a
  // later kick, so one entry spans the whole backlog and banks only working time.
  let handle: activity.ActivityHandle | null = null;
  let docsLearned = 0;
  let factsWritten = 0;
  const closeEntry = (): void => {
    if (!handle) return;
    activity.end(handle, {
      worked: factsWritten > 0,
      detail: `${factsWritten} fact${factsWritten === 1 ? '' : 's'} from ${docsLearned} document${docsLearned === 1 ? '' : 's'}`
    });
    handle = null;
  };
  try {
    for (;;) {
      if (!isRecallEnabled()) {
        closeEntry();
        return false;
      }
      if (opts.shouldYield?.()) {
        // Leave the entry open — the caller reschedules and we resume into it.
        if (handle) activity.yieldStep(handle);
        return true;
      }
      const folders = (await indexedFolders()).filter((f) => {
        const mode = effectiveLearnMode(f);
        return mode === 'new' || mode === 'all';
      });
      const target = folders.find((f) => {
        try {
          return storeFor(f.id).pendingLearnCount() > 0;
        } catch {
          return false;
        }
      });
      if (!target) {
        closeEntry();
        return false;
      }
      // Opened only once there is real work, so an empty drain stays silent.
      handle ??= activity.begin('folders.learn', 'Learning from folders', { stepped: true });
      const res = await learnFolderBatch(storeFor(target.id), target, opts.makeLlm(target));
      if (!res || res.processed === 0) {
        closeEntry();
        return false;
      }
      docsLearned += res.processed;
      factsWritten += res.written;
      try {
        activity.progress(handle, {
          done: docsLearned,
          total: docsLearned + storeFor(target.id).pendingLearnCount()
        });
      } catch {
        // A closed/locked index just means no progress bar this iteration.
      }
      await new Promise((resolve) => setTimeout(resolve, LEARN_BATCH_PAUSE_MS));
    }
  } finally {
    learningActive = false;
  }
}

/**
 * Hybrid search across every indexed folder, merged best-first. Per-folder RRF
 * scores are comparable (same fusion, same legs), so a plain score merge is
 * fair. [] when nothing is indexed — the caller's cheap early-out.
 */
export async function searchFolderDocs(
  userText: string,
  opts: { limit?: number; snippetChars?: number; embedQuery?: EmbedQueryFn } = {}
): Promise<FolderDocHit[]> {
  const limit = opts.limit ?? 3;
  const folders = await indexedFolders();
  if (folders.length === 0) return [];
  const perFolder = await Promise.all(
    folders.map(async (f) => {
      try {
        const hits = await hybridSearchDocs(storeFor(f.id).handle(), userText, {
          limit,
          snippetChars: opts.snippetChars,
          embedQuery: opts.embedQuery
        });
        return hits.map((h) => ({
          ...h,
          folderId: f.id,
          folderLabel: f.label,
          private: !f.memorize,
          learnEligible: effectiveLearnMode(f) !== 'off'
        }));
      } catch {
        return [] as FolderDocHit[];
      }
    })
  );
  return perFolder
    .flat()
    // Sound only because hybridSearchDocs returns RRF scores on every path
    // (search-core.ts) — one folder on raw bm25 would sort inverted here and
    // always lose to an embedded folder's positive scores.
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Close every open index handle (app shutdown / tests). */
export function closeFolderIndexes(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}
