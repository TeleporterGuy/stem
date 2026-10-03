import { app } from 'electron';
import { host } from '../server/host';
import { log } from '../server/log';
import type { UpdateMode, UpdateStatus } from '../shared/types';
import { compareVersions } from './release-notes';
import { readClientSettings } from './settings';

// Whether a newer Stem exists, and what this install can do about it.
//
// A CLIENT concern, like the release notes: the version that could be updated
// is the one installed on THIS machine, whichever server it talks to. The
// headless server never loads this file — a container is updated by pulling a
// new image, and telling it so from in here would be advice to the wrong
// process.
//
// What "update" means depends on how Stem got here, and the split is decided
// once, at startup:
//
//   auto — the AppImage, and a mac build installed in an Applications folder.
//     electron-updater reads the feed electron-builder put beside the release
//     (latest-linux*.yml, latest-mac.yml) and downloads the new build on its
//     own. The AppImage swaps the file on restart — or silently on quit,
//     whichever comes first; no signature requirement stands in the way, the
//     AppImage is one file the user already owns. On a mac it fetches the zip
//     and hands it to Squirrel.Mac, which checks that the new bundle is signed
//     by the same Developer ID as the running one (mac builds are signed since
//     2026-09, see the `mac` block in electron-builder.yml) and replaces
//     Stem.app after the app quits.
//
//   manual — the deb, and a mac build running from anywhere Squirrel cannot
//     write: straight off the mounted dmg, or a copy macOS translocated out of
//     Downloads. A deb belongs to dpkg. So the most honest thing this install
//     can do is find out and say so: the check is one HTTPS request for where
//     github.com/…/releases/latest redirects to, which names the newest tag
//     without spending anyone's API rate limit, and "install" means opening
//     that page.
//
//   none — a dev run or a test. There is nothing on disk a release could
//     replace, so the timer never starts and the Settings row keeps quiet.
//
// The check runs shortly after launch (off the cold-start path) and every few
// hours after that, each tick re-reading the toggle so Settings applies without
// a restart. A manual "Check now" works regardless of the toggle — asking is
// answering.

const REPO_URL = 'https://github.com/join3r/stem';

/** Off the cold-start path: the first prompt matters more than the news. */
const FIRST_CHECK_DELAY_MS = 30_000;
/** Long enough to never matter, short enough that a day-long session hears. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;

export interface UpdatesDeps {
  /** Push a status change to the main window (through its ready-queue). */
  send(status: UpdateStatus): void;
  /** Open the release page in the user's browser (the `manual` install path). */
  openExternal(url: string): void;
}

export interface Updates {
  /** Begin the periodic check (a no-op under mode `none`). */
  start(): void;
  /** Where things stand, for a window that just mounted. */
  status(): UpdateStatus;
  /** Look now, regardless of the automatic-check toggle. */
  check(): Promise<UpdateStatus>;
  /** Restart into the downloaded build, or open the page to get one. */
  install(): Promise<void>;
  /** Stop the timer (quit; tests). */
  close(): void;
}

/** What decides the update mode — the facts of this artifact and where it runs. */
export interface UpdateModeFacts {
  packaged: boolean;
  e2e: boolean;
  platform: NodeJS.Platform;
  /** Set by the AppImage runtime (its path). */
  appImage: string | undefined;
  /** macOS: running from /Applications or ~/Applications. */
  inApplicationsFolder: boolean;
}

/** How a release reaches this install. Decided once — it is a fact of the artifact. */
export function updateModeFor(f: UpdateModeFacts): UpdateMode {
  if (f.e2e || !f.packaged) return 'none';
  // Set by the AppImage runtime, and required by electron-updater's AppImage
  // path — a packaged Linux build without it is a deb (or an unpacked dir).
  if (f.appImage) return 'auto';
  // Squirrel.Mac replaces the bundle where it sits, so it needs a writable
  // home: an Applications folder. Off the read-only dmg, or translocated out
  // of Downloads, the swap could only fail — the release page still works.
  if (f.platform === 'darwin' && f.inApplicationsFolder) return 'auto';
  return 'manual';
}

function updateMode(): UpdateMode {
  return updateModeFor({
    packaged: app.isPackaged,
    e2e: Boolean(process.env.STEM_E2E),
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    inApplicationsFolder: process.platform === 'darwin' && app.isPackaged && app.isInApplicationsFolder()
  });
}

/**
 * The version a `/releases/latest` redirect names. The Location header ends in
 * the tag; nothing else about the answer is trusted — the URL handed on is
 * rebuilt on REPO_URL from the matched tag rather than taken from the wire.
 * Null for anything that is not a version tag (no releases yet, an error page).
 */
export function parseLatestRelease(location: string | null): { version: string; url: string } | null {
  const tag = /\/releases\/tag\/(v?\d+(?:\.\d+)*)$/.exec(location ?? '')?.[1];
  if (!tag) return null;
  return { version: tag.replace(/^v/, ''), url: `${REPO_URL}/releases/tag/${tag}` };
}

/** The newest released version, learned from where `/releases/latest` redirects. */
async function latestRelease(): Promise<{ version: string; url: string }> {
  const res = await fetch(`${REPO_URL}/releases/latest`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000)
  });
  const latest = parseLatestRelease(res.headers.get('location'));
  if (!latest) throw new Error(`GitHub did not name a latest release (HTTP ${res.status})`);
  return latest;
}

