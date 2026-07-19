import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerTransport } from './embed-worker-host';

// utilityProcess spawn for the recall scan worker, behind the same
// WorkerTransport seam as the embed worker so unit tests inject an in-memory
// fake and the vitest electron stub never needs utilityProcess.

export function spawnScanWorker(): WorkerTransport {
  // Built next to the main bundle by its own rollup input in electron.vite.config.
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'scan-worker.js');
  const child = utilityProcess.fork(entry, [], { serviceName: 'stem-recall-scan-worker' });
  return {
    send: (msg) => child.postMessage(msg),
    onMessage: (cb) => {
      child.on('message', cb);
    },
    onExit: (cb) => {
      child.on('exit', cb);
    },
    kill: () => {
      child.kill();
    }
  };
}
