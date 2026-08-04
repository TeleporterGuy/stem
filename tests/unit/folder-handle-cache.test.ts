import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FolderIndexStore } from '../../src/main/folder-index/store';
import { createScanWorkerManager } from '../../src/main/recall/scan-manager';
import type { WorkerTransport } from '../../src/main/recall/embed-worker-host';
import type { ScanWorkerInMessage, ScanWorkerOutMessage } from '../../src/main/recall/scan-worker';
import { evictDocScanHandle, scanDocsOffThread, setScanWorkerManager } from '../../src/main/recall/scan';
import { folderIndexDbPath, folderIndexDir } from '../../src/main/workspace/paths';

// The folder-index doc handles the scan worker and the stem-recall MCP server
// keep warm across requests: when they must be dropped (the index file was
// deleted and recreated at the same path — folder ids are stable UUIDs), how a
// failed scan is told apart from an empty one, and how narrow the MCP server's
// eviction sweep is. Companion to scan-manager.test.ts, which covers the same
// worker's message plumbing for the episodic legs.

const dir = mkdtempSync(join(tmpdir(), 'stem-doc-handles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MODEL = 'test-model';
const QE = { vec: Float32Array.from([1, 0, 0]), model: MODEL };
const SCAN_OPTS = { limit: 5, minCosine: 0.5 };

/** A real one-document folder index at `file` (fresh, replacing whatever was there). */
function makeIndex(file: string, relPath: string, text: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  const store = new FolderIndexStore(() => file);
  try {
    store.upsertDoc({ relPath, title: relPath, text, mtime: 1, size: text.length, hash: relPath }, 1);
    store.upsertDocVector(1, MODEL, Float32Array.from([1, 0, 0]));
  } finally {
    store.close();
  }
}

// The worker is a utility-process entry that wires itself to process.parentPort
// at import. Standing in a fake port makes the real module drivable in-process —
// singleton doc-handle cache and all, which is exactly what's under test here.
const workerOut: ScanWorkerOutMessage[] = [];
const workerIn: ScanWorkerInMessage[] = [];
let toWorker: (msg: ScanWorkerInMessage) => void = () => undefined;
let onWorkerOut: ((msg: ScanWorkerOutMessage) => void) | null = null;

beforeAll(async () => {
  const listeners: Array<(e: { data: ScanWorkerInMessage }) => void> = [];
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (_event: string, cb: (e: { data: ScanWorkerInMessage }) => void) => listeners.push(cb),
    postMessage: (msg: ScanWorkerOutMessage) => {
      workerOut.push(msg);
      onWorkerOut?.(msg);
    }
  };
  await import('../../src/main/recall/scan-worker');
  toWorker = (msg) => {
    workerIn.push(msg);
    for (const cb of listeners) cb({ data: msg });
  };
});

let seq = 0;

/** Send one request into the worker and return its (synchronous) reply. */
function ask(msg: Omit<ScanWorkerInMessage, 'id'>): ScanWorkerOutMessage | undefined {
  const id = ++seq;
  const at = workerOut.length;
  toWorker({ ...msg, id } as ScanWorkerInMessage);
  return workerOut[at];
}

function scanDocs(dbFile: string): ScanWorkerOutMessage | undefined {
  return ask({ type: 'scan-docs', dbFile, vec: QE.vec, model: MODEL, ...SCAN_OPTS } as Omit<
    ScanWorkerInMessage,
    'id'
  >);
}

/** A transport that wires the manager straight into the in-process worker module. */
function workerTransport(): WorkerTransport {
  return {
    send: (msg) => toWorker(msg as ScanWorkerInMessage),
    onMessage: (cb) => {
      onWorkerOut = (m) => cb(m);
    },
    onExit: () => undefined,
    kill: () => {
      onWorkerOut = null;
    }
  };
}

describe('scan worker doc-handle cache', () => {
  it('re-opens an index that was deleted and recreated at the same path', () => {
    const file = join(dir, 'recreated.sqlite');
    makeIndex(file, 'cottage.md', 'The cottage deposit is 400 euro.');
    const first = scanDocs(file);
    expect(first?.type).toBe('doc-hits');
    expect((first as { hits: Array<{ relPath: string }> }).hits.map((h) => h.relPath)).toEqual(['cottage.md']);

    // Index off → on: the same folder id, so the same path over a brand-new
    // file. On POSIX the cached handle would happily keep reading the unlinked
    // inode — every hit from an index the user believes gone.
    makeIndex(file, 'weather.md', 'Rain is forecast for the whole weekend.');
    const second = scanDocs(file);
    expect(second?.type).toBe('doc-hits');
    expect((second as { hits: Array<{ relPath: string }> }).hits.map((h) => h.relPath)).toEqual(['weather.md']);
  });

  it('closes the handle on an eviction message so the file can be deleted', () => {
    const file = join(dir, 'evicted.sqlite');
    makeIndex(file, 'notes.md', 'The cottage deposit is 400 euro.');
    expect(scanDocs(file)?.type).toBe('doc-hits');

    const id = ++seq;
    const at = workerOut.length;
    toWorker({ type: 'evict-doc-db', id, dbFile: file });
    expect(workerOut[at]).toEqual({ type: 'doc-db-evicted', id });

    // Nothing holds the file open now, so main's delete lands (on Windows it
    // would not have) and the next scan reports a failure rather than serving
    // the deleted index.
    rmSync(file, { force: true });
    expect(scanDocs(file)?.type).toBe('error');
  });

  it('reports a failed scan as an error, and an empty index as zero hits', () => {
    // A valid SQLite file that is not a folder index: the open succeeds, the
    // doc_vectors query does not. Swallowed, this is indistinguishable from
    // "nothing matched" and the caller never falls back.
    const broken = join(dir, 'not-an-index.sqlite');
    rmSync(broken, { force: true });
    const db = new DatabaseSync(broken);
    db.exec('CREATE TABLE unrelated(x)');
    db.close();
    const failed = scanDocs(broken);
    expect(failed?.type).toBe('error');
    expect((failed as { message: string }).message).toMatch(/doc_vectors/);

    // A real index with no vector above the bar is still just zero hits.
    const empty = join(dir, 'no-match.sqlite');
    makeIndex(empty, 'other.md', 'Unrelated grocery list for the week.');
    const none = ask({
      type: 'scan-docs',
      dbFile: empty,
      vec: Float32Array.from([0, 1, 0]),
      model: MODEL,
      ...SCAN_OPTS
    } as Omit<ScanWorkerInMessage, 'id'>);
    expect(none).toMatchObject({ type: 'doc-hits', hits: [] });
  });
});

describe('scanDocsOffThread', () => {
  it('falls back in-process when the worker cannot scan the index', async () => {
    const broken = join(dir, 'fallback-decoy.sqlite');
    rmSync(broken, { force: true });
    const decoy = new DatabaseSync(broken);
    decoy.exec('CREATE TABLE unrelated(x)');
    decoy.close();

    const live = new FolderIndexStore(() => join(dir, 'fallback-live.sqlite'));
    makeIndex(join(dir, 'fallback-live.sqlite'), 'cottage.md', 'The cottage deposit is 400 euro.');
    const mgr = createScanWorkerManager({ spawn: workerTransport, dbPath: () => join(dir, 'unused.sqlite') });
    setScanWorkerManager(mgr);
    try {
      // The worker's leg fails; the fallback runs against the caller's own live
      // handle, so the hit must still come back (pre-fix: a silent []).
      const hits = await scanDocsOffThread(broken, () => live.handle(), QE, SCAN_OPTS);
      expect(hits.map((h) => h.relPath)).toEqual(['cottage.md']);
    } finally {
      setScanWorkerManager(null);
      mgr.dispose();
      live.close();
    }
  });

  it('evicts through the manager when one is set, and is a no-op without one', async () => {
    const file = join(dir, 'seam.sqlite');
    makeIndex(file, 'notes.md', 'The cottage deposit is 400 euro.');
    const mgr = createScanWorkerManager({ spawn: workerTransport, dbPath: () => join(dir, 'unused.sqlite') });
    setScanWorkerManager(mgr);
    try {
      await scanDocsOffThread(file, () => new FolderIndexStore(() => file).handle(), QE, SCAN_OPTS);
      const at = workerIn.length;
      await evictDocScanHandle(file);
      expect(workerIn.slice(at)).toContainEqual(expect.objectContaining({ type: 'evict-doc-db', dbFile: file }));
    } finally {
      setScanWorkerManager(null);
      mgr.dispose();
    }
    // No manager (unit tests, worker down): nothing to evict, nothing thrown.
    const at = workerIn.length;
    await expect(evictDocScanHandle(file)).resolves.toBeUndefined();
    expect(workerIn.slice(at)).toEqual([]);
  });
});

describe('dropFolderIndex', () => {
  it('evicts the worker handle before deleting the index file', async () => {
    const { dropFolderIndex } = await import('../../src/main/folder-index/index');
    mkdirSync(folderIndexDir(), { recursive: true });
    const folderId = 'a0000000-0000-4000-8000-000000000001';
    const file = folderIndexDbPath(folderId);
    makeIndex(file, 'notes.md', 'The cottage deposit is 400 euro.');
    const mgr = createScanWorkerManager({ spawn: workerTransport, dbPath: () => join(dir, 'unused.sqlite') });
    setScanWorkerManager(mgr);
    try {
      // Through the manager, so its worker is up and holding the handle.
      expect(await mgr.scanDocs(file, QE.vec, MODEL, SCAN_OPTS)).toHaveLength(1);
      const at = workerIn.length;
      await dropFolderIndex(folderId);
      expect(workerIn.slice(at)).toContainEqual(expect.objectContaining({ type: 'evict-doc-db', dbFile: file }));
      // And the file really is gone — no handle was left holding it open.
      expect(scanDocs(file)?.type).toBe('error');
    } finally {
      setScanWorkerManager(null);
      mgr.dispose();
    }
  });

  it('deletes the index even when the worker never acknowledges the eviction', async () => {
    const { dropFolderIndex } = await import('../../src/main/folder-index/index');
    mkdirSync(folderIndexDir(), { recursive: true });
    const folderId = 'a0000000-0000-4000-8000-000000000002';
    const file = folderIndexDbPath(folderId);
    makeIndex(file, 'notes.md', 'The cottage deposit is 400 euro.');
    // A wedged worker: the eviction request never settles. The drop is the
    // user-visible operation — it waits its bounded turn, then proceeds.
    setScanWorkerManager({
      evictDocDb: () => new Promise<void>(() => undefined)
    } as unknown as Parameters<typeof setScanWorkerManager>[0]);
    vi.useFakeTimers();
    try {
      const dropped = dropFolderIndex(folderId);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(dropped).resolves.toBeUndefined();
      expect(existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
      setScanWorkerManager(null);
    }
  });
});

describe('stem-recall MCP server folder handles', () => {
  it('keeps other folders warm through a folder-scoped query, drops what left the manifest', async () => {
    const notesDir = join(dir, 'notes-folder');
    const tripsDir = join(dir, 'trips-folder');
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(tripsDir, { recursive: true });
    const notesDb = join(dir, 'mcp-notes.sqlite');
    const tripsDb = join(dir, 'mcp-trips.sqlite');
    makeIndex(notesDb, 'notes.md', 'The cottage deposit is 400 euro.');
    makeIndex(tripsDb, 'trips.md', 'The cottage deposit is 400 euro.');
    const entry = (id: string, label: string, path: string, dbFile: string) => ({
      id,
      label,
      path,
      memorize: true,
      dbFile
    });
    const writeManifest = (entries: unknown[]): void => {
      mkdirSync(folderIndexDir(), { recursive: true });
      writeFileSync(
        join(folderIndexDir(), 'manifest.json'),
        JSON.stringify({ version: 1, folders: entries }),
        'utf8'
      );
    };
    writeManifest([entry('n', 'Notes', notesDir, notesDb), entry('t', 'Trips', tripsDir, tripsDb)]);

    const { cachedFolderDbFiles, searchFolderDocs } = await import('../../src/main/recall/mcp-server-main');
    await searchFolderDocs('cottage deposit', 8, undefined);
    expect(cachedFolderDbFiles().sort()).toEqual([notesDb, tripsDb].sort());

    // A `folder:`-scoped call searches one index — it must not close the other.
    const scoped = await searchFolderDocs('cottage deposit', 8, 'notes');
    expect(scoped.map((h) => h.folderLabel)).toEqual(['Notes']);
    expect(cachedFolderDbFiles().sort()).toEqual([notesDb, tripsDb].sort());

    // A folder that genuinely left the manifest still gets dropped.
    writeManifest([entry('n', 'Notes', notesDir, notesDb)]);
    await searchFolderDocs('cottage deposit', 8, 'notes');
    expect(cachedFolderDbFiles()).toEqual([notesDb]);
  });
});
