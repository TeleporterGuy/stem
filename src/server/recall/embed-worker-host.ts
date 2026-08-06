import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one file that touches Electron's utilityProcess. The manager depends on
// this WorkerTransport seam instead, so unit tests inject an in-memory fake and
// the vitest electron stub never needs utilityProcess.

export interface WorkerTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number | undefined) => void): void;
  kill(): void;
}

export function spawnEmbedWorker(): WorkerTransport {
  // Built next to the main bundle by the second rollup input in electron.vite.config.
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'embed-worker.js');
  const child = utilityProcess.fork(entry, [], { serviceName: 'stem-embed-worker' });
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
