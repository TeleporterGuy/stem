import { app, safeStorage, shell, utilityProcess } from 'electron';
import type { StemHost, WorkerTransport } from '../server/host';

// The Electron half of the host shim (src/server/host/index.ts). Everything the
// server used to reach for directly, supplied by the process that actually has
// it — and nothing else: if a capability isn't overridden here, the server's
// headless default is already the right answer on the desktop too.
//
// This is the ONLY direction the dependency ever runs. The desktop imports the
// server; the server never imports the desktop. That rule is what makes
// `node dist/main/server.js` bootable, and it is enforced in CI by booting it.

/** The overrides the Electron host improves on. Installed once, before anything else. */
export function electronHost(): Partial<StemHost> {
  return {
    // A window means somebody is sitting at this machine: Stem is running on
    // their own computer, not on a server they connect to.
    kind: () => 'desktop',
    // Electron's own userData — so an existing install keeps reading exactly the
    // directory it always has. The headless default reimplements this layout, so
    // the two agree; this override exists to respect `--user-data-dir` and the
    // profile switches, which only Electron knows about.
    stateRoot: () => app.getPath('userData'),
    appDataRoot: () => app.getPath('appData'),
    appRoot: () => app.getAppPath(),
    appVersion: () => app.getVersion(),
    keyWrapper: () => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
      } catch {
        // Called before app-ready, or a Linux session with no keyring.
        return null;
      }
      return {
        wrap: (plain) => safeStorage.encryptString(plain),
        unwrap: (wrapped) => safeStorage.decryptString(wrapped)
      };
    },
    // Same protocol as a plain fork, but Electron's own child type: it shows up
    // in Activity Monitor under `serviceName` and dies with the app.
    forkWorker: (entry, opts) => {
      const child = utilityProcess.fork(entry, [], { serviceName: opts.serviceName });
      return {
        send: (msg) => child.postMessage(msg),
        onMessage: (cb) => {
          child.on('message', cb);
        },
        onExit: (cb) => {
          child.on('exit', cb);
        },
        kill: () => {
          child.kill();
        }
      } satisfies WorkerTransport;
    },
    // Electron ships no `node` binary; its own executable runs bundled scripts
    // as Node when told to. Per-child only — setting it globally would break
    // Electron's own child windows.
    nodeSpawn: () => ({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }),
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    onShutdown: (fn) => {
      app.on('will-quit', () => fn());
    }
  };
}
