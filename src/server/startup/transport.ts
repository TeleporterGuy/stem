import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dispatchLocal, serverChannels } from '../ipc/guard';
import { log } from '../log';
import { ensureDevice, ensurePhoneToken, rerollPhoneToken, resolveDevice } from '../transport/auth';
import { startTransportServer, type TransportServer } from '../transport/server';
import type { DeviceRole } from '../transport/roles';
import { serverEndpointPath } from '../workspace/paths';
import { readSettings } from '../workspace/settings';
import type { MobilePairingInfo } from '../../shared/types';

/**
 * The server's front door. Every client — the Electron app on this machine, a
 * phone over `tailscale serve`, anything Phase 2 adds — reaches the handler
 * registry through here and nowhere else. There is deliberately no in-process
 * shortcut for the embedded case: a path only the embedded deployment exercises
 * is a path the remote deployment never gets tested on.
 *
 * Two listeners, one server. They share the request handler, the device registry
 * and the event sequence; they differ only in the address they answer at.
 *
 *   primary   Loopback, ephemeral port, bound once at boot and never rebound.
 *             This is the address the desktop connects to. Never rebinding it is
 *             not tidiness: a rebind would drop the desktop's event stream, and
 *             would destroy the very socket carrying the `settings:updateMobile`
 *             call that asked for it.
 *   phone     Loopback, the port from Settings → Mobile, started/stopped/rebound
 *             by that toggle exactly as the bridge always was. It has to be a
 *             fixed port because `tailscale serve` is configured against it and
 *             the pairing QR encodes it.
 *
 * So `settings.mobile.enabled` no longer means "is there a server" — there always
 * is one. It means "may phones connect", and it is enforced twice: as a role
 * check in authenticate(), so a phone token is refused whichever socket it
 * arrives on, and by not binding the tailnet-facing port at all. Phones stay off
 * by default, exactly as before.
 *
 * Failures on the phone side never propagate — an unusable port must not take the
 * app down, it just leaves the phone unreachable. A failure on the primary side
 * is fatal by design: with no transport there is no client.
 */

interface TransportConfig {
  /** Absolute path to the built renderer bundle (dist/renderer). */
  rendererDir: string;
  /** ELECTRON_RENDERER_URL in dev; null in a packaged app. */
  devUrl: string | null;
}

/** What a client needs to reach this server. */
export interface TransportEndpoint {
  /** Origin of the primary listener, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** The `desktop` device's bearer token, minted at first boot. */
  token: string;
}

let config: TransportConfig | null = null;
let primary: TransportServer | null = null;
let phoneServer: TransportServer | null = null;
/** The port `phoneServer` is bound to, so a port change can be detected as one. */
let phonePort = 0;
/** Whether a `phone`-role token is accepted at all right now (the toggle). */
let phonesAllowed = false;
/** Monotonic SSE event id (see PushEvent.id). Shared by both listeners. */
let eventSeq = 0;
/** Serializes phone start/stop so a fast enable→disable toggle can't cross itself. */
let chain: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Who is calling. Authentication and the phone toggle are answered together, so a
 * disabled bridge refuses a phone token identically to an unknown one — the
 * caller learns nothing from the difference.
 */
async function authenticate(presented: string | null): Promise<DeviceRole | null> {
  const device = await resolveDevice(presented);
  if (!device) return null;
  if (device.role === 'phone' && !phonesAllowed) return null;
  return device.role;
}

/**
 * Where the primary listener binds. Loopback either way — startTransportServer
 * refuses anything else — but which loopback address matters on a host whose
 * `localhost` resolves to ::1 before 127.0.0.1, and a deployment that fronts the
 * server with a tunnel wants to say so rather than infer it.
 */
function primaryHost(): string {
  return process.env.STEM_SERVER_HOST?.trim() || '127.0.0.1';
}

