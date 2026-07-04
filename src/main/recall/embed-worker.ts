import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyPrefixes } from './embed-catalog';
import type { LocalEmbedModelSpec } from './embed-catalog';
import type { EmbedKind } from './embeddings';
import type { LocalEmbedStatus } from '../../shared/types';

// Utility-process entry hosting the local embedding model (transformers.js/ONNX).
// Lives in its own process so CPU inference and model loading never block the
// main process — embedding sits on the chat-turn hot path. Talks to the manager
// (embed-manager.ts) over process.parentPort with plain structured-clone messages.
// This file must stay free of Electron imports beyond the ambient parentPort.

export type WorkerInMessage =
  | { type: 'load'; spec: LocalEmbedModelSpec; cacheDir: string }
  | { type: 'embed'; id: number; texts: string[]; kind: EmbedKind }
  | { type: 'dispose' };

export type WorkerOutMessage =
  | { type: 'status'; status: LocalEmbedStatus }
  | { type: 'result'; id: number; dim: number; vectors: Float32Array[] }
  | { type: 'error'; id?: number; message: string }
  | { type: 'disposed' };

// Model runs in batches this size so one huge backfill request can't spike memory.
// Kept small deliberately: MultiHeadAttention allocates O(batch · maxSeqLen²) and
// every item in a batch pads to the longest one (up to the tokenizer's 512-token
// window). At 64, a batch of long episodic messages peaks ~2.7 GB and aborts
// onnxruntime inside the sandboxed utility process (BFCArena::Extend →
// posix_memalign fails → SIGTRAP). CPU inference is compute-bound, not
// batch-amortized — per-item throughput is the same at 8 as at 64 — so a small
// batch costs no speed while keeping the worst-case allocation ~1 GB.
const RUN_BATCH = 8;
// Download progress is per-chunk chatty; cap status posts to ~4/s.
const PROGRESS_THROTTLE_MS = 250;

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ dims: number[]; data: Float32Array }>;

const port = process.parentPort;

let spec: LocalEmbedModelSpec | null = null;
let extractor: Extractor | null = null;
let dim = 0;
let lastProgressPost = 0;

function post(msg: WorkerOutMessage): void {
  port.postMessage(msg);
}

function postStatus(status: Omit<LocalEmbedStatus, 'model'>): void {
  if (!spec) return;
  post({ type: 'status', status: { model: spec.id, ...status } });
}

/** The weights filename transformers.js resolves for each catalog dtype. */
function weightsFile(dtype: LocalEmbedModelSpec['dtype']): string {
  return dtype === 'q8' ? 'model_quantized.onnx' : dtype === 'q4' ? 'model_q4.onnx' : 'model.onnx';
}

async function load(nextSpec: LocalEmbedModelSpec, cacheDir: string): Promise<void> {
  spec = nextSpec;
  postStatus({ state: 'loading' });
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    // transformers.js fires the same 'progress' events when streaming cached
    // files off disk as during a real download, so a cache-hit load would show
    // as "downloading" on every launch. If the weights are already in the cache,
    // report those reads as plain loading instead.
    const cached = existsSync(join(cacheDir, nextSpec.repo, 'onnx', weightsFile(nextSpec.dtype)));
    // Aggregate per-file {loaded,total} into one percentage; files download in
    // parallel and each reports independently.
    const files = new Map<string, { loaded: number; total: number }>();
    const onProgress = (p: { status: string; file?: string; loaded?: number; total?: number }): void => {
      if (p.status !== 'progress' || !p.file || !p.total) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const done = total > 0 && loaded >= total;
      const now = Date.now();
      if (!done && now - lastProgressPost < PROGRESS_THROTTLE_MS) return;
      lastProgressPost = now;
      postStatus(
        cached || done
          ? { state: 'loading' } // bytes are in (or on disk already); ONNX session creation is what remains
          : { state: 'downloading', progressPct: Math.floor((loaded / total) * 100) }
      );
    };
    const pipe = (await pipeline('feature-extraction', nextSpec.repo, {
      dtype: nextSpec.dtype,
      progress_callback: onProgress
    })) as unknown as Extractor;
    // Probe with a tiny input: verifies the model produces vectors, reports the
    // real dimension (not just the catalog's claim), and warms the session so the
    // first user-facing embed doesn't pay first-run graph-optimization cost.
    const probe = await pipe(['ping'], { pooling: 'mean', normalize: true });
    dim = probe.dims[probe.dims.length - 1];
    extractor = pipe;
    postStatus({ state: 'ready', dim });
  } catch (err) {
    extractor = null;
    postStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function embed(id: number, texts: string[], kind: EmbedKind): Promise<void> {
  if (!extractor || !spec) {
    post({ type: 'error', id, message: 'model not loaded' });
    return;
  }
  try {
    const prefixed = applyPrefixes(spec, kind, texts);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < prefixed.length; i += RUN_BATCH) {
      const batch = prefixed.slice(i, i + RUN_BATCH);
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      const d = out.dims[out.dims.length - 1];
      for (let row = 0; row < batch.length; row++) {
        // Copy each row out of the batch tensor so rows are independent buffers.
        vectors.push(out.data.slice(row * d, (row + 1) * d));
      }
    }
    post({ type: 'result', id, dim, vectors });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

async function dispose(): Promise<void> {
  // Release the ONNX session, then let the MANAGER kill this process. Never
  // process.exit() here: exit() runs C++ static destructors while ORT's thread
  // pool may still be winding down, which aborts with "mutex lock failed"
  // (std::terminate) in the terminal. A SIGTERM kill skips that teardown
  // entirely, so it can't abort.
  const pipe = extractor as unknown as { dispose?: () => Promise<void> } | null;
  extractor = null;
  try {
    await pipe?.dispose?.();
  } catch {
    // being killed anyway
  }
  post({ type: 'disposed' });
}

port.on('message', (e: { data: WorkerInMessage }) => {
  const msg = e.data;
  if (msg.type === 'load') void load(msg.spec, msg.cacheDir);
  else if (msg.type === 'embed') void embed(msg.id, msg.texts, msg.kind);
  else if (msg.type === 'dispose') void dispose();
});
