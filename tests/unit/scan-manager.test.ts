// Recall scan worker suite: the manager's utility-process lifecycle (driven
// through an in-memory fake transport, like embed-manager.test.ts) and the
// scan.ts fallback seam that keeps retrieval byte-identical to the pre-worker
// behavior whenever the worker is unset or failing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScanWorkerManager, type ScanWorkerManager } from '../../src/main/recall/scan-manager';
import type { ScanWorkerOutMessage } from '../../src/main/recall/scan-worker';
import type { WorkerTransport } from '../../src/main/recall/embed-worker-host';
import type { CoreSearchHit } from '../../src/main/recall/search-core';
import {
  scanMessagesOffThread,
  requestEpisodicMaintenance,
  setScanWorkerManager,
  vacuumRecallDb
} from '../../src/main/recall/scan';
import { recallStore } from '../../src/main/recall/store';
const { recordMessage } = recallStore;

interface FakeWorker extends WorkerTransport {
  sent: Array<Record<string, unknown>>;
  emit(msg: ScanWorkerOutMessage): void;
  exit(code?: number): void;
  killed: boolean;
}

function fakeWorker(): FakeWorker {
  const onMsg: Array<(msg: unknown) => void> = [];
  let onExit: (code: number | undefined) => void = () => undefined;
  const w: FakeWorker = {
    sent: [],
    killed: false,
    send: (msg) => w.sent.push(msg as Record<string, unknown>),
    onMessage: (cb) => {
      onMsg.push(cb);
    },
    onExit: (cb) => {
      onExit = cb;
    },
    kill: () => {
      w.killed = true;
    },
    emit: (msg) => onMsg.forEach((cb) => cb(msg)),
    exit: (code) => onExit(code)
  };
  return w;
}

function manager(opts: { scanTimeoutMs?: number; failSpawn?: () => boolean } = {}) {
  const workers: FakeWorker[] = [];
  const mgr = createScanWorkerManager({
    spawn: () => {
      if (opts.failSpawn?.()) throw new Error('no utilityProcess here');
      const w = fakeWorker();
      workers.push(w);
      return w;
    },
    dbPath: () => '/tmp/recall-test.sqlite',
    scanTimeoutMs: opts.scanTimeoutMs
  });
  return { mgr, workers };
}

const HIT: CoreSearchHit = {
  id: 1,
  threadId: 't1',
  turnId: null,
  role: 'user',
  ts: 1,
  text: 'hello',
  snippet: 'hello',
  score: 0.9,
  cosine: 0.9
};

const SCAN_OPTS = { limit: 5, minCosine: 0.8, excludeThreadId: null };

afterEach(() => {
  setScanWorkerManager(null);
  vi.useRealTimers();
});

