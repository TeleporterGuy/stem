import { spawn } from 'node:child_process';

// Spawns approved run_command commands. Runs in main (the privileged process).
// On macOS/Linux: `/bin/zsh -c` with the user's LOGIN-shell PATH — a GUI app's
// environment lacks Homebrew/npm bin dirs, so without this `agent-browser` & co.
// would be "command not found" even when installed.
// On Windows: `cmd.exe /d /s /c` (no AutoRun; avoids a broken PowerShell
// profile.ps1). PATH comes from the process environment (Path/PATH).

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

/** How STEM invokes the host shell for run_command (exported for unit tests). */
export interface ShellInvocation {
  command: string;
  args: string[];
  /** POSIX process-group kill via negative PID; false on Windows (taskkill). */
  detached: boolean;
}

/**
 * Build the argv used to run one user command. Pure so Mac CI can assert the
 * Windows shape without needing cmd.exe.
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation {
  if (platform === 'win32') {
    // /d = no AutoRun (registry hooks that mirror a broken profile), /s /c =
    // treat the rest as one command string the way CreateProcess expects.
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', command], detached: false };
  }
  return { command: '/bin/zsh', args: ['-c', command], detached: true };
}

/** Human label for tool descriptions / judge prompts. */
export function hostShellLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Windows (cmd.exe)' : 'macOS/Linux (zsh)';
}

let loginPathPromise: Promise<string> | null = null;

/** Test seam: clear the cached PATH so unit tests can re-probe. */
export function resetLoginPathCacheForTests(): void {
  loginPathPromise = null;
}

/**
 * Resolve the PATH exec children should use once and cache it.
 * Unix: login-shell zsh (`-lc`) so Homebrew/npm bins are visible.
 * Windows: process Path/PATH (GUI apps already inherit the user environment;
 * there is no zsh to probe). Falls back to an empty string if unset.
 */
export function resolveLoginPath(
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (!loginPathPromise) {
    loginPathPromise = platform === 'win32' ? Promise.resolve(windowsPath()) : probeZshLoginPath();
  }
  return loginPathPromise;
}

function windowsPath(): string {
  return process.env.Path || process.env.PATH || '';
}

function probeZshLoginPath(): Promise<string> {
  return new Promise<string>((resolve) => {
    const fallback = (): void => resolve(process.env.PATH ?? '');
    try {
      const probe = spawn('/bin/zsh', ['-lc', 'printf %s "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
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

/**
 * The environment exec children get: the user's env minus Stem/pi internals.
 * Deliberately NOT the pi runtime's sanitizedEnv — that one is pi-oriented and
 * injects PI_CODING_AGENT_DIR etc., none of which a user command should see.
 * On Windows both Path and PATH are set so cmd.exe and Node children agree.
 */
export function execEnv(loginPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STEM_') || key.startsWith('PI_') || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.PATH = loginPath;
  if (process.platform === 'win32') env.Path = loginPath;
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
 * Kill a hung/aborted child and its descendants.
 * Unix: process-group SIGKILL (child was spawned detached).
 * Windows: taskkill /T tree kill, then child.kill() as fallback.
 */
function killChildTree(child: ReturnType<typeof spawn>, detached: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch {
      // fall through
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
    return;
  }
  try {
    if (detached) process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Run one shell command to completion with output caps and a process-group /
 * process-tree kill on timeout/abort. On Unix, `detached: true` puts the child
 * in its own group so killing `-pid` also reaches grandchildren; a true daemon
 * that double-forks into its own session intentionally escapes this. On
 * Windows, taskkill /T covers the tree without relying on POSIX process groups.
 */
export function runCommand(opts: RunCommandOptions): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve, reject) => {
    const shell = shellInvocation(opts.command);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.command, shell.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: shell.detached,
        windowsHide: true
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

    const killGroup = (): void => killChildTree(child, shell.detached);

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
