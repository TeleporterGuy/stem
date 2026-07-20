import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { QuickChat } from './quickchat/QuickChat';
import { StatusHud } from './quickchat/StatusHud';
import { ShortcutsProvider } from './shortcuts';
import './styles.css';

// The same renderer bundle serves all three windows; the URL flag selects which:
// `?quickchat` = the overlay, `?hud` = the bottom-left status pill, else the app.
const params = new URLSearchParams(window.location.search);
const isQuickChat = params.has('quickchat');
const isHud = params.has('hud');
if (isQuickChat) document.body.classList.add('qc-body');
if (isHud) document.body.classList.add('hud-body');
// Let CSS branch per OS (e.g. the Linux overlay draws its own card + shadow,
// the Linux main window has a native frame so the toolbar drops its
// traffic-light inset). macOS styles stay the classless defaults.
document.body.classList.add(`platform-${window.stem.platform}`);

const root = isHud ? (
  <StatusHud />
) : isQuickChat ? (
  <QuickChat />
) : (
  <ShortcutsProvider>
    <App />
  </ShortcutsProvider>
);

const container = document.getElementById('root');
if (container) {
  try {
    createRoot(container).render(<StrictMode>{root}</StrictMode>);
  } catch (error) {
    const panel = document.createElement('div');
    panel.className = 'fatal-renderer-error';
    panel.textContent = `Stem failed to start: ${String(error)}`;
    container.replaceChildren(panel);
  }
}