describe('scan worker manager', () => {
  it('lazily spawns on the first request and sends init with the db path', async () => {
    const { mgr, workers } = manager();
    expect(workers).toHaveLength(0);
    const p = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent[0]).toEqual({ type: 'init', dbPath: '/tmp/recall-test.sqlite' });
    expect(workers[0].sent[1]).toMatchObject({ type: 'scan-messages', model: 'm', limit: 5 });
    const id = workers[0].sent[1].id as number;
    workers[0].emit({ type: 'message-hits', id, hits: [HIT] });
    await expect(p).resolves.toEqual([HIT]);
    // Same worker serves the next request — no respawn, no second init.
    const p2 = mgr.maintain();
    expect(workers).toHaveLength(1);
    workers[0].emit({ type: 'maintained', id: workers[0].sent[2].id as number, deleted: 3 });
    await expect(p2).resolves.toBe(3);
  });

  it('routes scan-docs to the worker with the folder db file', async () => {
    const { mgr, workers } = manager();
    const p = mgr.scanDocs('/tmp/folder-index.sqlite', new Float32Array([1]), 'm', { limit: 3, minCosine: 0.7 });
    const sentMsg = workers[0].sent[1];
    expect(sentMsg).toMatchObject({ type: 'scan-docs', dbFile: '/tmp/folder-index.sqlite', model: 'm', limit: 3 });
    workers[0].emit({ type: 'doc-hits', id: sentMsg.id as number, hits: [] });
    expect(await p).toEqual([]);
  });

  it('evicts a folder handle over a live worker, and never spawns one to do it', async () => {
    const { mgr, workers } = manager();
    // Nothing has been scanned yet, so no worker exists — and no worker holds
    // the handle either. Dropping an index must not be what starts one.
    await expect(mgr.evictDocDb('/tmp/folder-index.sqlite')).resolves.toBeUndefined();
    expect(workers).toHaveLength(0);

    const scan = mgr.scanDocs('/tmp/folder-index.sqlite', new Float32Array([1]), 'm', { limit: 3, minCosine: 0.7 });
    workers[0].emit({ type: 'doc-hits', id: workers[0].sent[1].id as number, hits: [] });
    await scan;
    const p = mgr.evictDocDb('/tmp/folder-index.sqlite');
    const sentMsg = workers[0].sent.at(-1)!;
    expect(sentMsg).toMatchObject({ type: 'evict-doc-db', dbFile: '/tmp/folder-index.sqlite' });
    workers[0].emit({ type: 'doc-db-evicted', id: sentMsg.id as number });
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects on an error reply and on a timeout, leaving later requests working', async () => {
    const { mgr, workers } = manager({ scanTimeoutMs: 20 });
    const failing = mgr.scanSummaries(new Float32Array([1]), 'm', SCAN_OPTS);
    workers[0].emit({ type: 'error', id: workers[0].sent[1].id as number, message: 'boom' });
    await expect(failing).rejects.toThrow('recall scan worker: boom');

    const timingOut = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    await expect(timingOut).rejects.toThrow('timed out after 20ms');

    const ok = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    workers[0].emit({ type: 'message-hits', id: workers[0].sent.at(-1)!.id as number, hits: [] });
    await expect(ok).resolves.toEqual([]);
  });

  it('a worker exit rejects inflight requests and the next request respawns', async () => {
    const { mgr, workers } = manager();
    const p = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    workers[0].exit(1);
    await expect(p).rejects.toThrow('recall scan worker exited');

    const p2 = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent[0]).toMatchObject({ type: 'init' });
    workers[1].emit({ type: 'message-hits', id: workers[1].sent[1].id as number, hits: [HIT] });
    await expect(p2).resolves.toEqual([HIT]);
  });

  it('strikes out after repeated spawn failures, then retries once the window elapses', async () => {
    vi.useFakeTimers();
    let spawnAttempts = 0;
    const mgr = createScanWorkerManager({
      spawn: () => {
        spawnAttempts += 1;
        throw new Error('spawn refused');
      },
      dbPath: () => '/tmp/recall-test.sqlite'
    });
    for (let i = 0; i < 3; i++) {
      await expect(mgr.maintain()).rejects.toThrow('not running');
    }
    expect(spawnAttempts).toBe(3);
    // Striked out: fails fast without another spawn attempt…
    await expect(mgr.maintain()).rejects.toThrow('not running');
    expect(spawnAttempts).toBe(3);
    // …until the retry window elapses.
    vi.setSystemTime(Date.now() + 61_000);
    await expect(mgr.maintain()).rejects.toThrow('not running');
    expect(spawnAttempts).toBe(4);
  });

  it('dispose kills the worker and rejects everything after', async () => {
    const { mgr, workers } = manager();
    const p = mgr.scanMessages(new Float32Array([1]), 'm', SCAN_OPTS);
    mgr.dispose();
    expect(workers[0].killed).toBe(true);
    await expect(p).rejects.toThrow('disposed');
    await expect(mgr.vacuum()).rejects.toThrow('not running');
  });
});

describe('scan.ts fallback seam', () => {
  const QE = { vec: new Float32Array([1, 0]), model: 'test-model' };

  it('routes through the manager when one is set', async () => {
    const fake: ScanWorkerManager = {
      scanMessages: async () => [HIT],
      scanSummaries: async () => [],
      scanDocs: async () => [],
      evictDocDb: async () => undefined,
      maintain: async () => 0,
      vacuum: async () => undefined,
      dispose: () => undefined
    };
    setScanWorkerManager(fake);
    await expect(scanMessagesOffThread(QE, SCAN_OPTS)).resolves.toEqual([HIT]);
  });

  it('falls back to the in-process scan when the manager rejects, and works with none set', async () => {
    recordMessage({ threadId: 't', role: 'user', text: 'seed so the db exists' });
    const rejecting: ScanWorkerManager = {
      scanMessages: async () => {
        throw new Error('worker down');
      },
      scanSummaries: async () => {
        throw new Error('worker down');
      },
      scanDocs: async () => {
        throw new Error('worker down');
      },
      evictDocDb: async () => {
        throw new Error('worker down');
      },
      maintain: async () => {
        throw new Error('worker down');
      },
      vacuum: async () => {
        throw new Error('worker down');
      },
      dispose: () => undefined
    };
    setScanWorkerManager(rejecting);
    // No vectors cached in the test db → the in-process fallback returns [].
    await expect(scanMessagesOffThread(QE, SCAN_OPTS)).resolves.toEqual([]);
    // Maintenance falls back to the synchronous pass without throwing…
    expect(() => requestEpisodicMaintenance()).not.toThrow();
    await expect(vacuumRecallDb()).resolves.toBeUndefined();

    setScanWorkerManager(null);
    // …and with no manager at all, everything runs in-process directly.
    await expect(scanMessagesOffThread(QE, SCAN_OPTS)).resolves.toEqual([]);
    expect(() => requestEpisodicMaintenance()).not.toThrow();
    await expect(vacuumRecallDb()).resolves.toBeUndefined();
  });
});
