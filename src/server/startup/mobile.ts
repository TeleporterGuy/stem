import { dispatchLocal, serverChannels } from '../ipc/guard';
import { log } from '../log';
import { ensurePhoneToken, rerollPhoneToken, tokenEquals } from '../transport/auth';
import { startTransportServer, type TransportServer } from '../transport/server';
import { readSettings } from '../workspace/settings';
import { SettledTurns, isSettledMethod } from '../../shared/settledTurns';
import type { MobilePairingInfo, StartTurnResult } from '../../shared/types';

/**
 * The phone bridge: a loopback HTTP server that serves Stem's mobile client and
 * proxies an allowlisted slice of the IPC surface to it (see transport/server.ts).
 * Everything the server needs is wired here — the token check, the dispatch into
 * the existing handler registry, and the bundle directory.
 *
 * The bridge is off by default and lives entirely behind a settings toggle, so
 * this module is a small state machine: `syncMobileBridge()` reads the setting
 * and starts, stops, or rebinds accordingly, and is safe to call on every
 * settings write. Failures never propagate — an unusable port must not take the
 * app down, it just leaves the phone unreachable.
 */

interface BridgeConfig {
  /** Absolute path to the built renderer bundle (dist/renderer). */
  rendererDir: string;
  /** ELECTRON_RENDERER_URL in dev; null in a packaged app. */
  devUrl: string | null;
}

let config: BridgeConfig | null = null;
let server: TransportServer | null = null;
/** Monotonic SSE event id (see PushEvent.id). Never reset while a server lives. */
let eventSeq = 0;
/** The port `server` is bound to, so a port change can be detected as a change. */
let boundPort = 0;
/** Serializes start/stop so a fast enable→disable toggle can't cross itself. */
let chain: Promise<void> = Promise.resolve();

/**
 * Threads whose current turn was started from the phone. `busyWithin` counts
 * these so the task scheduler cannot preempt a live phone conversation — the
 * desktop's own run-state tracking (ClientBridge.hasLiveTurn) doesn't necessarily
 * know about a thread the phone opened, and the scheduler must not run a turn on
 * top of one.
 */
const mobileTurns = new Set<string>();

/**
 * Turns whose terminal event arrived before `backend:startTurn` returned. The
 * runtime can settle a turn between acknowledging the prompt and resolving
 * startTurn() — likeliest on a fast turn in a new chat, which additionally awaits
 * set_session_name. Without this the terminal event deletes a threadId that has
 * not been added yet, the late response adds it, and nothing ever removes it:
 * busyWithin() then reports user activity forever and the scheduler defers every
 * task until the backend exits. The renderer carries the same guard for the same
 * ordering (see session/turns.ts).
 */
const settledTurns = new SettledTurns();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Run an allowlisted channel through the shared IPC handler registry, noting
 * turns the phone starts on the way past. dispatchLocal applies the same
 * per-channel argument validation the renderer's IPC gets.
 */
async function dispatch(channel: string, args: unknown[]): Promise<unknown> {
  const result = await dispatchLocal(channel, args);
  if (channel === 'backend:startTurn') {
    const started = result as StartTurnResult | undefined;
    // Consuming means the turn already ended while we were awaiting the
    // response, so there is nothing live to mark busy.
    if (started?.threadId && !settledTurns.consume(started.turnId)) mobileTurns.add(started.threadId);
  }
  return result;
}

async function stopServer(): Promise<void> {
  const current = server;
  if (!current) return;
  server = null;
  boundPort = 0;
  mobileTurns.clear();
  await current.close().catch((e) => log('mobile', 'close failed', { error: String((e as Error)?.message ?? e) }));
}

/** Record the bundle location + dev URL. Call once, before the first sync. */
export function initMobileBridge(cfg: BridgeConfig): void {
  config = cfg;
}

/**
 * Bring the server in line with the current settings: start it when the toggle
 * is on, stop it when off, rebind when the port changed. Idempotent.
 */
