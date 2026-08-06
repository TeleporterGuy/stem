import { appendFile, rename, stat } from 'node:fs/promises';
import { logFilePath } from './workspace/paths';

// Minimal main-process file logger. Everything here is best-effort and
// serialized through one promise chain: logging must never throw, block a turn,
// or interleave lines. Scope + message + optional JSON payload, one line each,
// rotated once at MAX_LOG_BYTES so the file can't grow without bound.

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;

let chain: Promise<void> = Promise.resolve();

function formatLine(scope: string, message: string, extra?: unknown): string {
  let suffix = '';
  if (extra !== undefined) {
    try {
      suffix = ` ${JSON.stringify(extra)}`;
    } catch {
      suffix = ' [unserializable payload]';
    }
  }
  const full = `${new Date().toISOString()} [${scope}] ${message}${suffix}`.replace(/\r?\n/g, '\\n');
  return `${full.length > MAX_LINE_CHARS ? `${full.slice(0, MAX_LINE_CHARS)}…` : full}\n`;
}

/** Append one line to the app log (fire-and-forget; never throws). */
export function log(scope: string, message: string, extra?: unknown): void {
  const text = formatLine(scope, message, extra);
  chain = chain.then(async () => {
    try {
      const path = logFilePath();
      const s = await stat(path).catch(() => null);
      if (s && s.size > MAX_LOG_BYTES) await rename(path, `${path}.1`).catch(() => undefined);
      await appendFile(path, text, 'utf8');
    } catch {
      // Logging is diagnostics only — swallow everything.
    }
  });
}

/** Settles when every line passed to log() so far has been flushed (for tests). */
export function logFlushed(): Promise<void> {
  return chain;
}
