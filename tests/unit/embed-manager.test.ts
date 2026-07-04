// Manager suite — the utility-process lifecycle around the local embedding
// worker, driven through an in-memory fake transport (the vitest electron stub
// has no utilityProcess; the WorkerTransport seam exists exactly for this).
import { describe, expect, it, vi } from 'vitest';
import { EMBED_CATALOG } from '../../src/main/recall/embed-catalog';
import { RERANK_CATALOG } from '../../src/main/recall/rerank-catalog';
import { createEmbedWorkerManager } from '../../src/main/recall/embed-manager';
import type { WorkerOutMessage } from '../../src/main/recall/embed-worker';
import type { WorkerTransport } from '../../src/main/recall/embed-worker-host';
import type { LocalEmbedStatus } from '../../src/shared/types';

const SPEC = EMBED_CATALOG['multilingual-e5-small'];
const RERANK_SPEC = RERANK_CATALOG['bge-reranker-v2-m3'];

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

function manager(opts: { embedTimeoutMs?: number; rerankTimeoutMs?: number } = {}) {
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

const rerankReady = (): WorkerOutMessage => ({
  type: 'rerank-status',
  status: { model: RERANK_SPEC.id, state: 'ready' }
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

describe('co-hosted reranker', () => {
  it('loads the reranker into a live embed worker in place (no restart)', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    workers[0].emit(ready());
    mgr.ensureRerank(RERANK_SPEC);
    expect(workers).toHaveLength(1); // same process
    expect(workers[0].sent.at(-1)).toMatchObject({ type: 'load-rerank', cacheDir: '/tmp/models' });
    expect(mgr.rerankStatus().state).toBe('loading');
    mgr.ensureRerank(RERANK_SPEC); // idempotent while the same model is up
    expect(workers[0].sent.filter((m) => m.type === 'load-rerank')).toHaveLength(1);
  });

  it('spawns rerank-only when embeddings are not local, then adds the embedder in place', () => {
    const { mgr, workers } = manager();
    mgr.ensureRerank(RERANK_SPEC);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((m) => m.type)).toEqual(['load-rerank']);
    mgr.ensure(SPEC);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((m) => m.type)).toEqual(['load-rerank', 'load']);
  });

  it('queues reranks while loading, flushes on ready, and resolves results', async () => {
    const { mgr, workers } = manager();
    mgr.ensureRerank(RERANK_SPEC);
    const pending = mgr.rerank('q', ['a', 'b'], 2);
    expect(workers[0].sent.filter((m) => m.type === 'rerank')).toHaveLength(0);
    workers[0].emit(rerankReady());
    const req = workers[0].sent.find((m) => m.type === 'rerank')!;
    expect(req).toMatchObject({ query: 'q', docs: ['a', 'b'], topN: 2 });
    workers[0].emit({
      type: 'rerank-result',
      id: req.id as number,
      results: [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.1 }
      ]
    });
    expect(await pending).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 }
    ]);
  });

  it('keeps embed and rerank failure domains separate: a rerank load error only fails reranks', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    const embedPending = mgr.embed(['x'], 'passage');
    const rerankPending = mgr.rerank('q', ['a'], 1);
    workers[0].emit({ type: 'rerank-status', status: { model: RERANK_SPEC.id, state: 'error', error: 'oom' } });
    await expect(rerankPending).rejects.toThrow(/oom/);
    expect(mgr.rerankStatus().state).toBe('error');
    // The embed side is untouched and still completes.
    expect(mgr.status().state).toBe('ready');
    const req = workers[0].sent.find((m) => m.type === 'embed')!;
    workers[0].emit({ type: 'result', id: req.id as number, dim: 384, vectors: [new Float32Array([1])] });
    expect((await embedPending).length).toBe(1);
  });

  it('a crash respawn reloads BOTH models', async () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[0].emit(rerankReady());
    const pending = mgr.rerank('q', ['a'], 1);
    workers[0].exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((m) => m.type).sort()).toEqual(['load', 'load-rerank']);
  });

  it('an embed model switch restarts the process and reloads the reranker too', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[0].emit(rerankReady());
    mgr.reconfigure(EMBED_CATALOG['multilingual-e5-base']);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((m) => m.type).sort()).toEqual(['load', 'load-rerank']);
  });

  it('reconfigureRerank(null) restarts with the embedder only and goes idle', () => {
    const { mgr, workers } = manager();
    mgr.ensure(SPEC);
    mgr.ensureRerank(RERANK_SPEC);
    workers[0].emit(ready());
    workers[0].emit(rerankReady());
    mgr.reconfigureRerank(null);
    expect(mgr.rerankStatus().state).toBe('idle');
    expect(workers).toHaveLength(2);
    expect(workers[1].sent.map((m) => m.type)).toEqual(['load']);
  });

  it('rejects reranks when the worker is not running instead of hanging', async () => {
    const { mgr } = manager();
    await expect(mgr.rerank('q', ['a'], 1)).rejects.toThrow(/not running/);
  });

  it('rejects an in-flight rerank on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, workers } = manager({ rerankTimeoutMs: 1000 });
      mgr.ensureRerank(RERANK_SPEC);
      workers[0].emit(rerankReady());
      const pending = mgr.rerank('q', ['a'], 1);
      vi.advanceTimersByTime(1500);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
