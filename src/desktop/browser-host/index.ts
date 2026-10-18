import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { log } from '../../server/log';
import {
  encodeFrame,
  FrameReader,
  MAX_TO_EXTENSION_BYTES,
  type ExtensionAction,
  type ExtensionDownload,
  type ExtensionResult,
  type FromExtension,
  type HostHello,
  type ToExtension,
  launchableBrowser
} from '../../shared/browser-native';
import type {
  BrowserDownloadReceipt,
  BrowserHostLocalState,
  BrowserInfo,
  DeviceBrowserRequest,
  DeviceBrowserResult
} from '../../shared/types';
import {
  browserInstallPaths,
  ensureHostConfig,
  extensionsPageUrl,
  installBrowserControl,
  refreshBrowserControl,
  setupBrowsers,
  type BrowserHostConfig,
  type BrowserInstallPaths,
  type InstallSource
} from './install';
import { handshakeProof, isNonce, newNonce, proofMatches } from './handshake';
import { arcSidebarText, readArcSidebar, type ArcSidebarTab } from './arc-tabs';
import {
  appOf,
  readBrowserHostSettings,
  updateBrowserHostSettings,
  writeBrowserHostEnabled,
  type BrowserHostSettings,
  type KnownBrowser
} from './store';

// The client half of the `browser` tool: THIS Mac, Windows or Linux computer, handing the browser actions
// its Stem server sends (BROWSER_REQUEST_FRAME) to the Stem extension in the
// user's browser, and answering with what it reports.
//
// The extension reaches us through its native-messaging host, which the
// browser starts and which connects to a unix socket here (0600, in this
// profile's state folder; a named pipe on Windows) and proves it holds the
// token from the config Set up wrote (handshake.ts). One connection per
// browser profile — the extension sends an id it keeps in that profile's
// storage — and several may be up at once (Arc's work and personal profiles,
// Chrome beside them). The user picks the default and can name each one; the
// model may name another profile per call, and the one it named stays the
// thread's until it names a different one.
//
// What this file decides, like computer-host: whether Stem may drive the
// browser at all (the switch, read fresh on every request), and the file
// traffic — an upload's files are fetched from the server's outbox into a
// folder here before the extension attaches them, and finished downloads are
// streamed up to the server, which files them for the chat. What it does NOT
// do is any per-action policy; the user chose none (2026-10-05).

/** How long a launched browser gets to start and have its extension connect. */
const LAUNCH_WAIT_MS = 20_000;

export interface BrowserHostDeps {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Stream a file up to the server; answers the staging handle (file-transfer.ts uploadFile). */
  uploadFile(path: string): Promise<string>;
  /** Fetch an outbox entry into `dir` under `name`; answers the path (file-transfer.ts downloadFile). */
  downloadOutbox(id: string, dir: string, name: string): Promise<string>;
  /** Where the bundled extension and native host are, and what runs the host. */
  installSource(): InstallSource;
  /** Start an app without bringing it forward. Tests fake it. */
  launch?(appPath: string): Promise<void>;
  /** Open a URL or folder with an app (Set up's last step). Tests fake it. */
  openWith?(appPath: string | null, target: string): Promise<void>;
  /** Put text on the clipboard (the extension folder, for Load unpacked's picker). */
  copyText?(text: string): void;
  paths?: BrowserInstallPaths;
  platform?: NodeJS.Platform;
  /** The home whose browsers Set up registers. Tests point it at a temp folder. */
  home?: string;
  /** Arc's sidebar tabs (arc-tabs.ts). Tests fake it. */
  readArcSidebar?(): Promise<{ tabs: ArcSidebarTab[] } | { error: string }>;
  /** Tests shorten the launch wait. */
  launchWaitMs?: number;
}

export interface BrowserHost {
  start(): Promise<void>;
  refresh(): Promise<void>;
  /** An action arrived on the event stream. Never throws; answers over RPC. */
  onRequest(request: DeviceBrowserRequest): void;
  /** The server says this thread's run is over. */
  onEnd(end: { threadId: string }): void;
  localState(): Promise<BrowserHostLocalState>;
  setEnabled(enabled: boolean): Promise<BrowserHostLocalState>;
  choose(id: string): Promise<BrowserHostLocalState>;
  rename(id: string, name: string): Promise<BrowserHostLocalState>;
  forget(id: string): Promise<BrowserHostLocalState>;
  setUp(): Promise<BrowserHostLocalState>;
  openExtensionsPage(browserId?: string): Promise<void>;
  close(): void;
}

