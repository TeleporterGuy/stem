import { BrowserWindow, screen } from 'electron';
import { workspaceVisibilityOptions } from '../platform';

// The "Stem is controlling this Mac" pill: a small always-on-top window at the
// top centre of the main display for as long as a run is on. It is the one
// thing the person at the machine sees that says why the cursor is moving, and
// its Stop button is a courtesy — the click itself is human input, and the
// helper's event tap ends the run before the button could.

const WIDTH = 340;
const HEIGHT = 44;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;font:13px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none}
  .pill{display:flex;align-items:center;gap:10px;height:36px;margin:4px;padding:0 6px 0 14px;border-radius:18px;
    background:rgba(20,20,24,.92);color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35)}
  .dot{width:8px;height:8px;border-radius:50%;background:#ff5f57;animation:p 1.2s infinite}
  @keyframes p{50%{opacity:.35}}
  .txt{flex:1;white-space:nowrap}
  button{height:26px;padding:0 12px;border:0;border-radius:13px;background:#fff;color:#111;font:600 12px -apple-system,sans-serif;cursor:pointer}
</style></head><body><div class="pill"><span class="dot"></span><span class="txt">Stem is controlling this Mac</span>
<button>Stop</button></div></body></html>`;

export interface ComputerBanner {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createComputerBanner(): ComputerBanner {
  let win: BrowserWindow | null = null;

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const opts = workspaceVisibilityOptions();
    if (opts) win.setVisibleOnAllWorkspaces(true, opts);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    return win;
  }

  return {
    show() {
      const w = ensure();
      const area = screen.getPrimaryDisplay().workArea;
      w.setPosition(Math.round(area.x + (area.width - WIDTH) / 2), area.y + 8);
      w.showInactive();
    },
    hide() {
      if (win && !win.isDestroyed()) win.hide();
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    }
  };
}
