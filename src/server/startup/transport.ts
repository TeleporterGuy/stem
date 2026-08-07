import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dispatchLocal, serverChannels } from '../ipc/guard';
import { log } from '../log';
import { ensureDevice, resolveDevice, type DeviceRole } from '../transport/auth';
import { startTransportServer, type TransportServer } from '../transport/server';
import { serverEndpointPath } from '../workspace/paths';

/**
 * The server's front door. Every client — the Electron app on this machine, and
 * whatever Phase 2 pairs from elsewhere — reaches the handler registry through
 * here and nowhere else. There is deliberately no in-process shortcut for the
 * embedded case: a path only the embedded deployment exercises is a path the
 * remote deployment never gets tested on.
 *
 * One listener. There used to be two — a second, fixed-port one that
 * `tailscale serve` was pointed at, bound and rebound by Settings → Mobile —
 * because the phone's web client needed a stable address to put in a QR code.
 * That client is gone, and with it the toggle, the port setting, the public-URL
 * setting and the phone role. A deployment that wants to be reachable from
 * elsewhere now terminates TLS in front of this single loopback socket, which is
 * what Phase 2's Caddy container does.
 *
 * Binding is fatal by design: with no transport there is no client.
 */

interface TransportConfig {
  /** ELECTRON_RENDERER_URL in dev; null in a packaged app. Kept for the log line. */
  devUrl: string | null;
}

/** What a client needs to reach this server. */
export interface TransportEndpoint {
  /** Origin of the listener, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** This machine's bearer token, minted at first boot. */
  token: string;
}

let primary: TransportServer | null = null;
/** Monotonic SSE event id (see PushEvent.id). */
let eventSeq = 0;

/** Who is calling: the device registry's answer, and nothing else on top of it. */
async function authenticate(presented: string | null): Promise<DeviceRole | null> {
  const device = await resolveDevice(presented);
  return device ? device.role : null;
}

/**
 * Where the listener binds. Loopback either way — startTransportServer refuses
 * anything else — but which loopback address matters on a host whose `localhost`
 * resolves to ::1 before 127.0.0.1, and a deployment that fronts the server with
 * a proxy wants to say so rather than infer it.
 */
function primaryHost(): string {
  return process.env.STEM_SERVER_HOST?.trim() || '127.0.0.1';
}

/** An origin a client can put in a URL — IPv6 literals need their brackets. */
function originFor(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
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
 * Bind the listener and mint this machine's own device record. Resolves with
 * everything a client needs to connect; throws if the socket cannot be bound,
 * because a server nothing can reach is not a server.
 */
export async function startTransport(cfg: TransportConfig): Promise<TransportEndpoint> {
  const device = await ensureDevice('device', 'This machine');
  // STEM_SERVER_PORT pins the port for a deployment that fronts it; ephemeral
  // otherwise, so two profiles (or two E2E runs) can never collide.
  const requested = Number(process.env.STEM_SERVER_PORT ?? 0);
  const host = primaryHost();
  primary = await startTransportServer({
    port: Number.isFinite(requested) ? requested : 0,
    host,
    authenticate,
    // dispatchLocal applies the same per-channel argument validation the
    // renderer's IPC always got, then the real handler.
    dispatch: (channel, args) => dispatchLocal(channel, args),
    registeredChannels: serverChannels
  });
  const url = originFor(host, primary.port);
  log('transport', 'listening', { host, port: primary.port, dev: !!cfg.devUrl });
  await writeEndpointFile(url);
  return { url, token: device.token };
}

/**
 * Fan an event out to every connected client. Filtering is the client's job —
 * each one keys on threadId exactly as the main window always did — and with a
 * single role there is nothing here that decides who may see what.
 */
export function pushToClients(channel: string, payload: unknown): void {
  if (!primary) return;
  primary.push({ id: ++eventSeq, channel, payload });
}

/** Shut the listener down (app quit). Resolves even with SSE streams open. */
export async function closeTransport(): Promise<void> {
  const current = primary;
  primary = null;
  if (!current) return;
  await current
    .close()
    .catch((e) => log('transport', 'close failed', { error: String((e as Error)?.message ?? e) }));
}