interface Conn {
  socket: Socket;
  /** KnownBrowser.id, once the extension said hello; until then the connection is not usable. */
  key: string | null;
  appPath: string;
  appName: string;
  version?: string;
  pending: Map<string, (result: ExtensionResult) => void>;
}

/** Longest name a profile may be given. */
const MAX_PROFILE_NAME = 40;

/**
 * What each known browser is called: the user's name for it, else — when an
 * app has several profiles — "Arc 2" by the order they first connected. An
 * app's only, unnamed profile has none and goes by the app's name.
 */
export function profileNames(known: readonly KnownBrowser[]): Map<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  const seen = new Map<string, number>();
  for (const b of known) {
    const app = appOf(b.id);
    const n = (seen.get(app) ?? 0) + 1;
    seen.set(app, n);
    const siblings = known.filter((o) => appOf(o.id) === app).length;
    names.set(b.id, b.label ?? (siblings > 1 ? `${b.name} ${n}` : undefined));
  }
  return names;
}

/** How the model and the popup name a known browser. */
function nameOf(b: KnownBrowser, names: Map<string, string | undefined>): string {
  return names.get(b.id) ?? b.name;
}

/** The known browser a name from the model means: a profile's name, or an app with one profile. */
export function findProfile(
  known: readonly KnownBrowser[],
  wanted: string,
  names: Map<string, string | undefined> = profileNames(known)
): KnownBrowser | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  const byName = known.find((b) => nameOf(b, names).toLowerCase() === w);
  if (byName) return byName;
  const byApp = known.filter((b) => b.name.toLowerCase() === w);
  return byApp.length === 1 ? byApp[0]! : null;
}

/** "“Work” (Arc), “Personal” (Arc)" — the names the model may pass. */
function profileList(
  known: readonly KnownBrowser[],
  names: Map<string, string | undefined> = profileNames(known)
): string {
  return known
    .map((b) => {
      const name = nameOf(b, names);
      return name === b.name ? `“${name}”` : `“${name}” (${b.name})`;
    })
    .join(', ');
}

/** The browser Stem uses on this Mac when nothing else says which. */
function defaultId(settings: BrowserHostSettings): string | undefined {
  const chosen = settings.chosen && settings.known.some((b) => b.id === settings.chosen) ? settings.chosen : undefined;
  return chosen ?? settings.known[0]?.id;
}

/**
 * What one request may reach: every known profile, or only those the turn's
 * grant allows. Names stay those of the whole list, so "Arc 2" means the same
 * profile to every persona.
 */
interface Scope {
  /** The settings with `known` cut down to the allowed profiles (the default falls inside them). */
  settings: BrowserHostSettings;
  names: Map<string, string | undefined>;
  /** The grant limits the profiles. */
  limited: boolean;
}

export function scopeOf(settings: BrowserHostSettings, allowed: readonly string[] | undefined): Scope {
  const names = profileNames(settings.known);
  if (!allowed) return { settings, names, limited: false };
  const known = settings.known.filter((b) => allowed.includes(b.id));
  return { settings: { ...settings, known }, names, limited: true };
}

/** "mail.google.com, github.com" — the sites a hello says are most open there; anything else is dropped. */
function asHint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => /^[a-z0-9.-]{1,100}$/i.test(h))
    .slice(0, 3);
  return hosts.length ? hosts.join(', ') : undefined;
}

/** Is a process running this executable? Linux only: it reads /proc. */
function runningExe(exe: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      if (readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') === exe) return true;
    } catch {
      // quiet: another user's process, or one that just exited.
    }
  }
  return false;
}

