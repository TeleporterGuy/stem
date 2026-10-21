import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { log } from '../../server/log';
import { clampTimeout, execEnv, resolveLoginPath, runCommand, timedOutLine } from '../../server/exec/executor';
import { scanCommandAgainstRoots } from '../../server/exec/protected';
import { hostShellFromPlatform } from '../../server/exec/host-shell';
import { host } from '../../server/host';
import type { DeviceExecRequest, DeviceExecResult, DeviceSaveRequest, ExecHostLocalState } from '../../shared/types';
import { hiddenPart, mkdirInside } from '../../server/files/save-file';
import { readMirroredFolders } from '../mirror-host/store';
import { readExecHostEnabled, writeExecHostEnabled } from './store';

// The client half of run_command's `device` target: THIS machine, running a
// command its Stem server sent over the addressed frame (shared/types.ts,
// EXEC_REQUEST_FRAME).
//
// What this file trusts and what it does not: the request arrived over this
// client's own authenticated stream, and the POLICY — allowlist, judge,
// approval card — already ran on the server. What it never delegates is the
// one decision that belongs to the person at this machine: whether it accepts
// commands at all. The switch is read fresh on every request, from a file on
// this disk that never goes on the wire (see store.ts) — a server that was
// told "yes" last week and compromised today still meets it.
//
// The executor is deliberately run_command's own (server/exec/executor.ts),
// the same reuse mcp-host/clients.ts already leans on: same shell resolution,
// same login PATH, same output caps and kill semantics, so a command behaves
// here the way it would have anywhere else.

/**
 * How long a scratch folder survives without being touched. The server's
 * sweeper keys off chat deletion too; this machine never learns of that, so
 * mtime is the whole signal — an honest limitation, not an oversight.
 */
const SCRATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type { ExecHostLocalState };

export interface ExecHostDeps {
  /** Call a server channel through the proxy (late-bound, like the MCP host's). */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /**
   * A command finished running here, however it ended. The mirror host listens
   * so a command that wrote into a mirrored folder is pushed up in seconds
   * rather than waiting for the watcher or the reconcile timer.
   */
  commandFinished?(request: DeviceExecRequest): void;
  /**
   * Stream one outbox entry from the server into `dir` under `name`; resolves
   * to the path written. Absent = this machine cannot receive files (save_file).
   */
  downloadOutbox?(id: string, dir: string, name: string): Promise<string>;
  /** A file was saved here; the mirror host pushes the folder it is in. */
  fileSaved?(path: string): void;
}

export interface ExecHost {
  /** Announce on launch (and sweep old scratch). */
  start(): Promise<void>;
  /** Re-announce — the stream reconnected, and the server may have restarted. */
  refresh(): Promise<void>;
  /** A command arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceExecRequest): void;
  /** A file to save arrived on the event stream. Never throws; answers over RPC. */
  onSave(request: DeviceSaveRequest): void;
  localState(): Promise<ExecHostLocalState>;
  /** The switch. Persists locally, then tells the server. */
  setEnabled(enabled: boolean): Promise<ExecHostLocalState>;
}

