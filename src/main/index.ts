import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell
} from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { createBackend, type ChatBackend } from './backend';
import {
  handleIpc,
  registerAuthIpc,
  registerChatsIpc,
  registerMcpIpc,
  registerMemoryIpc,
  registerWorkspaceIpc,
  type IpcDeps
} from './ipc';
import { log } from './log';
import {
  failQuickChatProcess,
  HudPill,
  OverlaySession,
  QuickChatHandoffBarrier,
  QuickChatResetBarrier,
  RendererPushQueue
} from './ui-lifecycle';
import { ensureWorkspace } from './workspace/bootstrap';
import { publishProtectedRootsNow } from './workspace/connected-folders';
import {
  embedModelsDir,
  embedSocketPath,
  piHome,
  recallDbPath,
  resolveProfileOverride
} from './workspace/paths';
import { TaskScheduler } from './scheduler';
import { ProviderAuth } from './pi/provider-auth';
import { isRecallEnabled } from './workspace/memory';
import { captureFromEvent } from './recall/capture';
import {
  getFactsGeneration,
  getFactsMissingVector,
  pruneMessageVectorsExceptModel,
  pruneSummaryVectorsExceptModel,
  pruneVectorsExceptModel,
  getSummariesMissingVector,
  upsertFactVectorForSnapshot,
  upsertSummaryVector
} from './recall/store';
import { embedNewMessages } from './recall/embed-episodic';
import { backfillSummaries, refreshRecentSummaries } from './recall/summarize';
import { distillNewMessages, shouldConsolidate } from './recall/distill';
import { consolidateFacts } from './recall/consolidate';
import { getMemoryRebuildStatus, runMemoryRebuildStep } from './recall/rebuild';
import { curateSkills } from './skills/curate';
import { distillSkillsFromMessages } from './skills/distill';
import { getEmbeddingsClient, setRetrievalClients } from './recall/retrieval';
import { startEmbedEndpoint } from './recall/embed-endpoint';
import { createHttpEmbeddingsClient } from './recall/embeddings';
import { createHttpRerankClient } from './recall/rerank';
import { EMBED_CATALOG, localModelCacheKey } from './recall/embed-catalog';
import { createEmbedWorkerManager } from './recall/embed-manager';
import type { EmbedWorkerManager } from './recall/embed-manager';
import { createEmbeddingsRouter, createLocalEmbeddingsClient } from './recall/embed-local';
import { RERANK_CATALOG } from './recall/rerank-catalog';
import { createLocalRerankClient, createRerankRouter } from './recall/rerank-local';
import { spawnEmbedWorker } from './recall/embed-worker-host';
import { createScanWorkerManager } from './recall/scan-manager';
import type { ScanWorkerManager } from './recall/scan-manager';
import { spawnScanWorker } from './recall/scan-worker-host';
import { setScanWorkerManager } from './recall/scan';
import type { LlmClient } from './recall/llm';
import { backfillChatIndex, reindexChatThread } from './chatsearch/index-sync';
import {
  markOnboardingCompleted,
  readSettings,
  updateCustomInstructions,
  updateDefaultModel,
  updateEscapeAction,
  updateMemorySettings,
  updateNativeWebSearch,
  updateQuickChat,
  updateRetrievalSettings,
  updateSkillsSettings
} from './workspace/settings';
import { activityLabel } from '../shared/activity';
import type {
  BackendEventEnvelope,
  CustomInstructionsSettings,
  EscapeAction,
  ItemEventParams,
  MemoryModelSettings,
  ModelSummary,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  RetrievalTestResult,
  SkillsModelSettings,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatStatus,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Prefer IPv4 for all main-process networking. auth.openai.com (and other OAuth
// token endpoints) are dual-stack, but many networks have no working IPv6 route;
// Electron's main-process fetch would then try an AAAA address and die with a bare
// "fetch failed" (EHOSTUNREACH) instead of falling back — breaking the OAuth token
// exchange right after the browser shows "authentication successful". Ordering
// IPv4 first, plus enabling Happy Eyeballs (parallel v4/v6 with fallback), makes
// the token exchange behave like curl and the system browser. Guarded for older
// runtimes that lack the setters.
dns.setDefaultResultOrder?.('ipv4first');
net.setDefaultAutoSelectFamily?.(true);
net.setDefaultAutoSelectFamilyAttemptTimeout?.(1000);

// Brand the app rather than inheriting Electron's defaults. setName fixes the
// app/process name and userData path; appIcon drives the dock (and, off macOS,
// the window) icon. Note: in dev the macOS menu-bar title still reads
// "Electron" — that comes from the Electron.app bundle and only changes when
// the app is packaged.
app.setName('Stem');

// Alternate profiles: `--fresh` / `--profile=<name>` (or STEM_FRESH=1 / STEM_PROFILE=<name>)
// relocate ALL app state to an isolated userData dir under a sibling "Stem Profiles/"
// container, so the first-run onboarding can be walked as a brand-new user without touching
// the real signed-in profile. Must run before anything reads a userData-derived path (all of
// paths.ts is lazy and only fires after whenReady, so here is early enough).
const profileOverride = resolveProfileOverride();
const activeProfileLabel = profileOverride?.label ?? null;
if (profileOverride) {
  mkdirSync(profileOverride.userDataDir, { recursive: true });
  app.setPath('userData', profileOverride.userDataDir);
  console.log(
    `[stem] profile "${profileOverride.label}" → userData ${profileOverride.userDataDir}`
  );
}

const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));

// In dev, expose a CDP port so tooling (agent-browser) can attach to the UI.
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

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

let mainWindow: BrowserWindow | null = null;
const mainPushQueue = new RendererPushQueue();
let quickChatWindow: BrowserWindow | null = null;
/** Bottom-left status pill shown while the overlay is hidden and a turn runs. */
let hudWindow: BrowserWindow | null = null;
let runtime: ChatBackend | null = null;
/** Scheduled-tasks engine (cron/once → autonomous turns). Created in whenReady. */
let scheduler: TaskScheduler | null = null;
/** The currently-registered global accelerator, so we can unregister on change. */
let currentShortcut: string | null = null;
/** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
let overlayOnAllDisplays = true;
/** Cached inactivity timeout (ms) after which a summon starts a fresh thread. */
let newThreadTimeoutMs = 5 * 60_000;

// ---- Quick Chat session ownership ----
//
// The overlay owns one live conversation at a time. While it owns a thread, that
// thread's backend events route to the overlay (not the main window) and drive the
// status HUD. Hand-off (button, or opening the thread from the sidebar) routes
// events to the main window from then on. All of that state lives in `overlay`
// (see OverlaySession) — every mutation is a named transition, never a bare flag.
const overlay = new OverlaySession();
const overlayHandoffBarrier = new QuickChatHandoffBarrier();
/** A manual reset requested while the old overlay turn was still settling. Keep
 * ownership long enough to route that turn's terminal event, then release it. */
const overlayResetBarrier = new QuickChatResetBarrier();

// ---- Follow-me status pill (main-window threads) ----
//
// The bottom-left pill is shared between Quick Chat and the main app. While the
// main window is unfocused (you switched Spaces/apps) and a main-window thread is
// running, the pill mirrors that progress so you don't lose sight of it.
/** Show the pill for main threads when the main window loses focus. */
let followAcrossSpaces = true;
/** Play a chime when a turn finishes while the pill is visible. */
let finishSound = false;
/** Main-window threads currently running (working/answering), keyed by threadId. */
const runningMainThreads = new Set<string>();
// When the user last started/stopped a turn (main or Quick Chat). Drives the
// scheduler's isUserActive signal so scheduled runs defer while they're chatting.
let lastInteractiveAt = 0;
let scheduleMemoryRebuild: () => void = () => {};
// How long after the last interaction the user still counts as "active".
const USER_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
/** Ownership + last phase of the shared pill (chime edge detection) — see HudPill. */
const hud = new HudPill();