export function createUpdates(deps: UpdatesDeps): Updates {
  const mode = updateMode();

  const current: UpdateStatus = {
    appVersion: host().appVersion(),
    mode,
    state: 'idle',
    available: null,
    downloadUrl: null,
    checkedAt: null,
    error: null
  };

  // The one line a bug report needs first: which of the three paths this
  // install is on, and what it thinks it is running.
  log('updates', 'updater ready', { mode, appVersion: current.appVersion });

  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /** One check at a time; a click during the scheduled run joins it. */
  let inFlight: Promise<UpdateStatus> | null = null;

  function set(patch: Partial<UpdateStatus>): void {
    Object.assign(current, patch);
    deps.send({ ...current });
  }

  // ---- mode `auto`: electron-updater (AppImage, or Squirrel.Mac) ----

  /**
   * Loaded on first use, and only under `auto` — a deb or a mac build off the dmg
   * never pays for the module, and a dev run never trips over its APPIMAGE check.
   */
  let autoUpdaterReady: Promise<typeof import('electron-updater').autoUpdater> | null = null;

  function loadAutoUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
    autoUpdaterReady ??= import('electron-updater').then(({ autoUpdater }) => {
      const line = (m: unknown) => log('updates', String(m));
      autoUpdater.logger = { info: line, warn: line, error: line, debug: () => undefined };
      autoUpdater.autoDownload = true;
      // A download the user never acted on still lands: the swap happens
      // silently as the app quits, and the next launch is simply the new one.
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) => {
        set({
          state: 'downloading',
          available: info.version,
          downloadUrl: `${REPO_URL}/releases/tag/v${info.version}`
        });
      });
      autoUpdater.on('update-downloaded', (info) => {
        log('updates', 'update downloaded', { version: info.version });
        set({ state: 'ready' });
      });
      // A download can fail long after checkForUpdates resolved, and an
      // unlistened 'error' on an emitter takes the process down. Same shape as
      // a failed check: a fact for Settings, retried on the next tick. An
      // install can fail too — the AppImage sits in a folder this user cannot
      // write, most often, or Squirrel.Mac refuses a bundle whose signature
      // does not match — and that one is worth more than a log line: the
      // build is still `available`, so Settings falls back to offering the page.
      autoUpdater.on('error', (e) => {
        log('updates', 'auto-update failed', { error: e.message });
        if (current.state === 'downloading' || current.state === 'ready') {
          set({ state: 'error', error: e.message });
        }
      });
      return autoUpdater;
    });
    return autoUpdaterReady;
  }

  async function checkAuto(): Promise<void> {
    const updater = await loadAutoUpdater();
    // A downloaded build stays ready; there is nothing newer to look for that
    // this check could act on before a restart consumes what it has.
    if (current.state === 'ready') return;
    set({ state: 'checking', error: null });
    const result = await updater.checkForUpdates();
    log('updates', 'checked (auto)', {
      current: current.appVersion,
      latest: result?.updateInfo.version ?? null,
      downloading: current.state === 'downloading'
    });
    // Nothing newer: checkForUpdates resolved without the events above firing.
    if (current.state === 'checking') set({ state: 'idle', available: null, downloadUrl: null });
  }

  // ---- mode `manual`: the redirect check ----

  async function checkManual(): Promise<void> {
    set({ state: 'checking', error: null });
    const latest = await latestRelease();
    log('updates', 'checked (manual)', { current: current.appVersion, latest: latest.version });
    if (compareVersions(latest.version, current.appVersion) > 0) {
      set({ state: 'idle', available: latest.version, downloadUrl: latest.url });
    } else {
      set({ state: 'idle', available: null, downloadUrl: null });
    }
  }

  // ---- the shared shell ----

  async function runCheck(): Promise<UpdateStatus> {
    if (mode === 'none') return { ...current };
    try {
      if (mode === 'auto') await checkAuto();
      else await checkManual();
      set({ checkedAt: Date.now() });
    } catch (e) {
      // A failed check is a fact worth showing in Settings and nothing more —
      // most of them are a laptop with no network, which fixes itself.
      const message = e instanceof Error ? e.message : String(e);
      log('updates', 'check failed', { error: message });
      set({ state: 'error', error: message, checkedAt: Date.now() });
    }
    return { ...current };
  }

  function check(): Promise<UpdateStatus> {
    inFlight ??= runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** The scheduled tick: consult the toggle now, not when the timer was set. */
  async function tick(): Promise<void> {
    if (closed) return;
    const { updates } = await readClientSettings();
    if (updates.checkAutomatically) await check();
  }

  const status = (): UpdateStatus => ({ ...current });

  return {
    start() {
      if (mode === 'none') return;
      timer = setInterval(() => void tick(), CHECK_EVERY_MS);
      setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS);
    },
    status,
    check,
    async install() {
      if (mode === 'auto' && current.state === 'ready') {
        // The AppImage swaps the file first and quits second; Squirrel.Mac
        // closes the windows, quits, and replaces Stem.app once the process is
        // gone. Either way the graceful shutdown in index.ts (before-quit →
        // drain → app.exit) runs exactly as it does for an ordinary quit.
        log('updates', 'installing', { version: current.available });
        const updater = await loadAutoUpdater();
        updater.quitAndInstall(false, true);
        // A failed swap never throws: electron-updater reports it on 'error'
        // (handled above, synchronously) and stays put. The user clicked to
        // update, so hand them the page rather than a button that did nothing.
        // (Read through a call: the narrowing above still believes `ready`.)
        if (status().state !== 'error' || !current.downloadUrl) return;
        log('updates', 'falling back to the release page');
      }
      // The `manual` path — and `auto` after a download or install that failed,
      // where the release page is the one thing that still works.
      if (current.downloadUrl) deps.openExternal(current.downloadUrl);
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