export function syncMobileBridge(): Promise<void> {
  return enqueue(async () => {
    if (!config) return;
    const { mobile } = await readSettings();
    if (!mobile.enabled) {
      await stopServer();
      return;
    }
    if (server && boundPort === mobile.port) return;
    await stopServer();

    // Mint the token before listening, so the very first request can be checked.
    await ensurePhoneToken();
    try {
      server = await startTransportServer({
        port: mobile.port,
        rendererDir: config.rendererDir,
        devUrl: config.devUrl,
        // Re-read rather than close over the token: a re-roll must take effect on
        // the very next request. The device registry keeps an in-process copy, so
        // this costs nothing on the hot path.
        authenticate: async (presented) =>
          tokenEquals(await ensurePhoneToken(), presented) ? 'phone' : null,
        dispatch,
        registeredChannels: serverChannels
      });
      boundPort = server.port;
      log('mobile', 'listening', { port: boundPort, dev: !!config.devUrl });
    } catch (e) {
      server = null;
      boundPort = 0;
      // Almost always EADDRINUSE from another app on the chosen port. Logged and
      // swallowed: the Settings pane shows `running: false` and the user picks
      // another port.
      log('mobile', 'failed to start', { port: mobile.port, error: String((e as Error)?.message ?? e) });
    }
  });
}

/** Push a pushable channel to every connected phone. No-op when the bridge is off. */
export function pushToMobile(channel: string, payload: unknown): void {
  server?.push({ id: ++eventSeq, channel, payload });
}

/**
 * Clear a phone turn's busy mark when it ends. Fed from the backend event tap in
 * index.ts, alongside the client's own run-state tracking.
 */
export function noteMobileTurnEvent(method: string, threadId: string, turnId?: string): void {
  if (!isSettledMethod(method)) return;
  mobileTurns.delete(threadId);
  // Keyed by turn, not thread: thread ids recur, so remembering the thread would
  // suppress the busy mark of the NEXT turn on it.
  if (turnId) settledTurns.note(turnId);
}

/** Turns started from the phone that haven't ended yet — the scheduler's guard. */
export function mobileTurnsInFlight(): number {
  return mobileTurns.size;
}

/** Drop every busy mark (the backend died; no turn survived it). */
export function clearMobileTurns(): void {
  mobileTurns.clear();
}

/** Whether the loopback server is listening right now. */
export function isMobileBridgeRunning(): boolean {
  return !!server;
}

/**
 * Everything the pairing UI needs. Both URLs carry the token in their FRAGMENT,
 * which browsers never send to a server — the client reads it once, persists it,
 * and strips the hash.
 *
 * The phone URL has to come from the `publicUrl` setting: `tailscale serve`
 * publishes the bridge under a MagicDNS name that nothing on this machine can
 * discover, so the user tells Stem what it is. Until they do, `url` is the
 * loopback one and `reachable` says so, rather than handing out a QR that
 * silently resolves to the phone's own localhost.
 */
export async function mobilePairingInfo(): Promise<MobilePairingInfo> {
  const { mobile } = await readSettings();
  const token = await ensurePhoneToken();
  const port = server ? boundPort : mobile.port;
  const loopbackUrl = `http://127.0.0.1:${port}/mobile.html#token=${token}`;
  const reachable = !!mobile.publicUrl;
  return {
    enabled: mobile.enabled,
    running: !!server,
    port,
    token,
    url: reachable ? `${mobile.publicUrl}/mobile.html#token=${token}` : loopbackUrl,
    loopbackUrl,
    reachable
  };
}

/**
 * Mint a fresh token and hand back the new pairing info. This is the whole
 * revocation story: every paired phone stops working at once and has to be
 * re-paired. The server is bounced rather than left running, because a re-roll
 * has to drop the SSE streams a revoked phone is already holding open — they
 * would otherwise keep receiving pushes until something made them reconnect.
 */
export async function rerollMobilePairing(): Promise<MobilePairingInfo> {
  await enqueue(async () => {
    await rerollPhoneToken();
    await stopServer();
  });
  await syncMobileBridge();
  return mobilePairingInfo();
}

/** Shut the bridge down (app quit). Resolves even with SSE streams open. */
export function closeMobileBridge(): Promise<void> {
  return enqueue(stopServer);
}
