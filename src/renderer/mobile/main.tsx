import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp, PairingNotice } from './MobileApp';
import { createMobileTransport, readPairingToken } from './transport';
import '../styles.css';
import './mobile.css';

// Entry for the phone bundle (src/renderer/mobile.html), served by the loopback
// bridge. Two things have to happen before React mounts:
//
//  1. `window.stem` must exist. There is no preload here, so the transport shim
//     IS the bridge — and modules the phone shares with the desktop (session/
//     turns.ts, renderer/attachments.ts) reach for `window.stem` as soon as they
//     run. Installing it after mount would be a race.
//  2. The pairing token must come off the URL fragment and into storage, and the
//     fragment must go. It never reaches the server by design; leaving it in the
//     address bar would just be a credential sitting in a shareable URL.
//
// With no token this is an unpaired browser, not a broken app: say so, rather
// than mounting a client that 401s on everything.

document.body.classList.add('mobile-body');

const pairing = readPairingToken(window.location.hash, window.localStorage);
if (pairing.fromFragment) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

const transport = pairing.token ? createMobileTransport({ token: pairing.token }) : null;
if (transport) window.stem = transport.api;

const container = document.getElementById('root');
if (container) {
  try {
    createRoot(container).render(
      <StrictMode>{transport ? <MobileApp transport={transport} /> : <PairingNotice />}</StrictMode>
    );
  } catch (error) {
    const panel = document.createElement('div');
    panel.className = 'fatal-renderer-error';
    panel.textContent = `Stem failed to start: ${String(error)}`;
    container.replaceChildren(panel);
  }
}