// True for the brief window around summoning the overlay. Showing the overlay
// activates the app, which fires `app.on('activate')`; without this guard that
// handler would recreate a previously-closed main window (and macOS would surface
// it), so summoning Quick Chat would "also open the main app."
let summoningOverlay = false;

// All-Spaces visibility for the overlay. `skipTransformProcessType: true` is
// critical: without it, macOS flips the app between accessory and foreground
// process types on every call — which briefly hides the dock icon AND all app
// windows, and re-activates the app (pulling the main window forward). We apply
// this exactly once per window (at creation) and on settings change, never per
// show, so summoning the overlay never disturbs the main window or dock.
function applyOverlayWorkspaceVisibility(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.setVisibleOnAllWorkspaces(overlayOnAllDisplays, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
  }
}

function createWindow(): void {
  mainPushQueue.reset();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    // Surfaces in the macOS Window menu / Mission Control when running an alternate profile.
    title: activeProfileLabel ? `Stem — ${activeProfileLabel}` : 'Stem',
    titleBarStyle: 'hiddenInset',
    icon: appIcon,
    // Vertically center the inset traffic lights within the 52px toolbar.
    trafficLightPosition: { x: 19, y: 20 },
    // Match the toolbar/chrome color so first paint doesn't flash; follows
    // the system appearance (the renderer adapts via prefers-color-scheme).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1916' : '#efece5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
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
  mainWindow.on('blur', syncMainHud);
  mainWindow.on('focus', () => {
    if (hud.owner === 'main') hideHud();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---- Quick Chat overlay (Spotlight-style) ----
//
// A frameless, always-on-top, transparent panel that loads the same renderer
// with a `?quickchat` flag. Created once at startup and reused (shown/hidden)
// so summoning it is instant and never loses the user's draft mid-stream.

// The window IS the frosted card (native vibrancy + rounded corners + native
// shadow), so these are the card's own dimensions — no extra room reserved for a
// CSS shadow as before.
const QUICK_CHAT_WIDTH = 596;
// Compact spotlight bar (fresh session) vs. expanded conversation panel (resuming
// a session with messages). The overlay window is resized between the two on show.
const QUICK_CHAT_HEIGHT = 108;
const QUICK_CHAT_PANEL_HEIGHT = 518;

// Bottom-left status HUD pill.
const HUD_WIDTH = 320;
const HUD_HEIGHT = 46;

function createQuickChatWindow(): void {
  quickChatWindow = new BrowserWindow({
    width: QUICK_CHAT_WIDTH,
    height: QUICK_CHAT_HEIGHT,
    frame: false,
    // A macOS NSPanel (not a normal window): it can take keyboard focus to type
    // WITHOUT activating Stem, so summoning it never drags the main window forward,
    // and hiding it never promotes the main window to the front. This is the
    // Spotlight/Raycast-style overlay behavior.
    type: 'panel',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // Native macOS frosting: an NSVisualEffectView blurs the desktop behind the
    // window (real refraction, unlike CSS backdrop-filter on a transparent window).
    // The window itself is the rounded card — corners and the drop shadow are drawn
    // natively (roundedCorners + hasShadow), so no CSS shadow/padding hacks.
    vibrancy: 'under-window',
    visualEffectState: 'active', // keep the material lit even when not key
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(quickChatWindow);

  // Float above full-screen apps. All-Spaces visibility is applied once here
  // (see applyOverlayWorkspaceVisibility) rather than on every show.
  quickChatWindow.setAlwaysOnTop(true, 'screen-saver');
  applyOverlayWorkspaceVisibility();

  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
  });
  // No blur→hide: the overlay now persists a conversation the user re-summons to
  // read, so auto-hiding on focus loss would discard the answer they just opened.
  // Dismissal is explicit only (Escape / shortcut / submit / hand-off).

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    quickChatWindow.loadURL(`${devUrl}/?quickchat`);
  } else {
    quickChatWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: 'quickchat' });
  }
}

// The status HUD: a tiny, non-focusable, always-on-top pill in the bottom-left.
// `focusable: false` is critical — showing it must never steal focus from the app
// the user is working in. Created once and reused like the overlay.
function createHudWindow(): void {
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(hudWindow);

  // The status pill must float above everything and follow the user across every
  // Space and into full-screen apps — unlike the overlay, this is unconditional
  // (not tied to the `overlayOnAllDisplays` preference): the pill is the only
  // signal that a turn is still running once the overlay is hidden.
  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  hudWindow.on('closed', () => {
    hudWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    hudWindow.loadURL(`${devUrl}/?hud`);
  } else {
    hudWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: 'hud' });
  }
}

/** Play a macOS finish chime (built-in system sound; no bundled asset). */
function playFinishChime(): void {
  if (process.platform !== 'darwin') return;
  try {
    spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' }).unref();
  } catch {
    // Sound is best-effort; never let it break the turn lifecycle.
  }
}

/**
 * Show the HUD pill (bottom-left of the display under the cursor) and push status.
 * `owner` records whether Quick Chat or the follow-me path is driving it. The chime
 * fires once, on the transition into 'finished' while the pill is visible.
 */
function showHud(status: QuickChatStatus, owner: 'quickchat' | 'main'): void {
  if (!hudWindow || hudWindow.isDestroyed()) createHudWindow();
  const win = hudWindow!;
  if (!win.isVisible()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds({
      x: Math.round(workArea.x + 16),
      y: Math.round(workArea.y + workArea.height - HUD_HEIGHT - 16),
      width: HUD_WIDTH,
      height: HUD_HEIGHT
    });
    win.showInactive(); // show without stealing focus
  }
  const enteredFinished = hud.notePush(owner, status.phase);
  // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
  win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
  if (enteredFinished && finishSound) playFinishChime();
}

function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
  hud.noteHidden();
}

function finishOverlayReset(): void {
  overlay.releaseThread();
  overlayResetBarrier.settle();
}

/**
 * HUD state machine, driven by the overlay-owned thread's event stream. Only runs
 * while the overlay is hidden (when it's visible the user is reading, no HUD):
 *   working  -> "Thinking…" / "Searching the web…" / "Using a tool…"
 *   answering -> once the first answer text streams
 *   finished  -> once the turn completes
 */
