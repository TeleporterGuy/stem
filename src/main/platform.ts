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
