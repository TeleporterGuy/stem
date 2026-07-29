import { app, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { spawn } from 'node:child_process';

// Per-platform branching for the window chrome, overlay behavior, and small OS
// affordances. Everything platform-specific that main needs lives behind these
// helpers so index.ts stays free of `process.platform` checks — and the macOS
// output stays byte-identical to the pre-port behavior.

export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isWindows = process.platform === 'win32';

/**
 * Is this a Wayland desktop session? Stem itself runs under XWayland there, and
 * an X11 key grab never sees a key the Wayland compositor routed elsewhere — so
 * `globalShortcut.register` reports success and the accelerator silently never
 * fires. The only reliable summon paths are the XDG GlobalShortcuts portal (see
 * enableGlobalShortcutPortal) and a DE-bound `--quick-chat` launch, so the UI
 * has to say so instead of showing a shortcut that does nothing.
 */
export function isWaylandSession(): boolean {
  if (!isLinux) return false;
  // Test seam. The three signals below are also what Chromium reads to choose its
  // ozone backend, so a test cannot fake a session type through them without
  // changing which display server Electron connects to — pointing it at a
  // compositor that isn't there kills the app at startup. This override moves the
  // answer without touching the backend. It is read on Linux only, and the worst a
  // user can do by setting it is mis-label their own session in Settings.
  const forced = (process.env.STEM_E2E_SESSION ?? '').toLowerCase();
  if (forced) return forced === 'wayland';
  return (
    (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
    !!process.env.WAYLAND_DISPLAY ||
    (process.env.ELECTRON_OZONE_PLATFORM_HINT ?? '').toLowerCase() === 'wayland'
  );
}

/**
 * Opt into Chromium's GlobalShortcutsPortal — the only implementation of global
 * shortcuts that can work in a Wayland session, registering through
 * org.freedesktop.portal.GlobalShortcuts instead of grabbing X11 keys. Must run
 * before the app is ready: command-line switches are read at Chromium startup.
 *
 * Chromium only takes this path on the ozone/wayland backend, and Stem does not
 * force that backend (a native Wayland client cannot position its own windows,
 * which the overlay and the status pill both do) — so this helps the setups that
 * launch Stem with ELECTRON_OZONE_PLATFORM_HINT=wayland themselves, and the
 * DE-bound `--quick-chat` command remains the reliable Wayland summon path.
 */
export function enableGlobalShortcutPortal(): void {
  if (!isLinux) return;
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

/**
 * The command to bind to a system-level keyboard shortcut when Stem can't grab
 * one itself (Wayland). A second launch hands its argv to the running instance,
 * which toggles the overlay — see the second-instance handler in index.ts.
 */
export function quickChatSummonCommand(): string {
  // Inside an AppImage, execPath points at the extracted temp mount, which is
  // gone by the time the user's keybinding fires. $APPIMAGE is the stable file.
  const exe = process.env.APPIMAGE || process.execPath;
  const quoted = /\s/.test(exe) ? `"${exe}"` : exe;
  // Unpackaged (dev) runs need the app directory too, or Electron opens its demo.
  return app.isPackaged ? `${quoted} --quick-chat` : `${quoted} ${app.getAppPath()} --quick-chat`;
}

/**
 * Overlay (Quick Chat) window chrome.
 *
 * macOS: an NSPanel (`type: 'panel'`) — it can take keyboard focus WITHOUT
 * activating Stem (the Spotlight/Raycast contract), with native vibrancy
 * frosting, rounded corners, and a native drop shadow.
 *
 * Elsewhere: no panel type (on Linux `type` maps to X11 window types with
 * DE-dependent focus behavior — worse than a plain frameless window), no
 * vibrancy. The window is transparent and the renderer draws the card itself
 * (rounded corners + shadow in CSS, see `body.platform-linux .qc-card`);
 * summoning activates the app, which is the accepted non-mac UX.
 */
export function overlayWindowOptions(): BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      type: 'panel',
      vibrancy: 'under-window',
      visualEffectState: 'active', // keep the material lit even when not key
      roundedCorners: true,
      hasShadow: true
    };
  }
  // hasShadow off: the shadow is CSS-drawn inside the (inset) transparent window.
  return { transparent: true, hasShadow: false };
}

