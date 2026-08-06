import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { host } from '../host';
import type { WorkerTransport } from './embed-worker-host';

// The recall scan worker's fork site, behind the same WorkerTransport seam as
// the embed worker so unit tests inject an in-memory fake.

export function spawnScanWorker(): WorkerTransport {
  // Built next to the main bundle by its own rollup input in electron.vite.config.
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'scan-worker.js');
  return host().forkWorker(entry, { serviceName: 'stem-recall-scan-worker' });
}