function driveHud(event: { method: string; params: unknown }): void {
  const overlayVisible = quickChatWindow?.isVisible() ?? false;
  switch (event.method) {
    case 'item/started': {
      if (overlayVisible) break;
      const item = (event.params as ItemEventParams)?.item;
      const type = item?.type;
      // Always update — tool calls and teed web searches mid-answer keep the
      // pill live instead of freezing at 'Answering…' after the first token.
      if (type && type !== 'agentMessage')
        showHud({ phase: 'working', label: activityLabel(type, item?.name, item?.detail) }, 'quickchat');
      break;
    }
    case 'item/agentMessage/delta': {
      if (overlayVisible) break;
      // Deltas arrive per token; only push when the label actually changes
      // (first token, or resuming the answer after a mid-answer tool call).
      if (!overlay.hudTextSeen || hud.lastPhase !== 'answering') {
        overlay.noteAnswerText();
        showHud({ phase: 'answering', label: 'Answering…' }, 'quickchat');
      }
      break;
    }
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      const label =
        event.method === 'turn/completed'
          ? 'Answer ready'
          : event.method === 'turn/failed'
            ? 'Request failed'
            : 'Stopped';
      overlay.settleTurn(Date.now());
      // A reset must not release the old thread until this terminal event has
      // been routed. Otherwise its trailing deltas can be mistaken for the next
      // Quick Chat session.
      if (overlayResetBarrier.pending) {
        overlay.resetHudText();
        if (hud.owner === 'quickchat') hideHud();
        finishOverlayReset();
      } else if (!overlayVisible) {
        showHud({ phase: 'finished', label }, 'quickchat');
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Follow-me pill: while the main window is unfocused (you switched Spaces/apps)
 * and a main-window thread is running, mirror its progress in the shared pill.
 * No-ops while Quick Chat owns the pill (it takes priority) or the feature is off.
 */
function syncMainHud(): void {
  if (!followAcrossSpaces) {
    if (hud.owner === 'main') hideHud();
    return;
  }
  if (hud.owner === 'quickchat') return;
  const blurred = !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused();
  const running = runningMainThreads.size > 0;
  if (running && blurred) {
    showHud({ phase: 'working', label: 'Working…', reveal: 'main' }, 'main');
  }
}

/**
 * Track which main-window threads are running and drive the follow-me pill. The
 * 'finished' transition (and its chime) only fires when the pill is already
 * shown for the main app (hud.owner === 'main') — i.e. the user is away.
 */
function noteMainThreadEvent(method: string, threadId: string): void {
  if (method === 'item/started' || method === 'item/agentMessage/delta') {
    runningMainThreads.add(threadId);
    syncMainHud(); // handles a thread that starts while you're already away
  } else if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted') {
    runningMainThreads.delete(threadId);
    if (hud.owner === 'main' && runningMainThreads.size === 0) {
      const label =
        method === 'turn/completed' ? 'Answer ready' : method === 'turn/failed' ? 'Request failed' : 'Stopped';
      showHud({ phase: 'finished', label, reveal: 'main' }, 'main');
    }
  }
}

/**
 * Show the overlay. `reset` true => start a fresh session (compact spotlight bar);
 * false => resume the existing session (expanded conversation panel, showing the
 * answer the user re-summoned to read). The overlay's React state persists across
 * hide/show, so resuming needs no payload beyond the reset flag.
 */
function showQuickChat(reset: boolean): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) createQuickChatWindow();
  const win = quickChatWindow!;
  hideHud();

  // Suppress the activate-driven main-window recreation for this summon (cleared
  // on the next tick, after the activation has been handled).
  summoningOverlay = true;
  setImmediate(() => {
    summoningOverlay = false;
  });

  // Center horizontally on the display under the cursor, in the upper third.
  // Compact when starting fresh; expanded to a panel when resuming a session.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = QUICK_CHAT_WIDTH;
  const h = reset ? QUICK_CHAT_HEIGHT : QUICK_CHAT_PANEL_HEIGHT;
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    width: w,
    height: h
  });
  // show() orders the panel front; focus() makes it the key window so it actually
  // receives keystrokes (typing, Escape). Because it's a non-activating panel,
  // focus() makes it key WITHOUT activating Stem — the previous app stays active
  // underneath and the main window is never pulled forward.
  win.show();
  win.focus();
  win.webContents.send('quickchat:focus', { reset });
}

/**
 * Hide the overlay on an explicit dismiss (Escape, or the shortcut pressed again).
 * The overlay is a non-activating panel, so hiding it does not promote Stem's main
 * window to the front and the previously-active app keeps focus — we just hide the
 * panel (no app.hide, which would also hide the main window and the HUD).
 */
function dismissQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
  }
}

/** Hide just the overlay window (without app.hide), so the HUD can stay visible. */
function hideOverlayWindow(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) quickChatWindow.hide();
}

function toggleQuickChat(): void {
  if (quickChatWindow && quickChatWindow.isVisible()) {
    dismissQuickChat();
    return;
  }
  // Decide continue-vs-fresh: no live session, already handed off, or idle past
  // the configured timeout => start a new thread. Clear ownership up front so the
  // old thread's events stop routing to the (now reset) overlay.
  const reset = overlay.shouldStartFresh(Date.now(), newThreadTimeoutMs);
  if (reset) overlay.clearForFreshSession();
  showQuickChat(reset);
}