/**
 * Options for setVisibleOnAllWorkspaces. `visibleOnFullScreen` and
 * `skipTransformProcessType` are macOS-only (the latter prevents the
 * accessory/foreground process-type flip — see applyOverlayWorkspaceVisibility);
 * passing them elsewhere is at best a no-op, so don't.
 */
export function workspaceVisibilityOptions():
  | { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }
  | undefined {
  return isMac ? { visibleOnFullScreen: true, skipTransformProcessType: true } : undefined;
}

/**
 * Order the overlay onto the Space the user is actually looking at, and make it
 * key so it receives keystrokes.
 *
 * macOS: `show()` on its own is not enough. Electron maps it to
 * `-[NSWindow makeKeyAndOrderFront:]`, and AppKit deliberately refuses to bring a
 * window forward while its application is not the active one. For a Spotlight-style
 * summon that is *always* the case — the overlay is a non-activating panel
 * precisely so Stem never steals activation — so the panel fails to surface on the
 * Space the user is on. `-[NSWindow orderFrontRegardless]` is Apple's documented
 * escape hatch for exactly this, and `showInactive()` is Electron's binding for it.
 * (Same reason the status pill, which has always used `showInactive`, does follow
 * you across Spaces.) The follow-up `show()` is one extra `makeKeyAndOrderFront:`
 * to make the panel key; by then it is already ordered front, so the inactive-app
 * restriction no longer bites. `focus()` can't do that job here — it is gated on
 * `NativeWindowMac::IsVisible()`, which consults the window's (asynchronously
 * updated) occlusion state and so is not reliable immediately after a show.
 *
 * Elsewhere: summoning activates the app — the accepted non-mac UX — so the plain
 * show/focus pair is both sufficient and correct.
 */
export function presentOverlayWindow(win: BrowserWindow): void {
  if (isMac) {
    win.showInactive(); // orderFrontRegardless — surfaces on the current Space
    win.show(); // makeKeyAndOrderFront — key without activating Stem (it's a panel)
    return;
  }
  win.show();
  win.focus();
}

/** Main-window chrome: inset traffic lights on macOS, the native frame elsewhere. */
export function mainWindowChromeOptions(): BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      titleBarStyle: 'hiddenInset',
      // Vertically center the inset traffic lights within the 52px toolbar.
      trafficLightPosition: { x: 19, y: 20 }
    };
  }
  return {};
}

/**
 * Off-mac the CSS card shadow needs interior room: the overlay window is grown
 * by this inset on every side and the renderer pads `.qc-root` to match, so the
 * visible card keeps the exact macOS geometry (where the shadow is native and
 * drawn outside the window).
 */
export const OVERLAY_SHADOW_INSET = isMac ? 0 : 24;

/** Grow card-sized bounds into window bounds (see OVERLAY_SHADOW_INSET). */
export function overlayOuterBounds(card: Rectangle): Rectangle {
  const inset = OVERLAY_SHADOW_INSET;
  return {
    x: card.x - inset,
    y: card.y - inset,
    width: card.width + inset * 2,
    height: card.height + inset * 2
  };
}

/**
 * Nudge the user toward the app: dock bounce on macOS, the taskbar/urgency
 * flash elsewhere (cleared by focus — see the flashFrame(false) guard in
 * createWindow).
 */
export function requestAttention(win: BrowserWindow | null): void {
  if (isMac) {
    app.dock?.bounce('critical');
    return;
  }
  if (win && !win.isDestroyed()) win.flashFrame(true);
}

/**
 * Play the turn-finished chime. macOS uses the built-in system sound (no bundled
 * asset). Elsewhere no reliably-present CLI player exists, so the always-alive
 * (hidden, never closed) HUD window plays a bundled asset via an <audio> element
 * instead — best-effort: if the HUD window is gone, the chime is skipped.
 */
export function playFinishChime(hudWindow: BrowserWindow | null): void {
  if (isMac) {
    try {
      spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' }).unref();
    } catch {
      // Sound is best-effort; never let it break the turn lifecycle.
    }
    return;
  }
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send('hud:playChime');
}
