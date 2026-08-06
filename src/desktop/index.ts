import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { electronHost } from './host';
import { setHost } from '../server/host';
import { startServer, type ClientBridge, type ServerHandle } from '../server';
import { dispatchLocal } from '../server/ipc';
import { log } from '../server/log';
import { resolveProfileOverride } from '../server/workspace/paths';
import { bindServerChannels } from './ipc-bridge';
import { registerLocalIpc } from './local';
import { enableGlobalShortcutPortal, isLinux, isMac, mainWindowChromeOptions, requestAttention } from './platform';
import { createQuickChat } from './quickchat';
import { loadRenderer, PRELOAD_SCRIPT, RENDERER_DIR } from './renderer-assets';
import { initTray } from './tray';
import { RendererPushQueue } from './ui-lifecycle';
import type { AppSettings } from '../shared/types';

// The Electron main process: windows, tray, the global shortcut, app lifecycle,
// and the fan-out of everything the server pushes to the three renderer surfaces.
// It owns nothing about chats, memory, skills or settings — it starts a server
// (src/server) and talks to it.
//
// The dependency runs one way only. This file imports the server; nothing under
// src/server imports anything here. That rule is what makes a headless
// `stem-server` process possible, and the point of the whole split.

// Brand the app rather than inheriting Electron's defaults. setName fixes the
// app/process name and userData path; appIcon drives the dock (and, off macOS,
// the window) icon. Note: in dev the macOS menu-bar title still reads
// "Electron" — that comes from the Electron.app bundle and only changes when
// the app is packaged.
app.setName('Stem');

// Install the Electron half of the host shim before anything reads a
// userData-derived path, forks a worker, or touches a secret. Everything the
// server needs from its host now goes through this one seam (src/server/host);
// headless it falls back to plain-Node defaults.
setHost(electronHost());

// Alternate profiles: `--fresh` / `--profile=<name>` (or STEM_FRESH=1 / STEM_PROFILE=<name>)
// relocate ALL app state to an isolated userData dir under a sibling "Stem Profiles/"
// container, so the first-run onboarding can be walked as a brand-new user without touching
// the real signed-in profile. Must run before anything reads a userData-derived path (all of
// paths.ts is lazy and only fires after whenReady, so here is early enough). Resolved
// exactly once — `--fresh` mints a timestamped label, so a second call would
// disagree with the first.
const profileOverride = resolveProfileOverride();
const activeProfileLabel = profileOverride?.label ?? null;
if (profileOverride) {
  mkdirSync(profileOverride.userDataDir, { recursive: true });
  app.setPath('userData', profileOverride.userDataDir);
  console.log(
    `[stem] profile "${profileOverride.label}" → userData ${profileOverride.userDataDir}`
  );
}

// One Stem per profile. A second launch hands its argv to the running instance
// and exits: `stem --quick-chat` toggles the overlay (the summon path for
// Wayland, where Electron's globalShortcut never fires — users bind a DE
// shortcut to this command), a plain `stem` reveals the main window (the
// reopen path on Linux, where the app keeps running after the main window
// closes and stock GNOME hides the tray). Must run after the profile override
// so the lock keys off the final userData path (isolated E2E/profile runs
// never deflect each other).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', (_event, argv) => {
  // Ignore launches racing the whenReady bootstrap (windows not created yet).
  if (!windowsReady) return;
  if (argv.includes('--quick-chat')) quickChat.toggle();
  else revealMainWindow();
});

const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));

// In dev, expose a CDP port so tooling (agent-browser) can attach to the UI.
// 9222 is Chrome's own remote-debugging default — the chrome-cdp skill uses it
// on the user's local Chrome — so binding it here fails with EADDRINUSE and
// stderr-spams the terminal. Use 9224 instead: reserved for Stem's dev CDP,
// no collision with Chrome or Chromium-based tooling that camps 9222/9223.
// The port isn't functionally load-bearing; a stray collision only loses
// attach-for-tooling. Attach with --port=9224 or STEM_DEVTOOLS_PORT.
if (process.env.ELECTRON_RENDERER_URL) {
  const port = process.env.STEM_DEVTOOLS_PORT ?? '9224';
  app.commandLine.appendSwitch('remote-debugging-port', port);
}

// Global shortcuts through the XDG portal on Linux — the only path that works in
// a Wayland session. Must be set here: switches are read at Chromium startup.
enableGlobalShortcutPortal();

// Test seam: when STEM_E2E is set the server swaps in the hermetic FakeBackend.
// On this side it only suppresses the tray, to keep the harness's window/process
// accounting deterministic.
const E2E = !!process.env.STEM_E2E;

// ---- navigation ----

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return;
    void shell.openExternal(parsed.toString()).catch(() => undefined);
  } catch {
    // Ignore malformed renderer-provided URLs.
  }
}

