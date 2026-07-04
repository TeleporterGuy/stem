import type { LocalEmbedModelSpec } from './embed-catalog';
import type { EmbedKind } from './embeddings';
import type { WorkerOutMessage } from './embed-worker';
import type { WorkerTransport } from './embed-worker-host';
import type { LocalEmbedStatus } from '../../shared/types';

// Main-process side of the local embedding worker: owns the utility-process
// lifecycle (lazy spawn on first demand, respawn on crash, dispose on model
// switch) and multiplexes embed requests over it. Everything here is
// non-blocking: ensure() just kicks the machinery, and callers learn readiness
// via status()/onStatus rather than awaiting a download.

export interface EmbedWorkerManager {
  /**
   * Make sure the worker is up and loading `spec` (spawns/downloads if needed;
   * returns immediately). After a failure, re-kicks are rate-limited to one per
   * {@link ERROR_RETRY_MS} unless `force` (Test button / settings change).
   */
  ensure(spec: LocalEmbedModelSpec, opts?: { force?: boolean }): void;
  status(): LocalEmbedStatus;
  onStatus(cb: (status: LocalEmbedStatus) => void): () => void;
  /** Embed via the worker. Queued while loading/downloading; rejects on error state. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
  /** Model switch or mode left 'local': kill the worker; when a spec is given, start loading it. */
  reconfigure(spec: LocalEmbedModelSpec | null): void;
  dispose(): void;
}

