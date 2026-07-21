import { spawn } from 'node:child_process';

// Spawns approved run_command commands. Runs in main (the privileged process),
// via `/bin/zsh -c` with the user's LOGIN-shell PATH — a GUI app's environment
// lacks Homebrew/npm bin dirs, so without this `agent-browser` & co. would be
// "command not found" even when installed.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
/** Per-stream capture cap; past it the child keeps running but output is dropped. */
export const OUTPUT_CAP_BYTES = 64 * 1024;

export interface ExecOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

let loginPathPromise: Promise<string> | null = null;

/**
 * Resolve the user's login-shell PATH once and cache it. Falls back to the
 * process PATH if the probe fails (then only system binaries are reachable).
 */
export function resolveLoginPath(): Promise<string> {
  if (!loginPathPromise) {
    loginPathPromise = new Promise<string>((resolve) => {
      const fallback = (): void => resolve(process.env.PATH ?? '');
      try {
        const probe = spawn('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => {
          probe.kill('SIGKILL');
          fallback();
        }, 5000);
        probe.stdout.on('data', (chunk: Buffer) => {
          if (out.length < 32_768) out += chunk.toString('utf8');
        });
        probe.on('error', () => {
          clearTimeout(timer);
          fallback();
        });
        probe.on('exit', () => {
          clearTimeout(timer);
          resolve(out.trim() || (process.env.PATH ?? ''));
        });
      } catch {
        fallback();
      }
    });
  }
  return loginPathPromise;
}

/**
 * The environment exec children get: the user's env minus Stem/pi internals.
 * Deliberately NOT the pi runtime's sanitizedEnv — that one is pi-oriented and
 * injects PI_CODING_AGENT_DIR etc., none of which a user command should see.
 */
export function execEnv(loginPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STEM_') || key.startsWith('PI_') || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.PATH = loginPath;
  return env;
}

/** Clamp a requested timeout into [1s, MAX]; undefined → the default. */
export function clampTimeout(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(requested)));
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run one shell command to completion with output caps and a process-group kill
 * on timeout/abort. `detached: true` puts the child in its own group so killing
 * `-pid` also reaches grandchildren (a spawned build, a browser helper); a true
 * daemon that double-forks into its own session intentionally escapes this.
 */
export function runCommand(opts: RunCommandOptions): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/zsh', ['-c', opts.command], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.length >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return current;
      }
      const room = OUTPUT_CAP_BYTES - current.length;
      if (chunk.length > room) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, room)]);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });

    const killGroup = (): void => {
      const pid = child.pid;
      if (!pid) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = (): void => killGroup();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const decode = (buf: Buffer, name: string): string => {
        let text = buf.toString('utf8');
        if (truncated) text += `\n…[${name} truncated at ${OUTPUT_CAP_BYTES} bytes]`;
        return text;
      };
      resolve({
        exitCode,
        signal,
        stdout: decode(stdout, 'stdout'),
        stderr: decode(stderr, 'stderr'),
        timedOut,
        truncated
      });
    };

    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    // Prefer 'close' (streams flushed), but a grandchild inheriting our pipes can
    // hold them open past the child's exit (a daemonizing CLI) — so also settle a
    // beat after 'exit' with whatever output has arrived by then.
    child.on('close', (code, signal) => finish(code, signal));
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 500);
    });
  });
}
