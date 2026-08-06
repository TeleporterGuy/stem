import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { host, type WorkerTransport } from '../host';

// Where the embed worker gets forked. The manager depends on the WorkerTransport
// seam rather than on this module, so unit tests inject an in-memory fake and
// fork nothing at all; the host decides whether a real fork means Electron's
// utilityProcess or plain child_process.

export type { WorkerTransport };

export function spawnEmbedWorker(): WorkerTransport {
  // Built next to the main bundle by the second rollup input in electron.vite.config.
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'embed-worker.js');
  return host().forkWorker(entry, { serviceName: 'stem-embed-worker' });
}