/** An origin a client can put in a URL — IPv6 literals need their brackets. */
function originFor(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** Options both listeners share; only the address differs. */
function listenerOptions(port: number, host?: string): Parameters<typeof startTransportServer>[0] {
  return {
    port,
    host,
    rendererDir: config!.rendererDir,
    devUrl: config!.devUrl,
    authenticate,
    // dispatchLocal applies the same per-channel argument validation the
    // renderer's IPC always got, then the real handler.
    dispatch: (channel, args) => dispatchLocal(channel, args),
    registeredChannels: serverChannels
  };
}

/**
 * Publish where we are listening, so a client that did NOT start this process can
 * find it. The desktop in embedded mode is handed the endpoint directly and never
 * reads this file; a standalone `stem-server` is the reason it exists.
 */
async function writeEndpointFile(url: string): Promise<void> {
  const path = serverEndpointPath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const body = { url, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8').catch((e) =>
    log('transport', 'could not publish the endpoint', { error: String((e as Error)?.message ?? e) })
  );
}

/**
 * Bind the primary listener and mint this machine's own device record. Resolves
 * with everything a client needs to connect; throws if the socket cannot be
 * bound, because a server nothing can reach is not a server.
 */
export async function startTransport(cfg: TransportConfig): Promise<TransportEndpoint> {
  config = cfg;
  const desktop = await ensureDevice('desktop', 'This machine');
  // STEM_SERVER_PORT pins the port for a deployment that fronts it; ephemeral
  // otherwise, so two profiles (or two E2E runs) can never collide.
  const requested = Number(process.env.STEM_SERVER_PORT ?? 0);
  const host = primaryHost();
  primary = await startTransportServer(listenerOptions(Number.isFinite(requested) ? requested : 0, host));
  const url = originFor(host, primary.port);
  log('transport', 'listening', { host, port: primary.port });
  await writeEndpointFile(url);
  // The phone side is settings-driven and allowed to fail; never block boot on it.
  void syncPhoneAccess();
  return { url, token: desktop.token };
}

/**
 * Bring the phone side in line with the current settings: accept phone tokens and
 * bind the tailnet-facing port when the toggle is on, refuse and unbind when off,
 * rebind when the port changed. Idempotent, and safe to call on every settings
 * write.
 */
export function syncPhoneAccess(): Promise<void> {
  return enqueue(async () => {
    if (!config) return;
    const { mobile } = await readSettings();
    phonesAllowed = mobile.enabled;
    if (!mobile.enabled) {
      await stopPhoneServer();
      return;
    }
    if (phoneServer && phonePort === mobile.port) return;
    await stopPhoneServer();

    // Mint the token before listening, so the very first request can be checked.
    await ensurePhoneToken();
    try {
      phoneServer = await startTransportServer(listenerOptions(mobile.port));
      phonePort = phoneServer.port;
      log('transport', 'phones listening', { port: phonePort, dev: !!config.devUrl });
    } catch (e) {
      phoneServer = null;
      phonePort = 0;
      // Almost always EADDRINUSE from another app on the chosen port. Logged and
      // swallowed: the Settings pane shows `running: false` and the user picks
      // another port.
      log('transport', 'phones failed to start', { port: mobile.port, error: String((e as Error)?.message ?? e) });
    }
  });
}

async function stopPhoneServer(): Promise<void> {
  const current = phoneServer;
  if (!current) return;
  phoneServer = null;
  phonePort = 0;
  await current
    .close()
    .catch((e) => log('transport', 'phone close failed', { error: String((e as Error)?.message ?? e) }));
}

/**
 * Fan an event out to every connected client. `roles` narrows the audience past
 * what the channel already allows — used for events a desktop surface has claimed
 * exclusively, which must not be mirrored to a phone. Everything else is filtered
 * by the channel's own per-role push allowlist (see transport/roles.ts), so a
 * caller never has to remember which pushes a phone may see.
 */
export function pushToClients(channel: string, payload: unknown, roles?: readonly DeviceRole[]): void {
  if (!primary && !phoneServer) return;
  const event = { id: ++eventSeq, channel, payload, roles };
  primary?.push(event);
  phoneServer?.push(event);
}

/** Whether the tailnet-facing listener is up right now. */
export function isPhoneBridgeRunning(): boolean {
  return !!phoneServer;
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
  const port = phoneServer ? phonePort : mobile.port;
  const loopbackUrl = `http://127.0.0.1:${port}/mobile.html#token=${token}`;
  const reachable = !!mobile.publicUrl;
  return {
    enabled: mobile.enabled,
    running: !!phoneServer,
    port,
    token,
    url: reachable ? `${mobile.publicUrl}/mobile.html#token=${token}` : loopbackUrl,
    loopbackUrl,
    reachable
  };
}

/**
 * Mint a fresh phone token and hand back the new pairing info. This is the whole
 * revocation story: every paired phone stops working at once and has to be
 * re-paired. The phone listener is bounced rather than left running, because a
 * re-roll has to drop the SSE streams a revoked phone is already holding open —
 * they would otherwise keep receiving pushes until something made them reconnect.
 * The primary listener is untouched, so the desktop that asked for the re-roll
 * never loses the connection it asked over.
 */
export async function rerollMobilePairing(): Promise<MobilePairingInfo> {
  await enqueue(async () => {
    await rerollPhoneToken();
    await stopPhoneServer();
  });
  await syncPhoneAccess();
  return mobilePairingInfo();
}

/** Shut both listeners down (app quit). Resolves even with SSE streams open. */
export function closeTransport(): Promise<void> {
  return enqueue(async () => {
    await stopPhoneServer();
    const current = primary;
    primary = null;
    if (current) {
      await current
        .close()
        .catch((e) => log('transport', 'close failed', { error: String((e as Error)?.message ?? e) }));
    }
  });
}
