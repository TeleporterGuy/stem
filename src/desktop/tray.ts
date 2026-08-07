import { app, Menu, Tray, type NativeImage } from 'electron';

// Status-area tray icon. Platform-neutral module (the caller gates where it
// ships — Linux-only for now): on Linux it is the discoverable affordance for
// an app with no dock presence — summon the overlay, reopen the main window,
// and the only visible Quit once the main window is closed. Note stock GNOME
// hides StatusNotifier icons without the AppIndicator extension; the
// second-instance CLI paths (`stem`, `stem --quick-chat`) cover that case.

// Electron does not retain the Tray — a GC'd instance silently vanishes from
// the status area, so it must live in module scope.
let tray: Tray | null = null;

export function initTray(deps: {
  /** Full-size app icon; resized down to status-area dimensions here. */
  icon: NativeImage;
  onToggleQuickChat: () => void;
  onOpenStem: () => void;
}): void {
  if (tray) return;
  const small = deps.icon.isEmpty() ? deps.icon : deps.icon.resize({ width: 22, height: 22 });
  tray = new Tray(small);
  tray.setToolTip('Stem');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Summon Quick Chat', click: () => deps.onToggleQuickChat() },
      { label: 'Open Stem', click: () => deps.onOpenStem() },
      { type: 'separator' },
      { label: 'Quit Stem', click: () => app.quit() }
    ])
  );
  // Left-click activation is DE-dependent (many StatusNotifier hosts only show
  // the menu); where it does fire, make it the "open the app" gesture.
  tray.on('click', () => deps.onOpenStem());
}
