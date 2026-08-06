// Starting `stem-server` as its own process, for the E2E variant that proves the
// split is real.
//
// Two processes, one machine, one state root. The server is dist/main/server.js
// under plain `node` — the same entry the boot tripwire uses and the same one a
// VPS would run — and the Electron app is launched with STEM_SERVER_URL pointing
// at it, so it starts no server of its own and reaches everything over HTTP/SSE.
// Sharing the state root is what lets the desktop read its own bearer token off
// disk (see src/desktop/server-endpoint.ts); Phase 2's remote deployment is where
// that stops being true and pairing has to become a real thing.
//
// Deliberately NOT here: TLS, a remote host, a service manager. Phase 1 ends at
// "a separate process on the same machine", and this file is that sentence.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A cold boot writes the workspace, the recall DB and the device registry. */
const BOOT_TIMEOUT_MS = 60_000;

export interface StemServerProcess {
  /** Origin the desktop should be pointed at, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** Everything the process has said, for a failure message worth reading. */
  output(): string;
  /** SIGTERM and wait; SIGKILL if it will not go. */
  stop(): Promise<void>;
}

export interface StemServerOptions {
  /** The state root to share with the app — its `--user-data-dir`. */
  stateDir: string;
  /** The STEM_* store overrides the app was launched with, verbatim. */
  storeEnv: Record<string, string>;
  /** false = the hermetic FakeBackend, matching the app's own STEM_E2E seam. */
  real: boolean;
}

/**
 * Start the server and resolve once it says where it is listening. Rejects — with
 * everything the process printed — if it dies or never binds, because a silent
 * timeout here is indistinguishable from a hundred other E2E flakes and this one
 * would mean the headless build is broken.
 */
export async function startStemServer(opts: StemServerOptions): Promise<StemServerProcess> {
  const entry = join(PROJECT_ROOT, 'dist', 'main', 'server.js');
  const child: ChildProcess = spawn(process.execPath, [entry], {
    // The repo root: host().appRoot() defaults to the working directory, and the
    // server reads RELEASE_NOTES.md and its bundled pi assets relative to it.
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      // The whole point: the same state root the app is using, so both halves see
      // one settings.json, one recall DB, and one device registry.
      STEM_STATE_DIR: opts.stateDir,
      ...opts.storeEnv,
      ...(opts.real ? {} : { STEM_E2E: '1' })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  let exited: { code: number | null; signal: string | null } | null = null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (output += chunk));
  child.stderr?.on('data', (chunk: string) => (output += chunk));
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
    ]);
    if (!stopped) child.kill('SIGKILL');
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const url = /\[stem-server\] listening on (\S+)/.exec(output)?.[1];
    if (url) return { url, output: () => output, stop };
    if (exited) {
      throw new Error(
        `stem-server exited before it listened (code ${exited.code}, signal ${exited.signal}).\n${output}`
      );
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`stem-server never listened within ${BOOT_TIMEOUT_MS}ms.\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
