import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { a, argsProblem, ipcArgSpecs, type ArgSpec, type NoCallerEvent } from '../server/ipc';
import { log } from '../server/log';

// The Electron half of the IPC guard (the other half is src/server/ipc/guard.ts).
// Two things live here because only the client can do them:
//
//  - the trusted-sender check. "Trusted" means a window WE created showing OUR
//    renderer, which is a fact about BrowserWindows — the server has none.
//  - the ipcMain binding itself. On a headless host there is no ipcMain.
//
// Channels come from two places, and the difference is the whole point:
//
//  SERVER-OWNED (~110 channels) — the server's registry IS the desktop's surface.
//    We bind whatever it says it registered (GET /channels) and forward the call
//    over the wire. No allowlist: a channel the server answers is a channel any
//    authenticated client may call, and the token is the whole decision.
//
//  CLIENT-OWNED (the table below) — channels the desktop answers itself because
//    they act on THIS machine: native pickers, revealing a path in the file
//    manager, and the Quick Chat window choreography. They are never registered
//    on the server and never reachable over the wire.
//
// Both paths run the identical sender + argument checks and produce the identical
// rejection message, because the renderer cannot tell (and must not have to) which
// side of the split answers a given channel.

/**
 * Argument shapes for the client-owned channels — the desktop's half of the
 * table in ipc/guard.ts, with the same contract: a channel absent from it takes
 * no arguments at all.
 */
const LOCAL_IPC_ARGS: Record<string, ArgSpec[]> = {
  'files:preview': [a.string],
  'files:download': [a.string],
  'cfolders:reveal': [a.string],
  'client:pair': [a.string, a.string],
  'stem:exportState': [a.object],
  'settings:updateReleaseNotes': [a.object],
  'quickchat:run': [a.object],
  'quickchat:handoff': [a.object]
};

/**
 * Why the sender is untrusted, or null when it is fine. Trusted = the top-level
 * frame of a window we created, showing our own renderer (packaged file:// or
 * the electron-vite dev server). Subframes and foreign origins never get IPC.
 */
export function senderProblem(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): string | null {
  const frame = event.senderFrame;
  if (!frame) return 'no sender frame';
  if (frame !== event.sender.mainFrame) return 'IPC from a subframe';
  const url = frame.url;
  if (url.startsWith('file://')) return null;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && url.startsWith(dev)) return null;
  return `untrusted sender url ${url}`;
}

/** Channels already handed to ipcMain — a second handle() for one throws. */
const bound = new Set<string>();

/**
 * ipcMain.handle with the sender check and per-channel argument validation
 * applied before `invoke` runs. Rejected calls throw back to the renderer's
 * invoke() and are logged; the handler is never entered.
 */
function bind(channel: string, specs: ArgSpec[], invoke: (args: unknown[]) => unknown): void {
  if (bound.has(channel)) return;
  bound.add(channel);
  ipcMain.handle(channel, (event, ...args) => {
    const problem = senderProblem(event) ?? argsProblem(specs, args);
    if (problem) {
      log('ipc', `rejected ${channel}`, { problem });
      throw new Error(`Rejected IPC call to ${channel}: ${problem}.`);
    }
    return invoke(args);
  });
}

/** The client-owned handlers, looked up per call so a re-registration takes. */
const localHandlers = new Map<string, (event: NoCallerEvent, ...args: unknown[]) => unknown>();

/**
 * Register a channel the DESKTOP answers (see the client-owned bucket above).
 * The handler takes the same absent first parameter as a server one, so a block
 * of code can move between the two sides unchanged.
 */
export function handleLocal(
  channel: string,
  handler: (event: NoCallerEvent, ...args: never[]) => unknown
): void {
  localHandlers.set(channel, handler as (event: NoCallerEvent, ...args: unknown[]) => unknown);
  bind(channel, LOCAL_IPC_ARGS[channel] ?? [], (args) => localHandlers.get(channel)!(undefined, ...args));
}

/**
 * Expose the channels the server told us it answers, forwarding each one over the
 * transport. Call once, with the list the proxy fetched at connect time — the
 * registry is the surface, so anything registered later would silently not be
 * reachable from a window.
 *
 * The arguments are validated twice, here and again on the far side, and neither
 * check is waste. This one is what makes a bad call read `Rejected IPC call to X:
 * …` in the renderer, exactly as it did before there was a wire; the server's is
 * the check every OTHER client relies on, and must not be skippable by whoever
 * happens to call in.
 */
export function bindServerChannels(
  channels: readonly string[],
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
): void {
  for (const channel of channels) {
    bind(channel, ipcArgSpecs(channel), (args) => invoke(channel, args));
  }
}
