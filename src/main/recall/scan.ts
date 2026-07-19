import type { ScanWorkerManager } from './scan-manager';
import type { ScanRequestOptions } from './scan-worker';
import {
  semanticSearchMessagesCore,
  semanticSearchSummariesCore,
  type CoreSearchHit,
  type CoreSummaryHit,
  type QueryEmbedding
} from './search-core';
import { recallStore } from './store';
const { dbHandle, enforceEpisodicLimit } = recallStore;

// App-global registry for the recall scan worker (mirrors retrieval.ts for the
// embedding clients). Set once from main at startup; read by the episodic
// search paths (search.ts, inject.ts) and the capture maintenance tap. Every
// entry point degrades to the synchronous in-process implementation when the
// worker is unset (unit tests) or failing — behavior is then byte-identical to
// the pre-worker code, just back on the main event loop.

let manager: ScanWorkerManager | null = null;

export function setScanWorkerManager(m: ScanWorkerManager | null): void {
  manager = m;
}

/** Cosine leg of the episodic message search, off-thread when possible. */
export async function scanMessagesOffThread(
  qe: QueryEmbedding,
  opts: ScanRequestOptions
): Promise<CoreSearchHit[]> {
  if (manager) {
    try {
      return await manager.scanMessages(qe.vec, qe.model, opts);
    } catch {
      // fall through to the in-process scan
    }
  }
  return semanticSearchMessagesCore(dbHandle(), qe.vec, qe.model, opts);
}

/** Cosine leg of the thread-summary search, off-thread when possible. */
export async function scanSummariesOffThread(
  qe: QueryEmbedding,
  opts: ScanRequestOptions
): Promise<CoreSummaryHit[]> {
  if (manager) {
    try {
      return await manager.scanSummaries(qe.vec, qe.model, opts);
    } catch {
      // fall through to the in-process scan
    }
  }
  return semanticSearchSummariesCore(dbHandle(), qe.vec, qe.model, opts);
}

/**
 * Episodic size-cap enforcement (prune + VACUUM), fire-and-forget. Runs in the
 * worker when available; only a worker failure falls back to the synchronous
 * in-process pass — disk hygiene must not silently stop when the worker breaks.
 */
export function requestEpisodicMaintenance(): void {
  if (manager) {
    manager.maintain().catch(() => {
      try {
        enforceEpisodicLimit();
      } catch {
        // Pruning must never break capture.
      }
    });
    return;
  }
  enforceEpisodicLimit();
}

/** VACUUM recall.sqlite (disk reclaim after an episodic reset), off-thread when possible. */
export async function vacuumRecallDb(): Promise<void> {
  if (manager) {
    try {
      await manager.vacuum();
      return;
    } catch {
      // fall through to the in-process VACUUM
    }
  }
  dbHandle().exec('VACUUM');
}