/** Start a program on its own, answering once it started (or failed to). */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Is a process running this executable? Windows: one PowerShell question. */
function runningWindowsExe(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process | Where-Object { $_.Path -eq $args[0] } | Select-Object -First 1) { 'yes' }`, exe],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(!error && String(stdout).trim() === 'yes')
    );
  });
}

async function defaultLaunch(appPath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    // As on Linux: a second start of a running browser opens a window.
    if (await runningWindowsExe(appPath)) return;
    return spawnDetached(appPath, []);
  }
  if (platform === 'linux') {
    // Running a browser's executable again while it runs opens a new window;
    // the connection is only late, so leave the window count alone. Linux has
    // no `open -g`: a browser started here may come to the front.
    if (runningExe(appPath)) return Promise.resolve();
    return spawnDetached(appPath, []);
  }
  return new Promise((resolve, reject) => {
    // -g: do not bring it to the front; the user keeps working where they are.
    execFile('/usr/bin/open', ['-g', '-a', appPath], (error) => (error ? reject(error) : resolve()));
  });
}

function defaultOpenWith(appPath: string | null, target: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return appPath ? spawnDetached(appPath, [target]) : spawnDetached('explorer.exe', [target]);
  if (platform === 'linux') return appPath ? spawnDetached(appPath, [target]) : spawnDetached('xdg-open', [target]);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', appPath ? ['-a', appPath, target] : [target], (error) =>
      error ? reject(error) : resolve()
    );
  });
}

const isPipe = (path: string): boolean => path.startsWith('\\\\.\\pipe\\');

/** How long one action may take on this side before the extension is presumed stuck. */
export function actionTimeoutMs(action: ExtensionAction): number {
  switch (action.kind) {
    case 'wait':
      return (action.ms ?? 15_000) + 15_000;
    case 'downloads':
      return action.wait ? (action.ms ?? 30_000) + 15_000 : 30_000;
    case 'open':
    case 'navigate':
      return 45_000;
    default:
      return 60_000;
  }
}

export function createBrowserHost(deps: BrowserHostDeps): BrowserHost {
  const platform = deps.platform ?? process.platform;
  const supported = platform === 'darwin' || platform === 'linux' || platform === 'win32';
  // What the model and the user are told this computer is.
  const here = platform === 'darwin' ? 'Mac' : 'computer';
  const paths = deps.paths ?? browserInstallPaths();
  const launch = deps.launch ?? ((app: string) => defaultLaunch(app, platform));
  const launchWaitMs = deps.launchWaitMs ?? LAUNCH_WAIT_MS;
  const openWith = deps.openWith ?? ((app: string | null, target: string) => defaultOpenWith(app, target, platform));
  const conns = new Map<string, Conn>();
  const connectWaiters = new Set<() => void>();
  /** Upload folders per thread, removed when the run ends. */
  const uploadDirs = new Map<string, Set<string>>();
  /** The profile each live thread last named (KnownBrowser.id), until its run ends. */
  const threadProfile = new Map<string, string>();
  let server: Server | null = null;
  let config: BrowserHostConfig | null = null;
  /**
   * Browsers that may still run extension code older than the files on disk:
   * each gets one reload on its next hello, then leaves the set — the reloaded
   * extension says hello again, and a second reload would loop forever.
   */
  const reloadOwed = new Set<string>();

  const send = (conn: Conn, message: ToExtension): boolean => {
    const frame = encodeFrame(message);
    if (frame.length - 4 > MAX_TO_EXTENSION_BYTES) return false;
    conn.socket.write(frame);
    return true;
  };

  async function browsersNow(): Promise<{ browsers: BrowserInfo[]; chosen: string | null; enabled: boolean }> {
    const settings = await readBrowserHostSettings();
    // Known ones first, in the order they first connected, then any connection
    // whose remembering is still being written.
    const known = [...settings.known];
    for (const c of conns.values()) if (c.key && !known.some((b) => b.id === c.key)) known.push({ id: c.key, name: c.appName });
    const names = profileNames(known);
    const browsers: BrowserInfo[] = known.map((b) => {
      const c = conns.get(b.id);
      const profile = names.get(b.id);
      return {
        id: b.id,
        name: b.name,
        ...(profile ? { profile } : {}),
        ...(b.label ? { named: true } : {}),
        ...(b.hint ? { hint: b.hint } : {}),
        connected: !!c,
        ...(c?.version ? { version: c.version } : {})
      };
    });
    return { browsers, chosen: defaultId({ ...settings, known }) ?? null, enabled: settings.enabled };
  }

  async function announce(): Promise<void> {
    if (!supported) return;
    const { browsers, chosen, enabled } = await browsersNow();
    await deps
      .invoke('browserHost:announce', [
        {
          enabled,
          platform: platform === 'darwin' || platform === 'win32' ? platform : 'linux',
          // The sites open in a profile stay on this computer.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          browsers: browsers.map(({ hint, named, ...b }) => b),
          ...(chosen ? { chosen } : {}),
          enforcesProfiles: true
        }
      ])
      .catch((e) => {
        log('browser-host', 'could not announce', { error: e instanceof Error ? e.message : String(e) });
      });
  }

  /** Tell every connected extension what Stem calls its profile (a rename can shift the others' "Arc 2"). */
  async function sendNames(): Promise<void> {
    const known = (await readBrowserHostSettings()).known;
    const names = profileNames(known);
    for (const b of known) {
      const c = conns.get(b.id);
      if (c) send(c, { type: 'profile', name: nameOf(b, names) });
    }
  }

  /**
   * Remember the profile behind a hello. An entry from before profiles were
   * told apart (the bare app path) is taken over by the first profile of that
   * app to connect, keeping its place as the default.
   */
  async function remember(conn: Conn, key: string, hint: string | undefined): Promise<void> {
    await updateBrowserHostSettings((cur) => {
      const at = cur.known.findIndex((b) => b.id === key);
      if (at >= 0) {
        const known = [...cur.known];
        known[at] = { ...known[at]!, name: conn.appName, ...(hint ? { hint } : {}) };
        return { ...cur, known };
      }
      const entry: KnownBrowser = { id: key, name: conn.appName, ...(hint ? { hint } : {}) };
      const legacy = key !== conn.appPath ? cur.known.findIndex((b) => b.id === conn.appPath) : -1;
      if (legacy >= 0 && !conns.has(conn.appPath)) {
        const known = [...cur.known];
        known[legacy] = { ...entry, ...(known[legacy]!.label ? { label: known[legacy]!.label } : {}) };
        return { ...cur, known, ...(cur.chosen === conn.appPath ? { chosen: key } : {}) };
      }
      return { ...cur, known: [...cur.known, entry] };
    });
  }

  async function onHello(conn: Conn, message: Extract<FromExtension, { type: 'hello' }>): Promise<void> {
    conn.version = typeof message.extensionVersion === 'string' ? message.extensionVersion : undefined;
    const profile =
      typeof message.profileId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(message.profileId) ? message.profileId : null;
    // An extension from before 0.7.0 sends no profile id: one entry per app, as then.
    const key = profile ? `${conn.appPath}#${profile}` : conn.appPath;
    log('browser-host', 'the extension said hello', { browser: conn.appName, version: conn.version, profile: !!profile });
    if (conn.key !== key) {
      if (conn.key && conns.get(conn.key) === conn) conns.delete(conn.key);
      // A browser that restarted connects again before the old socket is
      // noticed gone: the new connection wins.
      const old = conns.get(key);
      if (old && old !== conn) old.socket.destroy();
      conn.key = key;
      conns.set(key, conn);
    }
    if (reloadOwed.delete(key) || reloadOwed.delete(conn.appPath)) {
      send(conn, { type: 'reload' });
      return;
    }
    await remember(conn, key, asHint(message.hint)).catch((e) =>
      log('browser-host', 'could not remember a browser', { error: String(e) })
    );
    for (const wake of [...connectWaiters]) wake();
    await sendNames();
    await announce();
  }

  function onFrame(conn: Conn, message: FromExtension): void {
    if (message.type === 'hello') {
      void onHello(conn, message);
      return;
    }
    if (message.type === 'result') {
      const settle = conn.pending.get(message.id);
      if (settle) {
        conn.pending.delete(message.id);
        settle(message.result);
      }
      return;
    }
    if (message.type === 'stopped' && typeof message.threadId === 'string' && message.threadId) {
      void deps
        .invoke('browserHost:event', [{ threadId: message.threadId, kind: 'stopped' }])
        .catch(() => undefined);
    }
  }

  function accept(socket: Socket): void {
    const reader = new FrameReader();
    let conn: Conn | null = null;
    /** Between the host's hello and its proof: what it claimed, and the nonce it must answer. */
    let pending: { appPath: string; appName: string; nonce: string } | null = null;
    const hello = setTimeout(() => socket.destroy(), 5000);
    hello.unref?.();
    socket.on('data', (chunk: Buffer) => {
      let bodies: Buffer[];
      try {
        bodies = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const body of bodies) {
        let message: unknown;
        try {
          message = JSON.parse(body.toString('utf8'));
        } catch {
          continue;
        }
        if (!conn && !pending) {
          const h = message as Partial<HostHello>;
          if (h?.type !== 'host-hello' || !config || !isNonce(h.nonce) || typeof h.appPath !== 'string') {
            log('browser-host', 'refused a native host that did not start the handshake');
            socket.destroy();
            return;
          }
          pending = {
            appPath: h.appPath,
            appName: typeof h.appName === 'string' && h.appName ? h.appName : 'Browser',
            nonce: newNonce()
          };
          socket.write(encodeFrame({ type: 'server-hello', nonce: pending.nonce, proof: handshakeProof(config.token, 'stem', h.nonce) }));
          continue;
        }
        if (!conn && pending) {
          const p = message as { type?: unknown; proof?: unknown };
          if (p?.type !== 'host-proof' || !config || !proofMatches(config.token, 'host', pending.nonce, p.proof)) {
            log('browser-host', 'refused a native host without the right token');
            socket.destroy();
            return;
          }
          clearTimeout(hello);
          const { appPath, appName } = pending;
          pending = null;
          // Which profile this is arrives with the extension's own hello,
          // right behind (the native host replays it on every connection).
          conn = { socket, key: null, appPath, appName, pending: new Map() };
          continue;
        }
        if (conn) onFrame(conn, message as FromExtension);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(hello);
      if (!conn) return;
      for (const settle of conn.pending.values()) {
        settle({
          ok: false,
          error:
            `${conn.appName} disconnected from Stem during the action (it quit, or the extension reloaded). ` +
            'The action may or may not have happened: check the page before repeating it.'
        });
      }
      conn.pending.clear();
      if (conn.key && conns.get(conn.key) === conn) {
        conns.delete(conn.key);
        void announce();
      }
    });
  }

  async function listen(): Promise<void> {
    if (!supported || server) return;
    config = await ensureHostConfig(paths);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    // A socket file left by a previous run (or a crash) would make listen fail.
    // A Windows pipe goes away with its last handle.
    if (!isPipe(config.socketPath)) await rm(config.socketPath, { force: true });
    const s = createServer(accept);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(config!.socketPath, () => resolve());
    });
    if (!isPipe(config.socketPath)) await chmod(config.socketPath, 0o600).catch(() => undefined);
    s.on('error', (e) => log('browser-host', 'socket error', { error: String(e) }));
    server = s;
  }

  /** The connection for a known browser (the default when none is named), launching it when it is not running. */
  async function connectionFor(
    settings: BrowserHostSettings,
    id?: string,
    scope?: Scope
  ): Promise<{ ok: true; conn: Conn } | { ok: false; error: string }> {
    const chosen = id ?? defaultId(scope?.settings ?? settings) ?? (scope?.limited ? undefined : [...conns.keys()][0]);
    if (!chosen && scope?.limited) {
      return {
        ok: false,
        error:
          'This conversation may use only some of the browser profiles on this Mac, and none of those is set up ' +
          'there any more. Tell the user to check which profiles it may use (the persona’s browser pin, or ' +
          'Settings → Features → Browser control for chats).'
      };
    }
    if (!chosen) {
      return {
        ok: false,
        error:
          `No browser with the Stem extension has connected on this ${here} yet. Tell the user to set it up in ` +
          `Settings → Features → Browser control → Set up, on that ${here}.`
      };
    }
    const live = conns.get(chosen);
    if (live) return { ok: true, conn: live };
    const entry = settings.known.find((b) => b.id === chosen);
    const app = appOf(chosen);
    const profiles = settings.known.filter((b) => appOf(b.id) === app).length;
    const name = entry ? nameOf(entry, profileNames(settings.known)) : chosen;
    if (!launchableBrowser(app, platform)) {
      // The id came from a native host's word; Stem starts only browsers it knows.
      return {
        ok: false,
        error: `${name} is not running, and Stem only starts browsers it knows on this ${here}. Tell the user to open it.`
      };
    }
    try {
      await launch(app);
    } catch (e) {
      return { ok: false, error: `${name} could not be started on this ${here}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const conn = await new Promise<Conn | null>((resolve) => {
      const wake = (): void => {
        const c = conns.get(chosen);
        if (!c) return;
        cleanup();
        resolve(c);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, launchWaitMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        connectWaiters.delete(wake);
      };
      connectWaiters.add(wake);
      wake();
    });
    if (conn) {
      log('browser-host', 'started the browser for a run', { browser: name });
      return { ok: true, conn };
    }
    if (profiles > 1) {
      return {
        ok: false,
        error:
          `The browser profile “${name}” is not open, and starting ${entry?.name ?? 'the browser'} did not bring it up ` +
          `within ${Math.round(launchWaitMs / 1000)}s. Ask the user to open a window of that profile, or use another profile.`
      };
    }
    return {
      ok: false,
      error:
        `${name} was started, but the Stem extension did not connect within ${Math.round(launchWaitMs / 1000)}s. It may be ` +
        `disabled or removed there; tell the user to check Settings → Features → Browser control on that ${here}.`
    };
  }

  /** One action on one connection. */
  function ask(conn: Conn, request: DeviceBrowserRequest, action: ExtensionAction): Promise<ExtensionResult> {
    return new Promise<ExtensionResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(request.requestId);
        resolve({
          ok: false,
          error:
            `${conn.appName} did not finish the action in time. It may or may not have happened: check the page ` +
            '(snapshot) before repeating it.'
        });
      }, actionTimeoutMs(action));
      conn.pending.set(request.requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const sent = send(conn, { type: 'request', id: request.requestId, threadId: request.threadId, action });
      if (!sent) {
        clearTimeout(timer);
        conn.pending.delete(request.requestId);
        resolve({ ok: false, error: 'The action is too large to hand to the browser (over 1 MB); shorten it.' });
      }
    });
  }

  /** Arc's sidebar tabs the extension could not list, as lines to add to a `tabs` answer. */
  async function arcExtra(loadedUrls: string[]): Promise<string> {
    const sidebar = await (deps.readArcSidebar ?? readArcSidebar)();
    return 'error' in sidebar ? sidebar.error : arcSidebarText(sidebar.tabs, loadedUrls);
  }

  /**
   * `tabs` with no profile named, on a Mac with several: every open profile's
   * tabs, under its name, so the model can find a page wherever it is. The
   * thread's own profile is listed (and started) even when it is closed.
   */
  async function tabsEverywhere(
    request: DeviceBrowserRequest,
    full: BrowserHostSettings,
    scope: Scope,
    current: string | undefined
  ): Promise<ExtensionResult> {
    const { settings, names } = scope;
    const targets: { entry: KnownBrowser; conn: Conn | null; error?: string }[] = [];
    for (const entry of settings.known) {
      const live = conns.get(entry.id) ?? null;
      if (live) targets.push({ entry, conn: live });
      else if (entry.id === current) {
        const opened = await connectionFor(full, entry.id);
        targets.push(opened.ok ? { entry, conn: opened.conn } : { entry, conn: null, error: opened.error });
      }
    }
    const answers = await Promise.all(
      targets.map(async (t) => (t.conn ? ask(t.conn, request, { kind: 'tabs' }) : ({ ok: false, error: t.error ?? '' } as const)))
    );
    const sections: string[] = [];
    const arcUrls: string[] = [];
    const downloads: ExtensionDownload[] = [];
    let arc = false;
    targets.forEach((t, i) => {
      const r = answers[i]!;
      const marks = [t.entry.id === current ? 'your current profile' : '', t.entry.id === defaultId(full) ? 'default' : '']
        .filter(Boolean)
        .join(', ');
      const name = nameOf(t.entry, names);
      const head = `## Profile “${name}”${name === t.entry.name ? '' : ` (${t.entry.name})`}${marks ? ` — ${marks}` : ''}`;
      sections.push(`${head}\n${r.ok ? (r.text ?? '') : `Its tabs could not be listed: ${r.error}`}`);
      if (r.ok && r.downloads) downloads.push(...r.downloads);
      if (t.conn && /\/Arc\.app$/.test(t.conn.appPath)) {
        arc = true;
        if (r.ok) arcUrls.push(...(r.urls ?? []));
      }
    });
    const closed = settings.known.filter((b) => !targets.some((t) => t.entry.id === b.id));
    const lines = [
      `${scope.limited ? 'This conversation may use' : "This Mac's browser has"} ${settings.known.length} profiles ` +
        `with Stem: ${profileList(settings.known, names)}. A tab id ` +
        'belongs to its profile: to work in a tab of another profile than your current one, pass that `profile` too ' +
        '(it then stays your profile for later calls).',
      ...sections,
      ...(closed.length ? [`Not open right now: ${profileList(closed, names)}.`] : [])
    ];
    if (arc) {
      const extra = await arcExtra(arcUrls);
      if (extra) lines.push(extra);
    }
    if (!answers.some((r) => r.ok)) return { ok: false, error: lines.join('\n\n') };
    return { ok: true, text: lines.join('\n\n'), ...(downloads.length ? { downloads } : {}) };
  }

  /** The device's action, as the extension takes it: an upload's files fetched to this Mac first. */
  async function localAction(request: DeviceBrowserRequest): Promise<ExtensionAction> {
    const action = request.action;
    if (action.kind !== 'upload') return action;
    // A folder name of our own, never one built from what came over the wire.
    const dir = join(paths.uploadsDir, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirs = uploadDirs.get(request.threadId) ?? new Set<string>();
    dirs.add(dir);
    uploadDirs.set(request.threadId, dirs);
    const local: string[] = [];
    for (const f of action.files) {
      if (typeof f.id !== 'string' || !/^[0-9a-f]{32}$/.test(f.id)) throw new Error('an upload named a file the server never queued');
      local.push(await deps.downloadOutbox(f.id, dir, f.name));
    }
    return { kind: 'upload', ref: action.ref, paths: local, ...(action.tab !== undefined ? { tab: action.tab } : {}) };
  }

  /** Stream finished downloads up; a failure is a line in the text, not a failed action. */
  async function remoteResult(result: ExtensionResult): Promise<DeviceBrowserResult> {
    if (!result.ok) return result;
    // `urls` is for execute (Arc's sidebar), never the server.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { downloads, urls, ...rest } = result;
    if (!downloads?.length) return rest;
    const receipts: BrowserDownloadReceipt[] = [];
    const notes: string[] = [];
    const spool = await realpath(paths.spoolDir).catch(() => null);
    for (const d of downloads) {
      // Only the native host's own copies, one folder deep in the spool: a
      // path anywhere else — the original in ~/Downloads when the copy failed,
      // or anything a peer on the socket made up — is never sent to the server.
      const real = spool ? await realpath(d.path).catch(() => null) : null;
      const folder = real ? dirname(real) : null;
      if (!spool || !real || !folder || dirname(folder) !== spool) {
        notes.push(`Download “${d.name}” finished on the ${here} but could not be copied for Stem; ask the user for the file.`);
        continue;
      }
      try {
        const handle = await deps.uploadFile(real);
        receipts.push({ handle, name: d.name, size: d.size, ...(d.mime ? { mime: d.mime } : {}) });
      } catch (e) {
        notes.push(`Download “${d.name}” finished on the ${here} but could not be sent to Stem: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The spool copy has done its job either way.
      void rm(folder, { recursive: true, force: true });
    }
    const text = [rest.text, ...notes].filter(Boolean).join('\n');
    return { ...rest, ...(text ? { text } : {}), ...(receipts.length ? { downloads: receipts } : {}) };
  }

  async function execute(request: DeviceBrowserRequest): Promise<DeviceBrowserResult> {
    if (!supported) return { ok: false, error: 'Browser control is only available on macOS, Windows and Linux.' };
    if (!(await readBrowserHostSettings()).enabled) {
      return {
        ok: false,
        error:
          `This ${here} does not let Stem drive its browser. The switch is in Settings → Features → Browser control, ` +
          'on that computer.'
      };
    }
    const full = await readBrowserHostSettings();
    // The persona's pin or the chat setting may limit the profiles: outside
    // them a profile is not listed, not found by name and never a fallback.
    const allowed = Array.isArray(request.allowed)
      ? request.allowed.filter((a): a is string => typeof a === 'string')
      : undefined;
    const scope = scopeOf(full, allowed);
    const settings = scope.settings;
    // Which profile: the one named in this call, else the one this thread
    // named last, else the default.
    let id: string | undefined;
    const wanted = typeof request.profile === 'string' ? request.profile.trim() : '';
    if (wanted) {
      const hit = findProfile(settings.known, wanted, scope.names);
      if (!hit) {
        const what = scope.limited ? 'This conversation may use no browser profile called' : 'This Mac has no browser profile called';
        const list = scope.limited ? 'The ones it may use' : 'Its profiles';
        return {
          ok: false,
          error: settings.known.length
            ? `${what} “${wanted.slice(0, 60)}”. ${list}: ${profileList(settings.known, scope.names)}.`
            : scope.limited
              ? `This conversation may use no browser profile called “${wanted.slice(0, 60)}”.`
              : `No browser has connected the Stem extension on this Mac yet, so there is no profile “${wanted.slice(0, 60)}”.`
        };
      }
      id = hit.id;
      threadProfile.set(request.threadId, id);
    } else {
      const last = threadProfile.get(request.threadId);
      id = last && settings.known.some((b) => b.id === last) ? last : undefined;
    }
    if (request.action.kind === 'tabs' && !wanted && settings.known.length > 1) {
      return remoteResult(await tabsEverywhere(request, full, scope, id ?? defaultId(settings)));
    }
    const target = await connectionFor(full, id ?? defaultId(settings), scope);
    if (!target.ok) return { ok: false, error: target.error };
    const conn = target.conn;
    let action: ExtensionAction;
    try {
      action = await localAction(request);
    } catch (e) {
      return { ok: false, error: `The files could not be brought to the ${here} for the upload: ${e instanceof Error ? e.message : String(e)}` };
    }
    const result = await ask(conn, request, action);
    if (action.kind === 'tabs' && result.ok && /\/Arc\.app$/.test(conn.appPath)) {
      const extra = await arcExtra(result.urls ?? []);
      if (extra) result.text = [result.text, extra].filter(Boolean).join('\n\n');
    }
    return remoteResult(result);
  }

  /** Reload every connected browser now, and owe one to each known browser that is not. */
  async function oweReload(): Promise<void> {
    for (const b of (await readBrowserHostSettings()).known) if (!conns.has(b.id)) reloadOwed.add(b.id);
    for (const c of conns.values()) send(c, { type: 'reload' });
  }

  async function refreshInstall(): Promise<void> {
    try {
      const refreshed = await refreshBrowserControl(deps.installSource(), paths, deps.home, platform);
      if (refreshed?.extensionChanged) {
        await oweReload();
      }
    } catch (e) {
      log('browser-host', 'could not refresh the installed extension', { error: String(e) });
    }
  }

  async function state(): Promise<BrowserHostLocalState> {
    const { browsers, chosen, enabled } = await browsersNow();
    return {
      supported,
      enabled,
      browsers,
      chosen,
      extensionPath: existsSync(paths.extensionDir) ? paths.extensionDir : null,
      setupBrowsers: supported ? setupBrowsers(deps.home, platform) : []
    };
  }

  return {
    async start() {
      if (!supported) return;
      try {
        await listen();
      } catch (e) {
        log('browser-host', 'could not listen for the extension', { error: String(e) });
      }
      await refreshInstall();
      await announce();
    },

    refresh: () => announce(),

    onRequest(request) {
      void (async () => {
        let result: DeviceBrowserResult;
        try {
          result = await execute(request);
        } catch (e) {
          result = { ok: false, error: `The action failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        await deps.invoke('browserHost:result', [request.requestId, result]).catch((e) => {
          log('browser-host', 'could not deliver a browser result', {
            error: e instanceof Error ? e.message : String(e)
          });
        });
      })();
    },

    onEnd({ threadId }) {
      threadProfile.delete(threadId);
      for (const c of conns.values()) send(c, { type: 'end', threadId });
      for (const dir of uploadDirs.get(threadId) ?? []) void rm(dir, { recursive: true, force: true });
      uploadDirs.delete(threadId);
    },

    localState: state,

    async setEnabled(enabled) {
      if (!supported) return state();
      await writeBrowserHostEnabled(enabled);
      await announce();
      return state();
    },

    async choose(id) {
      await updateBrowserHostSettings((cur) => (cur.known.some((b) => b.id === id) ? { ...cur, chosen: id } : cur));
      await announce();
      return state();
    },

    async rename(id, name) {
      const label = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROFILE_NAME);
      await updateBrowserHostSettings((cur) => {
        if (!cur.known.some((b) => b.id === id)) return cur;
        if (label && cur.known.some((b) => b.id !== id && b.label?.toLowerCase() === label.toLowerCase())) {
          throw new Error(`Another browser profile is already called “${label}”.`);
        }
        return {
          ...cur,
          known: cur.known.map((b) => {
            if (b.id !== id) return b;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { label: _old, ...rest } = b;
            return label ? { ...rest, label } : rest;
          })
        };
      });
      await sendNames();
      await announce();
      return state();
    },

    async forget(id) {
      if (conns.has(id)) return state();
      await updateBrowserHostSettings((cur) => {
        const known = cur.known.filter((b) => b.id !== id);
        if (cur.chosen !== id) return { ...cur, known };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { chosen: _gone, ...rest } = cur;
        return { ...rest, known };
      });
      reloadOwed.delete(id);
      await sendNames();
      await announce();
      return state();
    },

    async setUp() {
      if (!supported) return state();
      await listen().catch((e) => log('browser-host', 'could not listen for the extension', { error: String(e) }));
      const result = await installBrowserControl(deps.installSource(), paths, deps.home, platform);
      log('browser-host', 'set up browser control', { registered: result.registered });
      if (result.extensionChanged) {
        await oweReload();
      }
      return state();
    },

    async openExtensionsPage(browserId) {
      const settings = await readBrowserHostSettings();
      const known = browserId ?? defaultId(settings);
      const app = (known ? appOf(known) : null) ?? setupBrowsers(deps.home, platform)[0]?.app ?? null;
      // The path goes on the clipboard first, while Stem still has focus: Load
      // unpacked's picker takes it with ⌘⇧G (Ctrl+L in GTK's), which beats
      // hunting for a folder inside Application Support or ~/.config.
      try {
        deps.copyText?.(paths.extensionDir);
      } catch (e) {
        log('browser-host', 'could not copy the extension folder', { error: String(e) });
      }
      // Browsers refuse chrome:// URLs from outside, so the reliable half is
      // the folder: Finder (or the file manager) shows it, ready for Load unpacked. The browser still
      // comes forward, so typing its extensions page is all that is left.
      await openWith(null, paths.extensionDir).catch(() => undefined);
      // The renderer names the app; on Linux that is a program to run, so only a known browser.
      if (app && launchableBrowser(app, platform)) {
        await openWith(app, extensionsPageUrl(app)).catch(() => undefined);
      }
    },

    close() {
      for (const c of conns.values()) c.socket.destroy();
      conns.clear();
      server?.close();
      server = null;
      if (config && !isPipe(config.socketPath)) void rm(config.socketPath, { force: true });
    }
  };
}