interface Pending {
  texts: string[];
  kind: EmbedKind;
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const EMBED_TIMEOUT_MS = 60_000;
const ERROR_RETRY_MS = 5 * 60_000;
const MAX_RESPAWNS = 3;
// A worker that survives this long before dying is treated as a genuine one-off
// crash (fresh respawn budget), not a crash loop. Shorter than this counts toward
// MAX_RESPAWNS so a worker that aborts moments after loading — e.g. an ONNX OOM on
// the first backfill batch — settles into a visible 'error' instead of respawning
// forever. Must exceed a load+first-embed cycle (a few seconds) comfortably.
const STABLE_UPTIME_MS = 60_000;

export function createEmbedWorkerManager(deps: {
  spawn: () => WorkerTransport;
  cacheDir: () => string;
  embedTimeoutMs?: number;
}): EmbedWorkerManager {
  const embedTimeoutMs = deps.embedTimeoutMs ?? EMBED_TIMEOUT_MS;

  let transport: WorkerTransport | null = null;
  let spec: LocalEmbedModelSpec | null = null;
  let status: LocalEmbedStatus = { model: 'multilingual-e5-small', state: 'idle' };
  let lastErrorAt = 0;
  let respawns = 0;
  let spawnedAt = 0;
  let nextId = 1;
  const inflight = new Map<number, Pending>();
  const queued: Pending[] = []; // held until 'ready', then flushed
  const listeners = new Set<(s: LocalEmbedStatus) => void>();

  function setStatus(next: LocalEmbedStatus): void {
    status = next;
    if (next.state === 'error') lastErrorAt = Date.now();
    for (const cb of listeners) cb(next);
  }

  function failAll(message: string): void {
    const err = new Error(message);
    for (const p of inflight.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    inflight.clear();
    for (const p of queued.splice(0)) p.reject(err);
  }

  function send(p: Pending): void {
    if (!transport) return;
    const id = nextId++;
    inflight.set(id, p);
    p.timer = setTimeout(() => {
      inflight.delete(id);
      p.reject(new Error(`local embeddings: timed out after ${embedTimeoutMs}ms`));
    }, embedTimeoutMs);
    transport.send({ type: 'embed', id, texts: p.texts, kind: p.kind });
  }

  function flushQueued(): void {
    for (const p of queued.splice(0)) send(p);
  }

  function handleMessage(raw: unknown): void {
    const msg = raw as WorkerOutMessage;
    if (msg.type === 'status') {
      setStatus(msg.status);
      if (msg.status.state === 'ready') {
        // Reaching 'ready' does NOT reset the respawn budget: a worker can load
        // fine and then abort on the first embed (ONNX OOM), and resetting here
        // would let that crash loop forever. The budget is refreshed instead when
        // a worker proves stable by living past STABLE_UPTIME_MS (see onExit).
        flushQueued();
      } else if (msg.status.state === 'error') {
        failAll(`local embeddings: ${msg.status.error ?? 'model failed to load'}`);
      }
      return;
    }
    if (msg.type === 'result') {
      const p = inflight.get(msg.id);
      if (!p) return; // timed out already
      inflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.vectors);
      return;
    }
    if (msg.type === 'error') {
      if (typeof msg.id !== 'number') return; // load errors arrive as status
      const p = inflight.get(msg.id);
      if (!p) return;
      inflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`local embeddings: ${msg.message}`));
    }
  }

  function spawn(target: LocalEmbedModelSpec): void {
    let t: WorkerTransport;
    try {
      t = deps.spawn();
    } catch (err) {
      // Never throws out of ensure(): callers (available() on the turn hot path)
      // must fall back, not break the turn.
      setStatus({
        model: target.id,
        state: 'error',
        error: err instanceof Error ? err.message : 'failed to start embedding worker'
      });
      return;
    }
    transport = t;
    spawnedAt = Date.now();
    setStatus({ model: target.id, state: 'loading' });
    // Identity-guarded: a superseded worker lives up to 2 s after stop() and its
    // late messages must not clobber the replacement's status or requests.
    t.onMessage((msg) => {
      if (transport === t) handleMessage(msg);
    });
    t.onExit(() => {
      if (transport !== t) return; // superseded by reconfigure
      transport = null;
      failAll('local embeddings: worker exited');
      // A worker that ran past STABLE_UPTIME_MS before dying is a one-off crash,
      // not a loop — refund its respawn budget so a long-lived worker that finally
      // trips over one bad input gets a fresh start.
      if (Date.now() - spawnedAt >= STABLE_UPTIME_MS) respawns = 0;
      // Unexpected exit (dispose/reconfigure clear `transport` first): respawn
      // with a cap so a crash-looping model settles into 'error' instead of
      // burning CPU forever; the next settings change or Test resets the count.
      if (respawns < MAX_RESPAWNS && spec) {
        respawns += 1;
        spawn(spec);
      } else {
        setStatus({
          model: target.id,
          state: 'error',
          error: 'embedding worker keeps crashing — try a smaller model or turn embeddings off'
        });
      }
    });
    t.send({ type: 'load', spec: target, cacheDir: deps.cacheDir() });
  }

  function stop(): void {
    const t = transport;
    transport = null; // cleared first so onExit doesn't respawn
    if (t) {
      // Ask the worker to release its ONNX session, then SIGTERM it on ack. The
      // worker never exits itself — process.exit() with a live ORT thread pool
      // aborts ("mutex lock failed"), while SIGTERM skips C++ static destructors
      // and can't. The timer is the backstop for a hung worker.
      t.send({ type: 'dispose' });
      const killTimer = setTimeout(() => t.kill(), 2000);
      killTimer.unref?.();
      t.onMessage((raw) => {
        if ((raw as WorkerOutMessage).type === 'disposed') {
          clearTimeout(killTimer);
          t.kill();
        }
      });
    }
    failAll('local embeddings: worker stopped');
  }

  return {
    ensure(target, opts = {}) {
      const sameModel = spec?.id === target.id;
      // Healthy (or still loading) worker on the right model → nothing to do.
      if (sameModel && transport && status.state !== 'error') return;
      // After a failure the worker may still be alive but useless; retries are
      // rate-limited so the turn-hot-path available() probe can't hammer a dead
      // endpoint, while force (Test button / settings change) restarts now.
      if (sameModel && status.state === 'error' && !opts.force && Date.now() - lastErrorAt < ERROR_RETRY_MS) return;
      if (transport) stop();
      spec = target;
      respawns = 0;
      spawn(target);
    },
    status: () => status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    embed(texts, kind) {
      return new Promise<Float32Array[]>((resolve, reject) => {
        const p: Pending = { texts, kind, resolve, reject };
        if (status.state === 'ready' && transport) send(p);
        else if (transport && (status.state === 'loading' || status.state === 'downloading')) queued.push(p);
        else reject(new Error('local embeddings: worker not running'));
      });
    },
    reconfigure(target) {
      stop();
      spec = null;
      if (target) this.ensure(target, { force: true });
      else setStatus({ model: status.model, state: 'idle' });
    },
    dispose() {
      stop();
      spec = null;
    }
  };
}