export function createExecHost(deps: ExecHostDeps): ExecHost {
  const platform = (
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  ) as 'darwin' | 'linux' | 'win32';

  async function announce(): Promise<void> {
    const enabled = await readExecHostEnabled();
    await deps.invoke('execHost:announce', [{ enabled, platform, ...(deps.downloadOutbox ? { saves: true } : {}) }]).catch((e) => {
      // An older server has no such channel; this machine simply cannot be a
      // target there, which is also what the server will say if asked.
      log('exec-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
    });
  }

  function scratchRoot(): string {
    return join(host().stateRoot(), 'exec-scratch');
  }

  /** This chat's scratch folder here, mirroring the server's per-thread concept. */
  async function ensureScratch(threadId: string): Promise<string> {
    // Same shape rule the server's isScratchId enforces: anything that could
    // walk the filesystem falls back to a shared bucket.
    const safe = /^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? threadId : 'unfiled';
    const dir = join(scratchRoot(), safe);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** TTL sweep by mtime, once per launch. Failure to sweep never blocks anything. */
  async function sweepScratch(): Promise<void> {
    try {
      const root = scratchRoot();
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        const info = await stat(dir).catch(() => null);
        if (info && now - info.mtimeMs > SCRATCH_TTL_MS) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      // A sweep that cannot run costs disk, not correctness.
    }
  }

  async function execute(request: DeviceExecRequest): Promise<DeviceExecResult> {
    // The gate, read fresh from this disk on every request. The server refuses
    // these before sending under normal operation; this is the authoritative
    // copy of the answer, held by the machine the command would run on.
    if (!(await readExecHostEnabled())) {
      return {
        ok: false,
        error:
          'This computer does not accept commands from Stem. The switch is in Settings → Features → ' +
          'Commands, on this computer.'
      };
    }
    // The read-only re-check, against THIS machine's own mirror list — the copy
    // of the answer a compromised server cannot edit. The server already ran
    // the same scan and refused politely; this one is the guard that holds when
    // it didn't (fail-closed, same token scan as the local protected-roots gate).
    const readOnlyRoots = (await readMirroredFolders())
      .filter((f) => f.mode === 'read')
      .map((f) => f.clientPath);
    const scan = scanCommandAgainstRoots(request.command, request.cwd ?? null, readOnlyRoots, hostShellFromPlatform());
    if (scan.blocked) {
      return {
        ok: false,
        error:
          `The command touches "${scan.root}", a folder this computer mirrors to Stem read-only. ` +
          'Commands cannot run against read-only folders; read it through the server-side mirror instead, ' +
          'or ask the user to switch the folder to read & write in the Folders tab.'
      };
    }
    let cwd: string;
    if (request.cwd) {
      const info = await stat(request.cwd).catch(() => null);
      if (!info?.isDirectory()) {
        return {
          ok: false,
          error: `The requested cwd "${request.cwd}" does not exist on this computer or is not a directory.`
        };
      }
      cwd = request.cwd;
    } else {
      cwd = await ensureScratch(request.threadId);
    }
    const timeoutMs = clampTimeout(request.timeoutMs);
    const loginPath = await resolveLoginPath();
    const outcome = await runCommand({
      command: request.command,
      cwd,
      timeoutMs,
      env: execEnv(loginPath)
    });
    // The same result block the local executor produces, built HERE, so the
    // model reads one format wherever a command ran.
    const parts = [
      outcome.timedOut
        ? timedOutLine(timeoutMs)
        : `Exit code: ${outcome.exitCode ?? `signal ${outcome.signal ?? 'unknown'}`}`,
      `stdout:\n${outcome.stdout.trim() || '(no output)'}`,
      `stderr:\n${outcome.stderr.trim() || '(no output)'}`
    ];
    return { ok: true, text: parts.join('\n\n') };
  }

  const REFUSED =
    'This computer does not accept commands from Stem. The switch is in Settings → Features → Commands, on this computer.';

  /**
   * save_file into a folder on this machine. Same switch as a command, and the
   * destination re-checked against THIS machine's own list: only inside a
   * folder it mirrors read & write, with symlinks resolved, so a server that
   * names another path gets nowhere.
   */
  async function save(request: DeviceSaveRequest): Promise<DeviceExecResult> {
    if (!(await readExecHostEnabled())) return { ok: false, error: REFUSED };
    if (!deps.downloadOutbox) return { ok: false, error: 'This computer cannot receive files from Stem.' };
    const target = resolve(request.path);
    const inside = (p: string, root: string): boolean => p.startsWith(root.endsWith(sep) ? root : root + sep);
    const root = (await readMirroredFolders())
      .filter((f) => f.mode === 'readwrite')
      .map((f) => resolve(f.clientPath))
      .find((r) => inside(target, r));
    if (!root) {
      return { ok: false, error: `"${request.path}" is not inside a folder this computer shares with Stem read & write.` };
    }
    const hidden = hiddenPart(relative(root, target));
    if (hidden) return { ok: false, error: `"${hidden}" is hidden; files are not saved into hidden files or folders.` };
    if (!(await mkdirInside(root, dirname(target)))) {
      return { ok: false, error: `"${request.path}" leads outside its folder.` };
    }
    const parent = await realpath(dirname(target));
    const dest = join(parent, basename(target));
    // Again on the resolved path: a visible link can point into a hidden folder.
    if (hiddenPart(relative(await realpath(root), dest))) {
      return { ok: false, error: `"${request.path}" leads into a hidden folder.` };
    }
    // quiet: absent is the usual case — a new file.
    const existing = await lstat(dest).catch(() => null);
    if (existing && !existing.isFile()) return { ok: false, error: `Something that is not a file is already at "${request.path}".` };
    let downloaded: string | null = null;
    try {
      downloaded = await deps.downloadOutbox(request.outboxId, parent, `.stem-save-${randomBytes(6).toString('hex')}`);
      await rename(downloaded, dest);
    } catch (e) {
      // quiet: the partial download goes; the reason is the answer.
      if (downloaded) await rm(downloaded, { force: true }).catch(() => undefined);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    deps.fileSaved?.(dest);
    return { ok: true, text: `Saved ${dest}` };
  }

  return {
    async start() {
      await announce();
      void sweepScratch();
    },

    refresh: () => announce(),

    onRequest(request) {
      void (async () => {
        let result: DeviceExecResult;
        try {
          result = await execute(request);
        } catch (e) {
          result = {
            ok: false,
            error: `The command could not be started: ${e instanceof Error ? e.message : String(e)}`
          };
        }
        // The answer goes back as an ordinary RPC whenever it is ready — the
        // server holds the correlation id and its own timeout.
        await deps.invoke('execHost:result', [request.requestId, result]).catch((e) => {
          log('exec-host', 'could not deliver a command result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
        deps.commandFinished?.(request);
      })();
    },

    onSave(request) {
      void (async () => {
        let result: DeviceExecResult;
        try {
          result = await save(request);
        } catch (e) {
          result = { ok: false, error: `The file could not be saved: ${e instanceof Error ? e.message : String(e)}` };
        }
        await deps.invoke('execHost:result', [request.requestId, result]).catch((e) => {
          log('exec-host', 'could not deliver a save result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
      })();
    },

    localState: async () => ({ enabled: await readExecHostEnabled() }),

    async setEnabled(enabled) {
      await writeExecHostEnabled(enabled);
      await announce();
      return { enabled };
    }
  };
}
