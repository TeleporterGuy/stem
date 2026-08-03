import { DatabaseSync } from 'node:sqlite';
import {
  semanticSearchMessagesCore,
  semanticSearchSummariesCore,
  type CoreSearchHit,
  type CoreSummaryHit,
  type SemanticScanOptions
} from './search-core';
import { enforceEpisodicLimitCore } from './maintenance-core';

// Utility-process entry hosting the recall brute-force cosine scans and the
// episodic maintenance work (size-cap pruning, VACUUM). Both are O(N) over the
// message store — tens of thousands of rows, or a multi-second VACUUM of a
// ~100 MB file — and both sit on paths the main process must never block on
// (the chat-turn hot path, the capture tap). Lives in its own process with its
// own read-write connection to recall.sqlite; WAL mode makes its reads see the
// main process's committed captures, and busy_timeout on both sides covers the
// brief exclusive window a VACUUM needs. Talks to the manager (scan-manager.ts)
// over process.parentPort with plain structured-clone messages.
// This file must stay free of Electron imports beyond the ambient parentPort.

export type ScanRequestOptions = SemanticScanOptions;

export type ScanWorkerInMessage =
  | { type: 'init'; dbPath: string }
  | ({ type: 'scan-messages'; id: number; vec: Float32Array; model: string } & ScanRequestOptions)
  | ({ type: 'scan-summaries'; id: number; vec: Float32Array; model: string } & ScanRequestOptions)
  | { type: 'maintain'; id: number }
  | { type: 'vacuum'; id: number };

export type ScanWorkerOutMessage =
  | { type: 'message-hits'; id: number; hits: CoreSearchHit[] }
  | { type: 'summary-hits'; id: number; hits: CoreSummaryHit[] }
  | { type: 'maintained'; id: number; deleted: number }
  | { type: 'vacuumed'; id: number }
  | { type: 'error'; id: number; message: string };

const port = process.parentPort;

let dbPath: string | null = null;
let db: DatabaseSync | null = null;

function post(msg: ScanWorkerOutMessage): void {
  port.postMessage(msg);
}

function open(): DatabaseSync {
  if (db) return db;
  if (!dbPath) throw new Error('scan worker not initialized');
  const handle = new DatabaseSync(dbPath);
  // The main process owns the schema; this connection only reads/prunes. A write
  // colliding with the main process (or a main write colliding with our VACUUM)
  // waits instead of throwing SQLITE_BUSY.
  // Mirrors the main-process handle (store.ts): must outlast one VACUUM round
  // held by the other side, not just a brief write lock.
  handle.exec('PRAGMA busy_timeout = 60000;');
  db = handle;
  return handle;
}

function fail(id: number, err: unknown): void {
  post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
}

port.on('message', (e: { data: ScanWorkerInMessage }) => {
  const msg = e.data;
  if (msg.type === 'init') {
    dbPath = msg.dbPath;
    return;
  }
  try {
    switch (msg.type) {
      case 'scan-messages':
        post({
          type: 'message-hits',
          id: msg.id,
          hits: semanticSearchMessagesCore(open(), msg.vec, msg.model, msg)
        });
        return;
      case 'scan-summaries':
        post({
          type: 'summary-hits',
          id: msg.id,
          hits: semanticSearchSummariesCore(open(), msg.vec, msg.model, msg)
        });
        return;
      case 'maintain':
        post({ type: 'maintained', id: msg.id, deleted: enforceEpisodicLimitCore(open(), dbPath ?? '') });
        return;
      case 'vacuum':
        open().exec('VACUUM');
        post({ type: 'vacuumed', id: msg.id });
        return;
    }
  } catch (err) {
    fail(msg.id, err);
  }
});