/** (Re)register the global accelerator. Returns false when registration fails. */
function applyQuickChatShortcut(accelerator: string | null): boolean {
  if (currentShortcut) {
    globalShortcut.unregister(currentShortcut);
    currentShortcut = null;
  }
  if (!accelerator) return true;
  try {
    const ok = globalShortcut.register(accelerator, toggleQuickChat);
    if (ok) currentShortcut = accelerator;
    return ok;
  } catch {
    return false;
  }
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

async function captureQuickChatHandoff(threadId: string): Promise<{
  id: string;
  snapshot: QuickChatHandoff;
} | null> {
  const win = quickChatWindow;
  if (!win || win.isDestroyed()) return null;
  const ticket = overlayHandoffBarrier.begin(threadId);
  if (ticket.fresh) win.webContents.send('quickchat:handoffRequest', { id: ticket.id, threadId });
  const timer = setTimeout(() => {
    const buffered = overlayHandoffBarrier.cancel(ticket.id);
    for (const event of buffered) {
      if (!win.isDestroyed()) win.webContents.send('backend:event', event);
      driveHud(event);
    }
  }, 30_000);
  const snapshot = await ticket.promise;
  clearTimeout(timer);
  if (!snapshot) return null;
  // Keep the barrier installed until the caller flips ownership. Otherwise an
  // event can arrive between this await and chats:open marking the overlay as
  // handed off, and be routed back to Quick Chat after its snapshot was taken.
  return { id: ticket.id, snapshot };
}

/** Bring the main window to the front (recreating it if it was closed). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Test seam: when STEM_E2E is set, createBackend() returns the hermetic
// FakeBackend (see backend/fake.ts) — real IPC, event routing, renderers,
// Recall, and scheduler over deterministic scripted turns. The remaining
// E2E branches below fake only what lives OUTSIDE the backend seam: network
// probes, browser OAuth, and the embedding worker (model downloads).
const E2E = !!process.env.STEM_E2E;

// In-app provider sign-in (OAuth / API key) for the onboarding wizard; created in
// the whenReady bootstrap alongside the runtime.
let providerAuth: ProviderAuth | null = null;

/** Pick a sensible app default from the models the signed-in providers expose. */
function chooseDefaultModel(models: ModelSummary[]): string | null {
  const pick =
    models.find((m) => m.provider === 'openai-codex' && m.id.endsWith('gpt-5.3-codex-spark')) ??
    models.find((m) => m.provider === 'anthropic' && /sonnet/i.test(m.id)) ??
    models.find((m) => m.provider === 'anthropic') ??
    models[0];
  return pick?.id ?? null;
}

/**
 * Post-sign-in sequence: persist a default model matching the new provider,
 * restart pi so it re-reads auth.json (it loads credentials once at spawn),
 * and bring up the scheduler. Returns the fresh status for the renderer.
 */
async function onAuthenticated(): Promise<RuntimeStatus> {
  try {
    // listModels spawns pi if needed (doubles as the wizard's prewarm) and is
    // already filtered to providers with credentials.
    const models = await runtime!.listModels();
    const current = (await readSettings()).defaults.model;
    if (!current || !models.some((m) => m.id === current)) {
      // Re-pick when unset or the provider that served the default is gone; an
      // empty list (last provider disconnected) clears it back to the constant.
      await updateDefaultModel(chooseDefaultModel(models));
    }
  } catch {
    // model list unavailable — keep the built-in default
  }
  // Apply fresh credentials + the new default to the running process.
  await runtime!.restart().catch(() => undefined);
  void scheduler?.start();
  return runtime!.status();
}

// Local embedding worker manager (created in the whenReady bootstrap; null until
// then and under E2E, where downloading model weights would break hermeticity).
let embedManager: EmbedWorkerManager | null = null;
// Recall scan worker manager (cosine scans + episodic VACUUM off the main event
// loop). Created in the whenReady bootstrap; the worker itself spawns lazily.
let scanManager: ScanWorkerManager | null = null;

function registerIpc(): void {
  ipcMain.on('renderer:ready', (event) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    for (const { channel, payload } of mainPushQueue.markReady()) win.webContents.send(channel, payload);
  });

  ipcMain.on('quickchat:handoffSnapshot', (event, id: string, payload: QuickChatHandoff) => {
    const win = quickChatWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    overlayHandoffBarrier.supply(id, payload);
  });

  handleIpc('runtime:status', (): Promise<RuntimeStatus> => runtime!.status());
  handleIpc('runtime:login', async () => {
    const status = await runtime!.login();
    // Signing in mid-session: start the scheduler now (idempotent) so tasks load and
    // catch-up runs without waiting for a restart.
    if (status.ok) void scheduler?.start();
    return status;
  });

  // Per-domain IPC surfaces (auth/providers, skills/files/cfolders/tasks/dialogs,
  // MCP + approvals, memory, chats/folders) live in ./ipc/*; they reach the
  // late-bound singletons through getters so registration can happen up front.
  const deps: IpcDeps = {
    e2e: E2E,
    runtime: () => runtime!,
    scheduler: () => scheduler,
    providerAuth: () => providerAuth,
    embedManager: () => embedManager,
    mainWindow: () => mainWindow,
    sendToMain,
    onAuthenticated,
    scheduleMemoryRebuild: () => scheduleMemoryRebuild()
  };
  registerAuthIpc(deps);
  registerWorkspaceIpc(deps);
  registerMcpIpc(deps);
  registerMemoryIpc(deps);
  registerChatsIpc(deps);

  handleIpc('backend:startTurn', async (_e, input: StartTurnInput) => {
    // The user is actively chatting: yield any scheduler-owned turn (frees the
    // foreground gate) and hold scheduled runs off for a while.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    // Main-window turns honor the main native-web-search toggle (the backend no-ops
    // it for providers without native search).
    const settings = await readSettings();
    // Main-window turns get the Main custom instructions (which also cover Quick Chat
    // by inheritance; Quick Chat's own turns add their extra on top — see quickchat:run).
    return runtime!.startTurn({
      ...input,
      webSearch: settings.nativeWebSearch.main,
      instructions: settings.customInstructions.main
    });
  });
  handleIpc('backend:interruptTurn', (_e, turnId: string) => {
    lastInteractiveAt = Date.now();
    return runtime!.interruptTurn(turnId);
  });
  handleIpc('backend:newConversation', () => runtime!.newConversation());
  handleIpc('backend:listModels', () => runtime!.listModels());

  handleIpc('runtime:restart', async () => {
    await runtime!.restart();
    return runtime!.status();
  });

  handleIpc('chats:open', async (_e, threadId: string) => {
    // Opening the overlay's live thread from the sidebar is an implicit hand-off:
    // route its events to the main window and drop the overlay/HUD so the two
    // views don't diverge.
    if (overlay.owns(threadId)) {
      const captured = await captureQuickChatHandoff(threadId);
      if (!captured) {
        // A simultaneous explicit Open-in-Stem action may already have completed
        // the same transition and cancelled this sidebar request.
        if (!overlay.handedOff) {
          showQuickChat(false);
          throw new Error('Quick Chat did not return a handoff snapshot. Try Open in Stem again.');
        }
      } else {
        // Flip ownership before removing the event barrier. Events arriving
        // before commit stay buffered; events arriving after it route directly
        // to the main renderer.
        const flippedHere = overlay.claimHandoff();
        const transition = overlayHandoffBarrier.commit(captured.id);
        if (!transition) {
          // An explicit handoff may have won while this handler was awaiting the
          // snapshot. Only restore ownership when no other path completed it.
          if (flippedHere) {
            overlay.revertHandoff();
            showQuickChat(false);
            throw new Error('Quick Chat handoff was interrupted. Try Open in Stem again.');
          }
        } else {
          overlay.stopTurn();
          hideHud();
          hideOverlayWindow();
          sendToMain('quickchat:adopt', transition.snapshot);
          for (const bufferedEvent of transition.events) {
            sendToMain('backend:event', bufferedEvent);
            noteMainThreadEvent(bufferedEvent.method, threadId);
          }
        }
      }
    }
    // Read is a local file read and isn't gated, so the open returns immediately.
    // Pre-warm pi (switch_session) in the background — it's redundant for
    // correctness since startTurn calls ensureActive itself, but it makes the
    // first send faster. Crucially it no longer blocks the open behind the
    // foreground gate / any in-flight turn.
    void runtime!.resumeThread(threadId).catch(() => {});
    const { title, messages } = await runtime!.readThread(threadId);
    return { threadId, title, messages };
  });

  // ---- settings + quick chat ----
  handleIpc('settings:get', () => readSettings());
  handleIpc('settings:updateQuickChat', async (_e, patch: Partial<QuickChatSettings>) => {
    const next = await updateQuickChat(patch);
    // Apply the side effects the renderer can't: re-bind the global shortcut and
    // re-apply all-displays visibility to the live overlay window.
    if ('shortcut' in patch) applyQuickChatShortcut(next.quickChat.shortcut);
    if ('showOnAllDisplays' in patch) {
      overlayOnAllDisplays = next.quickChat.showOnAllDisplays;
      applyOverlayWorkspaceVisibility();
    }
    if ('newThreadTimeoutMs' in patch) newThreadTimeoutMs = next.quickChat.newThreadTimeoutMs;
    if ('followAcrossSpaces' in patch) {
      followAcrossSpaces = next.quickChat.followAcrossSpaces;
      if (!followAcrossSpaces && hud.owner === 'main') hideHud();
    }
    if ('finishSound' in patch) finishSound = next.quickChat.finishSound;
    return next;
  });
  handleIpc('settings:updateNativeWebSearch', async (_e, patch: Partial<NativeWebSearchSettings>) => {
    // Just persist — the value is applied per turn (the runtime writes the gate the
    // bridge reads, based on the originating context), so no restart/file write here.
    return updateNativeWebSearch(patch);
  });
  handleIpc('settings:updateEscapeAction', async (_e, action: EscapeAction) => {
    // Just persist — the renderer reads escapeAction fresh from settings (mount +
    // window focus) and acts on it locally in the composer.
    return updateEscapeAction(action);
  });
  handleIpc('settings:updateMemory', async (_e, patch: Partial<MemoryModelSettings>) => {
    // Just persist — the LlmClient closures read the model fresh from settings on
    // each memory turn, so the change applies to the next distill/tidy-up.
    return updateMemorySettings(patch);
  });
  handleIpc('settings:updateSkills', async (_e, patch: Partial<SkillsModelSettings>) => {
    // Just persist — the curator's LlmClient reads the model fresh from settings on
    // each pass, so the change applies to the next curation run.
    return updateSkillsSettings(patch);
  });
  handleIpc('settings:updateCustomInstructions', async (_e, patch: Partial<CustomInstructionsSettings>) => {
    // Just persist — startTurn/quickchat:run read the instructions fresh per turn, so
    // the change applies to the next turn with no restart.
    return updateCustomInstructions(patch);
  });
  handleIpc('settings:updateRetrieval', async (_e, patch: PartialRetrievalSettings) => {
    // Persist — the embeddings/rerank clients read their config fresh from settings
    // on each turn, so the change applies to the next fact-ranking pass. The local
    // worker is the one stateful piece: kick it immediately on a mode/model change
    // so the download/load starts now rather than on the next turn.
    const before = (await readSettings()).retrieval;
    const next = await updateRetrievalSettings(patch);
    const after = next.retrieval;
    if (
      embedManager &&
      (before.embeddings.mode !== after.embeddings.mode ||
        before.embeddings.localModel !== after.embeddings.localModel)
    ) {
      if (after.embeddings.mode === 'local') embedManager.reconfigure(EMBED_CATALOG[after.embeddings.localModel]);
      else if (before.embeddings.mode === 'local') embedManager.reconfigure(null);
    }
    if (
      embedManager &&
      (before.reranker.mode !== after.reranker.mode || before.reranker.localModel !== after.reranker.localModel)
    ) {
      if (after.reranker.mode === 'local') embedManager.reconfigureRerank(RERANK_CATALOG[after.reranker.localModel]);
      else if (before.reranker.mode === 'local') embedManager.reconfigureRerank(null);
    }
    return next;
  });
  handleIpc('settings:testRetrieval', async (_e, stage: RetrievalStage): Promise<RetrievalTestResult> => {
    // Live one-shot probe of the configured backend so the user can confirm it
    // actually responds (the fact-ranking path is otherwise silent).
    const retrieval = (await readSettings()).retrieval;
    const startedAt = Date.now();
    if (stage === 'embeddings' && retrieval.embeddings.mode !== 'remote') {
      const emb = retrieval.embeddings;
      if (emb.mode === 'off') return { ok: false, detail: 'Embeddings are off.' };
      // Local mode: Test doubles as the "start/retry the download" button — force
      // past the error-retry gate, then report where the worker is right now.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = EMBED_CATALOG[emb.localModel];
      embedManager.ensure(spec, { force: true });
      const st = embedManager.status();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const [vec] = await embedManager.embed(['Stem retrieval test'], 'query');
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'embed failed' };
      }
    }
    if (stage === 'reranker' && retrieval.reranker.mode !== 'remote') {
      const rr = retrieval.reranker;
      if (rr.mode === 'off') return { ok: false, detail: 'Reranker is off.' };
      // Local mode: Test doubles as the "start/retry the download" button, same
      // contract as the embeddings branch above.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = RERANK_CATALOG[rr.localModel];
      embedManager.ensureRerank(spec, { force: true });
      const st = embedManager.rerankStatus();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const ranked = await embedManager.rerank('pets', ['I have a dog', 'the sky is blue'], 2);
        return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'rerank failed' };
      }
    }
    const cfg = stage === 'embeddings' ? retrieval.embeddings : retrieval.reranker;
    if (!cfg.baseUrl || !cfg.model) return { ok: false, detail: 'Set a base URL and model first.' };
    const getCfg = async () => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
    try {
      if (stage === 'embeddings') {
        const [vec] = await createHttpEmbeddingsClient(getCfg, { timeoutMs: 20_000 }).embed(['Stem retrieval test']);
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms` };
      }
      const ranked = await createHttpRerankClient(getCfg, { timeoutMs: 20_000 }).rerank(
        'pets',
        ['I have a dog', 'the sky is blue'],
        2
      );
      return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms` };
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string } };
      return { ok: false, detail: e.cause?.code ?? e.message ?? 'request failed' };
    }
  });
  // Run a prompt in the overlay's own thread. For a fresh session we pre-create
  // the thread (so its events route correctly from the very first event), then
  // hide the overlay and raise the HUD — the disappear→HUD half of the cycle.
  handleIpc('quickchat:run', async (_e, prompt: QuickChatPrompt): Promise<StartTurnResult> => {
    // Quick Chat is the latency-sensitive surface — yield any scheduler-owned turn.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    // Start the disappear→HUD half of the cycle immediately — before the (async)
    // thread creation — so the overlay never flashes the half-laid-out panel.
    overlay.beginTurn(Date.now());
    // Hide just the overlay (NOT app.hide — that would also hide the HUD we're
    // about to show, and re-showing the HUD would reactivate the app and surface
    // the main window). The overlay is a non-activating panel, so hiding it does
    // not promote the main window. The HUD is non-focusable, so it never steals
    // focus from whatever app the user is in.
    hideOverlayWindow();
    showHud({ phase: 'working', label: 'Working…' }, 'quickchat');

    try {
      const continuing = overlay.owns(prompt.threadId);
      let threadId = continuing ? overlay.threadId! : null;
      if (!threadId) {
        threadId = await runtime!.createThread(prompt.model ?? undefined);
        overlay.adoptThread(threadId);
        // Optimistic sidebar row so the quickchat thread shows immediately.
        sendToMain('quickchat:sessionStarted', {
          threadId,
          title: prompt.input.trim() || 'New chat'
        });
      }

      const qcSettings = await readSettings();
      const ci = qcSettings.customInstructions;
      const result = await runtime!.startTurn({
        input: prompt.input,
        threadId,
        model: prompt.model ?? undefined,
        effort: prompt.effort ?? undefined,
        serviceTier: prompt.serviceTier,
        format: prompt.format,
        // Quick Chat turns honor the Quick Chat native-web-search toggle.
        webSearch: qcSettings.nativeWebSearch.quickChat,
        // Quick Chat inherits the Main instructions and appends its own extra.
        instructions: [ci.main, ci.quickChat].map((s) => s.trim()).filter(Boolean).join('\n'),
        attachments: prompt.attachments
      });
      overlay.noteActivity(Date.now());
      if (overlay.handedOff && result.threadId && result.turnId) {
        // The snapshot can be captured while startTurn is still preparing Recall.
        // Publish the minted id as soon as prompt acceptance returns so Stop is
        // interruptible even before the first real item event.
        sendToMain('backend:event', {
          method: 'item/started',
          params: {
            threadId: result.threadId,
            turnId: result.turnId,
            item: { id: `agent-${result.turnId}`, type: 'agentMessage' }
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      }
      // The memory shortcut ("remember that …") completes with no stream — jump the
      // HUD straight to finished.
      if (result.handled) {
        overlay.stopTurn();
        showHud({ phase: 'finished', label: 'Answer ready' }, 'quickchat');
      }
      return result;
    } catch (e) {
      overlay.settleTurn(Date.now());
      hideHud();
      if (overlayResetBarrier.pending) finishOverlayReset();
      if (overlay.handedOff && overlay.threadId) {
        sendToMain('backend:event', {
          method: 'turn/failed',
          params: {
            threadId: overlay.threadId,
            turn: { id: `quick-start-${Date.now()}`, status: 'failed' },
            error: e instanceof Error ? e.message : String(e)
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      } else {
        showQuickChat(false);
      }
      throw e;
    }
  });

  // Forget the current overlay thread so the next prompt opens a fresh one.
  handleIpc('quickchat:newThread', () => {
    overlay.prepareManualReset();
    hideHud();
    if (overlay.turnRunning) {
      return overlayResetBarrier.wait();
    } else {
      finishOverlayReset();
    }
  });

  // Hand the conversation off to the main window: route future events there,
  // reveal the main window, and have it adopt the thread as the active chat.
  handleIpc('quickchat:handoff', (_e, payload: QuickChatHandoff) => {
    const bufferedEvents = overlayHandoffBarrier.cancelCurrent();
    overlay.claimHandoff();
    overlay.stopTurn();
    if (overlayResetBarrier.pending) finishOverlayReset();
    hideHud();
    hideOverlayWindow();
    revealMainWindow();
    sendToMain('quickchat:adopt', payload);
    for (const bufferedEvent of bufferedEvents) {
      sendToMain('backend:event', bufferedEvent);
      noteMainThreadEvent(bufferedEvent.method, payload.threadId);
    }
  });

  // Re-summon the overlay (HUD click). Same path as the shortcut.
  handleIpc('quickchat:reveal', () => {
    if (!quickChatWindow?.isVisible()) toggleQuickChat();
  });

  // Raise the main window (follow-me pill click). Returning focus to the main
  // window fires the 'focus' handler, which hides the pill.
  handleIpc('main:reveal', () => revealMainWindow());

  handleIpc('quickchat:hide', () => {
    dismissQuickChat();
  });
}

// Last-resort diagnostics: an uncaught throw or rejection in main otherwise
// vanishes with the console. Log-and-continue — Electron's default for
// unhandledRejection is a warning, and killing main over a background hiccup
// (a failed distill, a dropped watcher) would take the whole app down.
process.on('uncaughtException', (e) => {
  log('main', 'uncaughtException', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});
process.on('unhandledRejection', (reason) => {
  log('main', 'unhandledRejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  });
});

app.whenReady().then(async () => {
  await ensureWorkspace();
  // Publish the read-only connected-folder roots so the backend extension enforces
  // them from the first turn (also rewritten on every Folders-tab mutation).
  await publishProtectedRootsNow().catch(() => undefined);
  // pi is the only backend; it satisfies ChatBackend so everything below is
  // backend-agnostic. Alternate profiles (--fresh / --profile) skip seeding auth
  // from the user's global ~/.pi so they start unauthenticated in the onboarding wizard.
  runtime = createBackend({ seedGlobalAuth: !profileOverride });

  // In-app provider sign-in for the onboarding wizard. Writes the same isolated
  // auth.json the pi subprocess reads; progress is pushed to the renderer.
  providerAuth = new ProviderAuth(join(piHome(), 'auth.json'), (event) => sendToMain('auth:event', event));

  // Scheduled tasks: re-run a chat's prompt as an autonomous turn on a cron/once
  // schedule. The scheduler owns timing + execution; the backend routes the
  // assistant's schedule_task/notify_user tools to it via the TaskBridge below.
  scheduler = new TaskScheduler({
    runtime,
    onChange: (tasks) => sendToMain('tasks:changed', tasks),
    onRun: (run) => sendToMain('tasks:run', run),
    // Active = a turn in flight on either surface, or interaction in the last
    // couple of minutes. Scheduled runs defer while this holds and an in-flight
    // scheduled run yields (preemptForUser) when the user sends a message.
    isUserActive: () =>
      runningMainThreads.size > 0 || overlay.turnRunning || Date.now() - lastInteractiveAt < USER_ACTIVE_WINDOW_MS,
    interrupt: (turnId) => runtime!.interruptTurn(turnId)
  });
  runtime.setTaskBridge({
    schedule: (req, threadId) => scheduler!.create(req, threadId),
    listForThread: async (threadId) => scheduler!.listForThread(threadId),
    cancel: async (taskId) => {
      const before = scheduler!.snapshot().length;
      await scheduler!.remove(taskId);
      return scheduler!.snapshot().length < before ? { ok: true } : { ok: false, error: 'No such task.' };
    },
    // notify_user: surface a prominent in-app alert — raise + focus the main window,
    // bounce the dock, and show the alert modal. Native OS notifications were judged
    // not prominent enough for watch-style tasks.
    notify: async ({ title, message }, threadId) => {
      revealMainWindow();
      app.dock?.bounce('critical');
      sendToMain('tasks:notify', {
        threadId,
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });

  // Stem Recall: distill durable facts via a hidden backend turn (the swappable
  // LlmClient seam). Debounced so it runs ~after the user goes idle.
  const recallLlm: LlmClient = {
    complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).memory.model })
  };
  let rebuildTimer: NodeJS.Timeout | null = null;
  scheduleMemoryRebuild = (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    if (getMemoryRebuildStatus().state !== 'running') return;
    rebuildTimer = setTimeout(async () => {
      // A confirmed rebuild is opportunistic and must yield to interactive work.
      if (runningMainThreads.size > 0 || overlay.turnRunning || Date.now() - lastInteractiveAt < 30_000) {
        scheduleMemoryRebuild();
        return;
      }
      const status = await runMemoryRebuildStep(recallLlm);
      mainWindow?.webContents.send('memory:rebuildStatus', status);
      if (status.state === 'running') scheduleMemoryRebuild();
    }, 2_000);
  };
  scheduleMemoryRebuild();

  // The skills curator gets its OWN model setting (separate from memory) — curation
  // can be a harder task than fact distillation, so it can be pointed at a stronger
  // model. Read fresh each pass so a Settings change applies to the next run.
  const skillsLlm: LlmClient = {
    complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).skills.model })
  };

  // Stem Recall relevance ranking. Embeddings route per the settings mode: the
  // bundled local model (in a utility process; the out-of-box default) or the
  // user's own HTTP endpoint. Config is read fresh each turn, so switching mode
  // or repointing endpoints in Settings takes effect on the next fact-ranking
  // pass with no restart. Off/not-ready → the clients report unavailable and
  // inject falls back to lexical/recency selection — a chat turn never waits on
  // a model download.
  embedManager = createEmbedWorkerManager({ spawn: spawnEmbedWorker, cacheDir: embedModelsDir });
  // Recall's O(N) cosine scans and episodic VACUUMs run in their own utility
  // process so they never block the main event loop; everything degrades to the
  // in-process implementations if the worker is unavailable (see recall/scan.ts).
  scanManager = createScanWorkerManager({ spawn: spawnScanWorker, dbPath: () => recallDbPath() });
  setScanWorkerManager(scanManager);
  const getEmbedSettings = async () => (await readSettings()).retrieval.embeddings;
  const getRerankSettings = async () => (await readSettings()).retrieval.reranker;
  const localEmbeddings = createLocalEmbeddingsClient(getEmbedSettings, embedManager);
  setRetrievalClients({
    embeddings: createEmbeddingsRouter({
      getMode: async () => (await getEmbedSettings()).mode,
      local: localEmbeddings,
      remote: createHttpEmbeddingsClient(async () => {
        const e = await getEmbedSettings();
        return e.mode === 'remote' && e.baseUrl && e.model
          ? { baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey }
          : null;
      })
    }),
    // Precision rerank stage: the bundled cross-encoder (co-hosted in the embed
    // worker) or the user's own Cohere/Jina-style /rerank endpoint (llama.cpp
    // --reranking, vLLM, Infinity, TEI — note Ollama can't serve one). Off/not
    // ready → inject degrades to the cosine ranking.
    rerank: createRerankRouter({
      getMode: async () => (await getRerankSettings()).mode,
      local: createLocalRerankClient(getRerankSettings, embedManager),
      remote: createHttpRerankClient(async () => {
        const r = await getRerankSettings();
        return r.mode === 'remote' && r.baseUrl && r.model
          ? { baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey }
          : null;
      })
    })
  });
  // Serve query embeddings to the stem-recall MCP server over a local unix
  // socket, so search_past_chats gets the same hybrid (semantic) retrieval as
  // auto-inject. Listen failures are logged and non-fatal (tool stays FTS-only).
  const embedEndpoint = startEmbedEndpoint({
    socketPath: embedSocketPath(),
    getClient: getEmbeddingsClient
  });
  app.on('will-quit', () => {
    void embedEndpoint.close();
  });
  embedManager.onRerankStatus((status) => {
    mainWindow?.webContents.send('reranker:localStatus', status);
  });
  embedManager.onStatus((status) => {
    mainWindow?.webContents.send('embeddings:localStatus', status);
    // The model just came up: prune vectors from previously-used models (local
    // vectors are cheap to regenerate; keeps recall.sqlite tidy) and backfill any
    // facts missing a vector in the background. Without this, inject would embed
    // the entire fact set inline in the first semantic turn — many seconds on CPU.
    if (status.state !== 'ready') return;
    void (async () => {
      try {
        const e = await getEmbedSettings();
        if (e.mode !== 'local' || e.localModel !== status.model) return;
        const key = localModelCacheKey(EMBED_CATALOG[e.localModel]);
        const factsGeneration = getFactsGeneration();
        pruneVectorsExceptModel(key);
        const missing = getFactsMissingVector(key);
        for (let i = 0; i < missing.length; i += 64) {
          if (getFactsGeneration() !== factsGeneration) break;
          const batch = missing.slice(i, i + 64);
          const vecs = await localEmbeddings.embed(
            batch.map((f) => f.text),
            'passage'
          );
          if (getFactsGeneration() !== factsGeneration) break;
          batch.forEach((f, j) =>
            upsertFactVectorForSnapshot(f.id, f.text, factsGeneration, key, vecs[j])
          );
        }
        // Same hygiene + backfill for thread-summary vectors (Level 1.5 search).
        pruneSummaryVectorsExceptModel(key);
        const summariesMissing = getSummariesMissingVector(key);
        for (let i = 0; i < summariesMissing.length; i += 64) {
          const batch = summariesMissing.slice(i, i + 64);
          const vecs = await localEmbeddings.embed(batch.map((s) => s.text), 'passage');
          batch.forEach((s, j) => upsertSummaryVector(s.id, key, vecs[j]));
        }
        // Same hygiene + backfill for the episodic message vectors (semantic
        // episodic search). Watermark-driven and self-guarding, so a concurrent
        // post-turn kick can't double-embed.
        pruneMessageVectorsExceptModel(key);
        await embedNewMessages(localEmbeddings);
      } catch {
        // non-fatal: inject tops up lazily on the next semantic turn
      }
    })();
  });
  // Kick the download/load shortly after launch (instead of on the first turn
  // that needs it) so the model is usually ready before the user accumulates
  // enough facts to matter. The delay only yields the window/backend startup
  // burst — keep it short, or the Manage panel shows a misleading idle state
  // ("not downloaded yet") on every restart until the kick lands. Skipped under
  // E2E: hermetic runs must not hit the network.
  if (!E2E) {
    setTimeout(() => {
      void getEmbedSettings().then((e) => {
        if (e.mode === 'local') embedManager?.ensure(EMBED_CATALOG[e.localModel]);
      });
      void getRerankSettings().then((r) => {
        if (r.mode === 'local') embedManager?.ensureRerank(RERANK_CATALOG[r.localModel]);
      });
    }, 1_500);
  }
  let distilling = false;
  let distillTimer: NodeJS.Timeout | null = null;
  const scheduleDistill = (delayMs = 15_000): void => {
    if (!isRecallEnabled()) return;
    if (distillTimer) clearTimeout(distillTimer);
    distillTimer = setTimeout(async () => {
      if (distilling) return;
      distilling = true;
      try {
        await distillNewMessages(recallLlm);
        // Rolling thread summaries (Level 1.5): revise the summaries of the
        // just-active threads from the same new messages. Own watermark, so a
        // failure here never blocks fact extraction (and vice versa).
        await refreshRecentSummaries(recallLlm);
        // Once enough new facts have piled up, clean the set: merge reworded
        // duplicates, apply corrections, drop superseded facts. Same hidden
        // LlmClient seam, so it's invisible to the user like distillation.
        if (shouldConsolidate()) await consolidateFacts(recallLlm);
        // Skills acquisition: a separate single-purpose pass over the same new
        // messages (own watermark) — the in-turn manage_skill nudge alone never
        // fires. Uses the skills model; a write reloads pi so the skill activates.
        const newSkills = await distillSkillsFromMessages(skillsLlm);
        if (newSkills > 0) await runtime!.requestSkillReload();
      } catch {
        // non-fatal
      } finally {
        distilling = false;
      }
    }, delayMs);
  };

  // Episodic embed pass: keep message vectors current for semantic recall.
  // Debounced off turn/completed (plus one startup pass) and routed through the
  // settings-aware router client, so remote-mode users backfill too — the
  // ready-transition hook above only covers the local worker coming up.
  let episodicEmbedTimer: NodeJS.Timeout | null = null;
  const scheduleEpisodicEmbed = (delayMs = 10_000): void => {
    if (!isRecallEnabled()) return;
    if (episodicEmbedTimer) clearTimeout(episodicEmbedTimer);
    episodicEmbedTimer = setTimeout(() => {
      const client = getEmbeddingsClient();
      if (client) void embedNewMessages(client);
    }, delayMs);
  };

  // Skills curator: the Level-2 cleanup of self-authored skills (merge duplicates,
  // patch sloppy bodies, archive stale ones), mirroring fact consolidation. Uses the
  // same hidden LlmClient seam, and is gated by the memory toggle since it's the same
  // kind of background self-improvement pass. On any change, reload so pi rescans skills.
  let curating = false;
  const runCurate = async (): Promise<void> => {
    if (curating || !isRecallEnabled()) return;
    curating = true;
    try {
      const res = await curateSkills(skillsLlm);
      if (res.merged || res.patched || res.archived) await runtime!.requestSkillReload();
    } catch {
      // non-fatal
    } finally {
      curating = false;
    }
  };
  // A pass shortly after startup, then a low-frequency recurring pass while idle.
  setTimeout(() => void runCurate(), 90_000);
  setInterval(() => void runCurate(), 24 * 60 * 60_000);

  // Summary backfill for dormant threads (history that predates summaries, or
  // fell behind while the app was closed). Opportunistic like the rebuild pass:
  // it must yield to any interactive work, so a skipped pass just waits for the
  // next interval tick.
  const runSummaryBackfill = async (): Promise<void> => {
    if (runningMainThreads.size > 0 || overlay.turnRunning || Date.now() - lastInteractiveAt < 30_000) return;
    try {
      await backfillSummaries(recallLlm, 3);
    } catch {
      // non-fatal
    }
  };
  setTimeout(() => void runSummaryBackfill(), 3 * 60_000);
  setInterval(() => void runSummaryBackfill(), 30 * 60_000);

  // Forward backend events to the main window. Registered once (not per-window) so
  // recreating the window can't double-subscribe.
  runtime.on('event', (event) => {
    // Stem-internal MCP self-management signals: deliver to the windows on their
    // own channels (never as a backend thread event, and never captured into recall).
    if (event.method === 'mcp/admin/approvalRequest') {
      const approvalThreadId = (event.params as { threadId?: string } | undefined)?.threadId;
      // Quick Chat hides itself while a turn runs. Bring the originating surface
      // back so mounting the card actually makes the confirmation visible.
      if (approvalThreadId && overlay.owns(approvalThreadId)) showQuickChat(false);
      sendToMain('mcp:adminApproval', event.params);
      quickChatWindow?.webContents.send('mcp:adminApproval', event.params);
      return;
    }
    if (event.method === 'mcp/admin/approvalResolved') {
      sendToMain('mcp:adminApprovalResolved', event.params);
      quickChatWindow?.webContents.send('mcp:adminApprovalResolved', event.params);
      return;
    }
    if (event.method === 'instructions/approvalRequest') {
      const approvalThreadId = (event.params as { threadId?: string } | undefined)?.threadId;
      if (approvalThreadId && overlay.owns(approvalThreadId)) showQuickChat(false);
      sendToMain('instructions:approvalRequest', event.params);
      quickChatWindow?.webContents.send('instructions:approvalRequest', event.params);
      return;
    }
    if (event.method === 'instructions/approvalResolved') {
      sendToMain('instructions:approvalResolved', event.params);
      quickChatWindow?.webContents.send('instructions:approvalResolved', event.params);
      return;
    }
    if (event.method === 'mcp/changed') {
      sendToMain('mcp:changed', undefined);
      quickChatWindow?.webContents.send('mcp:changed');
      return;
    }
    if (event.method === 'skills/changed') {
      sendToMain('skills:changed', undefined);
      quickChatWindow?.webContents.send('skills:changed');
      return;
    }
    if (event.method === 'mcp/status') {
      sendToMain('mcp:status', event.params);
      quickChatWindow?.webContents.send('mcp:status', event.params);
      return;
    }
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // Hidden internal threads (distillation) are neither shown nor captured.
    if (threadId && runtime!.isInternalThread(threadId)) return;
    // The overlay owns its live thread until hand-off: route its events to the
    // overlay window (which renders the conversation) and the status HUD, NOT the
    // main window — otherwise the main window would build a phantom user-less slice.
    const overlayOwned = overlay.owns(threadId);
    const handoffBuffered = !!threadId && overlayHandoffBarrier.buffer(threadId, event);
    if (handoffBuffered) {
      // captureQuickChatHandoff replays these immediately after the atomic snapshot.
    } else if (overlayOwned) {
      quickChatWindow?.webContents.send('backend:event', event);
      driveHud(event);
    } else if (!threadId) {
      // Process-level events (e.g. process/exit) carry no threadId — let both
      // windows clear their run state, and clear the follow-me pill so a backend
      // crash never leaves a stuck "Working…" pill.
      const abandonedHandoffEvents = overlayHandoffBarrier.cancelCurrent();
      for (const bufferedEvent of abandonedHandoffEvents) {
        quickChatWindow?.webContents.send('backend:event', bufferedEvent);
        driveHud(bufferedEvent);
      }
      sendToMain('backend:event', event);
      quickChatWindow?.webContents.send('backend:event', event);
      runningMainThreads.clear();
      if (event.method === 'process/exit' && (overlay.turnRunning || overlayResetBarrier.pending)) {
        overlay.restore(failQuickChatProcess(Date.now(), overlay.threadId));
        if (hud.owner === 'quickchat') showHud({ phase: 'finished', label: 'Request failed' }, 'quickchat');
        if (overlayResetBarrier.pending) finishOverlayReset();
      }
      if (hud.owner === 'main') hideHud();
    } else {
      sendToMain('backend:event', event);
      noteMainThreadEvent(event.method, threadId);
    }
    if (isRecallEnabled()) {
      // Skip capture when the turn read inside a memorize:false connected folder, so
      // its (potentially confidential) reply never enters Recall. scheduleDistill still
      // runs — it only processes already-captured messages.
      if (!(threadId && runtime!.isCaptureSuppressed(threadId))) {
        captureFromEvent(event); // tap assistant replies into Stem Recall (all threads)
      }
      if (event.method === 'turn/completed') {
        scheduleDistill();
        scheduleEpisodicEmbed();
      }
    }
    // Chat search indexes the user's own chats in full — independent of the memory
    // toggle and of recall's memorize:false/taint gating (you must be able to find a
    // chat even if it was marked don't-remember). Re-index this thread once its turn
    // lands so the new messages are searchable without a relaunch.
    if (threadId && event.method === 'turn/completed') {
      void reindexChatThread(runtime!, threadId);
    }
  });

  // Kick off a distillation pass shortly after startup so any messages captured
  // before the app last quit get turned into durable facts. The episodic embed
  // pass runs too, covering remote embeddings mode (no ready-transition there).
  scheduleDistill(20_000);
  scheduleEpisodicEmbed(25_000);

  // Backfill the chat-search index in the background a little after startup (never
  // blocking it). The per-thread watermark makes this a near no-op on every relaunch —
  // only chats changed since they were last indexed (or edited externally) get reread.
  setTimeout(() => void backfillChatIndex(runtime!), 8_000);

  // Strict CSP for the renderer in production: only self, no remote/inline
  // script. Skipped in dev so the Vite dev server / HMR can run.
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

  registerIpc();
  createWindow();
  // Eagerly spawn pi + connect MCP once the window has painted, so the first prompt
  // doesn't pay backend cold-start. Skipped when not signed in (status() is cheap
  // and never spawns). did-finish-load keeps the spawn + MCP child processes off
  // the first-paint path. Fire-and-forget; races harmlessly with the renderer's
  // listModels warm (ensureStarted is idempotent). Under STEM_E2E the fake backend
  // reports authenticated (unless the onboarding sub-seam), so this same path
  // starts the scheduler for seeded tasks; prewarm/restart are no-ops on the fake.
  mainWindow?.webContents.once('did-finish-load', () => {
    void runtime!
      .status()
      .then(async (s) => {
        if (!s.ok) return;
        // Already authenticated (e.g. auth seeded from an existing ~/.pi): count
        // onboarding as done, so a LATER auth loss shows the compact re-sign-in
        // screen instead of the first-run welcome.
        const settings = await readSettings();
        if (!settings.onboarding.completed) await markOnboardingCompleted();
        // Start the scheduler only once signed in — runs are turns, which need a
        // working backend. This also runs any tasks missed while Stem was closed
        // (catch-up), exactly once each.
        void scheduler?.start();
        return runtime!.prewarm();
      })
      .catch(() => {});
  });
  // Pre-create the overlay (hidden) so the shortcut summons it instantly, and
  // bind the global accelerator from the saved settings. Seed the all-Spaces
  // flag before creating the overlay so it's applied once, at creation.
  const initialSettings = await readSettings();
  overlayOnAllDisplays = initialSettings.quickChat.showOnAllDisplays;
  newThreadTimeoutMs = initialSettings.quickChat.newThreadTimeoutMs;
  followAcrossSpaces = initialSettings.quickChat.followAcrossSpaces;
  finishSound = initialSettings.quickChat.finishSound;
  createQuickChatWindow();
  createHudWindow();
  applyQuickChatShortcut(initialSettings.quickChat.shortcut);

  app.on('activate', () => {
    // Don't recreate the main window when the activation was triggered by summoning
    // the Quick Chat overlay — that would reopen a closed main window unbidden.
    if (summoningOverlay || quickChatWindow?.isVisible()) return;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}).catch((error) => {
  console.error('Failed to start Stem:', error);
  app.quit();
});

// Shut the backend down gracefully before quitting. preventDefault + await gives
// it a window to drain in-flight work, then we exit for real (shutdown has its
// own SIGKILL backstop).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;
  scheduler?.stop();
  embedManager?.dispose();
  scanManager?.dispose();
  runtime.shutdown().finally(() => app.exit(0));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