function isAppNavigation(win: BrowserWindow, url: string): boolean {
  const current = win.webContents.getURL();
  if (!current) return false;
  try {
    const next = new URL(url);
    const cur = new URL(current);
    if (next.href === cur.href) return true;
    if (cur.protocol === 'file:' && next.protocol === 'file:' && next.pathname === cur.pathname) return true;
    return !!process.env.ELECTRON_RENDERER_URL && next.origin === cur.origin;
  } catch {
    return false;
  }
}

function installNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(win, url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

// ---- the main window ----

let mainWindow: BrowserWindow | null = null;
const mainPushQueue = new RendererPushQueue();
/** True once the persistent windows exist — see the second-instance handler. */
let windowsReady = false;

// True for the brief window around summoning the overlay. Showing the overlay
// activates the app, which fires `app.on('activate')`; without this guard that
// handler would recreate a previously-closed main window (and macOS would surface
// it), so summoning Quick Chat would "also open the main app."
let summoningOverlay = false;

/**
 * Create the main window. `hidden` is for a cold `stem --quick-chat` launch (the
 * DE-bound summon path): the window still loads — the backend prewarm and every
 * push destination hang off it — but the user only sees the overlay they asked
 * for. The tray's "Open Stem", a plain `stem`, or activation reveals it.
 */
function createWindow(hidden = false): void {
  mainPushQueue.reset();
  mainWindow = new BrowserWindow({
    show: !hidden,
    width: 1200,
    height: 820,
    // Surfaces in the macOS Window menu / Mission Control when running an alternate profile.
    title: activeProfileLabel ? `Stem — ${activeProfileLabel}` : 'Stem',
    // Inset traffic lights on macOS; the native frame elsewhere.
    ...mainWindowChromeOptions(),
    icon: appIcon,
    // Match the toolbar/chrome color so first paint doesn't flash; follows
    // the system appearance (the renderer adapts via prefers-color-scheme).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1916' : '#efece5',
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(mainWindow);

  // The renderer's HTML <title>Stem</title> otherwise clobbers the window title on
  // load; when running an alternate profile, keep the label pinned so the demo
  // window stays distinguishable in the macOS Window menu / Mission Control.
  if (activeProfileLabel) {
    const titled = mainWindow;
    titled.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      titled.setTitle(`Stem — ${activeProfileLabel}`);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainPushQueue.reset();
  });

  // Follow-me pill: surface a running main-window thread's progress when you leave
  // the main window (switch Spaces/apps), and dismiss it when you return.
  mainWindow.on('blur', () => quickChat.syncMainHud());
  mainWindow.on('focus', () => quickChat.hideMainHud());
  // Clear the taskbar/urgency flash raised by requestAttention (no-op on macOS,
  // where attention is a dock bounce that clears itself).
  if (!isMac) {
    const flashed = mainWindow;
    flashed.on('focus', () => {
      if (!flashed.isDestroyed()) flashed.flashFrame(false);
    });
  }

  loadRenderer(mainWindow);
}

/** Send to the main window, deferring until React has registered its IPC
 * subscriptions (a recreated BrowserWindow can finish loading before effects run). */
function sendToMain(channel: string, payload: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  for (const message of mainPushQueue.push({ channel, payload })) {
    win.webContents.send(message.channel, message.payload);
  }
}

/** Bring the main window to the front (recreating it if it was closed). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const quickChat = createQuickChat({
  mainWindow: () => mainWindow,
  sendToMain,
  revealMainWindow,
  installNavigationGuards,
  beginSummon: () => {
    // Cleared on the next tick, after the activation has been handled.
    summoningOverlay = true;
    setImmediate(() => {
      summoningOverlay = false;
    });
  }
});

// ---- server → client push ----
//
// Every push the server makes arrives here, and this table is the fan-out: which
// of the desktop's three windows a channel is for. In step 4 the same table sits
// behind an SSE subscription instead of a direct call; nothing else about it
// changes, which is why it is a table and not scattered `webContents.send` calls.
function emitToClient(channel: string, payload: unknown): void {
  switch (channel) {
    // Approval cards: both surfaces mount them, and the overlay hides itself
    // while a turn runs — bring it back when the request belongs to its thread,
    // or mounting the card would not actually make the confirmation visible.
    case 'exec:approvalRequest':
    case 'mcp:adminApproval':
    case 'instructions:approvalRequest':
    case 'skills:approvalRequest':
      quickChat.revealIfOwns((payload as { threadId?: string } | undefined)?.threadId);
      sendToMain(channel, payload);
      quickChat.sendToOverlay(channel, payload);
      return;
    // Resolutions and catalog/status changes: rendered by both surfaces, and
    // harmlessly ignored by whichever one has no listener mounted.
    case 'exec:approvalResolved':
    case 'mcp:adminApprovalResolved':
    case 'instructions:approvalResolved':
    case 'skills:approvalResolved':
    case 'mcp:changed':
    case 'mcp:status':
    case 'skills:changed':
      sendToMain(channel, payload);
      quickChat.sendToOverlay(channel, payload);
      return;
    default:
      // Everything else is main-window furniture: sign-in progress, the task
      // feed and its alerts, background-activity and model-download status.
      sendToMain(channel, payload);
  }
}

const clientBridge: ClientBridge = {
  emit: emitToClient,
  routeBackendEvent: (event) => quickChat.routeBackendEvent(event),
  threadOpened: (threadId) => quickChat.threadOpened(threadId),
  applyQuickChatSettings: (patch, next) => quickChat.applySettings(patch, next),
  hasLiveTurn: () => quickChat.hasLiveTurn(),
  revealMainWindow,
  requestAttention: () => requestAttention(mainWindow)
};

// Last-resort diagnostics: an uncaught throw or rejection otherwise vanishes with
// the console. Log-and-continue — Electron's default for unhandledRejection is a
// warning, and killing the process over a background hiccup (a failed distill, a
// dropped watcher) would take the whole app down.
process.on('uncaughtException', (e) => {
  log('main', 'uncaughtException', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});
process.on('unhandledRejection', (reason) => {
  log('main', 'unhandledRejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  });
});

let server: ServerHandle | null = null;

app.whenReady().then(async () => {
  // Strict CSP for the renderer in production: only self, no remote/inline
  // script. Skipped in dev so the Vite dev server / HMR can run. Installed
  // before any window is created, so nothing can load without it.
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"]
        }
      });
    });
  }

  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  server = await startServer({
    client: clientBridge,
    alternateProfile: !!profileOverride,
    // Serving the phone's bundle out of the same place the desktop renderer is
    // loaded from keeps the two builds together.
    rendererDir: RENDERER_DIR,
    devUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });

  // Everything the renderer can invoke, bound to ipcMain: the server's whole
  // registry plus this machine's own handlers. Before any window exists, so no
  // renderer can race a missing channel.
  registerLocalIpc({ mainWindow: () => mainWindow });
  quickChat.registerIpc();
  ipcMain.on('renderer:ready', (event) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    for (const { channel, payload } of mainPushQueue.markReady()) win.webContents.send(channel, payload);
  });
  bindServerChannels();

  // A cold `stem --quick-chat` must land on the overlay, not the main window:
  // that command IS the shortcut on Wayland (see the second-instance handler),
  // and pressing it with Stem closed should feel the same as pressing it with
  // Stem running. The overlay is summoned once it exists, below.
  const coldSummon = process.argv.includes('--quick-chat');
  createWindow(coldSummon);
  // Eagerly spawn pi + connect MCP once the window has painted, so the first prompt
  // doesn't pay backend cold-start. did-finish-load keeps the spawn + MCP child
  // processes off the first-paint path. Fire-and-forget; races harmlessly with the
  // renderer's listModels warm.
  mainWindow?.webContents.once('did-finish-load', () => {
    void server?.prewarm();
  });

  const settings = (await dispatchLocal('settings:get', [])) as AppSettings;
  quickChat.start(settings.quickChat);
  windowsReady = true;
  if (coldSummon) quickChat.toggle();
  // Linux-only for now: the tray is the discoverable summon/quit affordance where
  // there's no dock and (on Wayland) no working global shortcut. Skipped under
  // STEM_E2E to keep the harness's window/process accounting deterministic.
  if (isLinux && !E2E) {
    initTray({
      icon: appIcon,
      onToggleQuickChat: () => quickChat.toggle(),
      onOpenStem: revealMainWindow
    });
  }

  app.on('activate', () => {
    // Don't recreate the main window when the activation was triggered by summoning
    // the Quick Chat overlay — that would reopen a closed main window unbidden.
    if (summoningOverlay || quickChat.overlayVisible()) return;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}).catch((error) => {
  console.error('Failed to start Stem:', error);
  app.quit();
});

// Shut the server down gracefully before quitting. preventDefault + await gives
// it a window to drain in-flight work, then we exit for real (shutdown has its
// own SIGKILL backstop).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  server.shutdown().finally(() => app.exit(0));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Dead-in-practice by design: the overlay + HUD windows are created at startup
  // and only ever hidden, so this event can't fire while they exist. Closing the
  // main window therefore leaves Stem running on every platform — on Linux the
  // way back in is the tray, `stem` (second-instance reveal), or `stem
  // --quick-chat`; quitting is the tray's Quit item. Kept as the standard idiom
  // for the day the persistent windows become closable.
  if (process.platform !== 'darwin') app.quit();
});
