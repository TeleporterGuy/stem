// Manager suite — the utility-process lifecycle around the local embedding
// worker, driven through an in-memory fake transport (the vitest electron stub
// has no utilityProcess; the WorkerTransport seam exists exactly for this).
import { describe, expect, it, vi } from 'vitest';
import { EMBED_CATALOG } from '../../src/main/recall/embed-catalog';
import { createEmbedWorkerManager } from '../../src/main/recall/embed-manager';
import type { WorkerOutMessage } from '../../src/main/recall/embed-worker';
import type { WorkerTransport } from '../../src/main/recall/embed-worker-host';
import type { LocalEmbedStatus } from '../../src/shared/types';

const SPEC = EMBED_CATALOG['multilingual-e5-small'];

interface FakeWorker extends WorkerTransport {
  sent: Array<Record<string, unknown>>;
  emit(msg: WorkerOutMessage): void;
  exit(code?: number): void;
  killed: boolean;
}

function fakeWorker(): FakeWorker {
  // Multi-listener like the real host (child.on): the manager attaches both the
  // main handler (at spawn) and a 'disposed' watcher (at stop).
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

function manager(opts: { embedTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const mgr = createEmbedWorkerManager({
    spawn: () => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    },
    cacheDir: () => '/tmp/models',
    ...opts
  });
  return { mgr, workers };
}

const ready = (dim = 384): WorkerOutMessage => ({
  type: 'status',
  status: { model: SPEC.id, state: 'ready', dim }
});

describe('embed worker manager', () => {
  it('lazily spawns on ensure and sends the load message with the cache dir', () => {
    const { mgr, workers } = manager();
    expect(workers).toHaveLength(0);
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent[0]).toMatchObject({ type: 'load', cacheDir: '/tmp/models' });
    mgr.ensure(SPEC); // idempotent while the same model is up
    expect(workers).toHaveLength(1);
  });

  it('queues embeds while loading and flushes them on ready', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    const pending = mgr.embed(['hello'], 'query');
    expect(workers[0].sent.filter((m) => m.type === 'embed')).toHaveLength(0);
    workers[0].emit(ready());
    const req = workers[0].sent.find((m) => m.type === 'embed')!;
    expect(req).toMatchObject({ texts: ['hello'], kind: 'query' });
    workers[0].emit({ type: 'result', id: req.id as number, dim: 384, vectors: [new Float32Array([1, 0])] });
    expect((await pending)[0]).toEqual(new Float32Array([1, 0]));
  });

  it('reports status transitions to listeners, including download progress', () => {
    const { mgr, workers } = manager();
    const seen: LocalEmbedStatus[] = [];
    mgr.onStatus((s) => seen.push(s));
    mgr.ensure(SPEC);
    workers[0].emit({ type: 'status', status: { model: SPEC.id, state: 'downloading', progressPct: 42 } });
    workers[0].emit(ready());
    expect(seen.map((s) => s.state)).toEqual(['loading', 'downloading', 'ready']);
    expect(mgr.status().dim).toBe(384);
  });

  it('rejects an in-flight embed on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ embedTimeoutMs: 1000 });
      mgr.ensure(SPEC);
      workers[0].emit(ready());
      const pending = mgr.embed(['x'], 'passage');
      vi.advanceTimersByTime(1500);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails pending work and respawns when the worker crashes, settling into error after the cap', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    const pending = mgr.embed(['x'], 'passage');
    workers[0].exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    // 1 original + 3 capped respawns; the last crash lands in 'error', no 5th spawn.
    expect(workers).toHaveLength(2);
    workers[1].exit(1);
    workers[2].exit(1);
    workers[3].exit(1);
    expect(workers).toHaveLength(4);
    expect(mgr.status().state).toBe('error');
  });

  it('load errors reject queued embeds and land in error state', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    const pending = mgr.embed(['x'], 'passage');
    workers[0].emit({ type: 'status', status: { model: SPEC.id, state: 'error', error: 'no network' } });
    await expect(pending).rejects.toThrow(/no network/);
    expect(mgr.status()).toMatchObject({ state: 'error', error: 'no network' });
    // Re-kicks are rate-limited after an error…
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(1);
    // …unless forced (Test button / settings change).
    mgr.ensure(SPEC, { force: true });
    expect(workers).toHaveLength(2);
  });

  it('reconfigure kills the old worker and loads the new model', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.reconfigure(EMBED_CATALOG['multilingual-e5-base']);
    // Graceful shutdown: dispose lets the worker release its ONNX session; the
    // manager SIGTERMs it on the 'disposed' ack (a self-exit would abort with
    // "mutex lock failed" while ORT threads wind down).
    expect(workers[0].sent.at(-1)).toMatchObject({ type: 'dispose' });
    expect(workers[0].killed).toBe(false);
    workers[0].emit({ type: 'disposed' });
    expect(workers[0].killed).toBe(true);
    expect(workers).toHaveLength(2);
    expect((workers[1].sent[0] as { spec: { id: string } }).spec.id).toBe('multilingual-e5-base');
    // The old worker's exit must not trigger a respawn — it was superseded.
    workers[0].exit(0);
    expect(workers).toHaveLength(2);
  });

  it('reconfigure(null) stops the worker and goes idle (mode left local)', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.reconfigure(null);
    expect(workers[0].sent.at(-1)).toMatchObject({ type: 'dispose' });
    expect(mgr.status().state).toBe('idle');
  });

  it('rejects embeds when the worker is not running instead of hanging', async () => {
    const { mgr } = manager();
    await expect(mgr.embed(['x'], 'query')).rejects.toThrow(/not running/);
  });

  it('turns a spawn failure into error state rather than throwing out of ensure', () => {
    const mgr = createEmbedWorkerManager({
      spawn: () => {
        throw new Error('utilityProcess unavailable');
      },
      cacheDir: () => '/tmp/models'
    });
    expect(() => mgr.ensure(SPEC)).not.toThrow();
    expect(mgr.status()).toMatchObject({ state: 'error', error: 'utilityProcess unavailable' });
  });
});
