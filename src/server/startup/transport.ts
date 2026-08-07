import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { readableFilePath } from '../files/store';
import { liveTurnSnapshot } from '../live-turns';
import { stageUpload, startStagingSweeper, stopStagingSweeper } from '../files/staging';
import { dispatchLocal, serverChannels } from '../ipc/guard';
import { log } from '../log';
import { resolveDevice } from '../transport/auth';
import { redeemPairingCode } from '../transport/pairing';
import {
  startTransportServer,
  type DeviceIdentity,
  type DownloadTarget,
  type TransportServer
} from '../transport/server';
import { serverEndpointPath } from '../workspace/paths';

/**
 * The server's front door. Every client — the Electron app on this machine, and
 * every device paired to it from elsewhere — reaches the handler registry through
 * here and nowhere else. There is deliberately no in-process shortcut for the
 * embedded case: a path only the embedded deployment exercises is a path the
 * remote deployment never gets tested on.
 *
 * One listener. There used to be two — a second, fixed-port one that
 * `tailscale serve` was pointed at, bound and rebound by Settings → Mobile —
 * because the phone's web client needed a stable address to put in a QR code.
 * That client is gone, and with it the toggle, the port setting, the public-URL
 * setting and the phone role. A deployment that wants to be reachable from
 * elsewhere now terminates TLS in front of this single loopback socket.
 *
 * This file does NOT mint a credential for anyone. A server that hands itself a
 * bearer token at boot would have to write it down somewhere readable, which is
 * the exact property hashing the registry was for. Clients acquire their own:
 * off shared disk (src/desktop/client-store.ts) or through a pairing code.
 *
 * Binding is fatal by design: with no transport there is no client.
 */

interface TransportConfig {
  /** ELECTRON_RENDERER_URL in dev; null in a packaged app. Kept for the log line. */
  devUrl: string | null;
}

/** Where this server is listening. */
export interface TransportEndpoint {
  /** Origin of the listener, e.g. `http://127.0.0.1:52413`. */
  url: string;
}

let primary: TransportServer | null = null;
/** Monotonic SSE event id (see PushEvent.id). */
let eventSeq = 0;

/** Who is calling: the device registry's answer, and nothing else on top of it. */
async function authenticate(presented: string | null): Promise<DeviceIdentity | null> {
  const device = await resolveDevice(presented);
  return device ? { id: device.id, role: device.role } : null;
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

/**
 * Host headers to accept beyond loopback-with-our-port and the tailnet.
 *
 * A fronted deployment needs this: a request that reached Caddy at
 * `stem.example.com` arrives here carrying that name, which is neither our
 * loopback port nor a `.ts.net` address, and the rebinding check would refuse it.
 * Naming the hostnames explicitly keeps the check meaningful — it is still a
 * closed set, just one the deployment declares rather than one we guess.
 */
function trustedHosts(): string[] {
  return (process.env.STEM_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * What GET /files/<rel> is allowed to send back, and the route's whole
 * authorization decision. Deliberately one call: it is the SAME resolver the
 * `files:*` channels bound their paths with, so a file this serves is by
 * construction one the Files panel already lists. A second containment check
 * written here would be a second check that could disagree with that one.
 */
export async function resolveDownload(rel: string): Promise<DownloadTarget | null> {
  const path = await readableFilePath(rel);
  if (!path) return null;
  return { path, name: basename(path), size: (await stat(path)).size };
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
 * Bind the listener. Resolves with where it is; throws if the socket cannot be
 * bound, because a server nothing can reach is not a server.
 */
export async function startTransport(cfg: TransportConfig): Promise<TransportEndpoint> {
  // STEM_SERVER_PORT pins the port for a deployment that fronts it; ephemeral
  // otherwise, so two profiles (or two E2E runs) can never collide.
  const requested = Number(process.env.STEM_SERVER_PORT ?? 0);
  const host = primaryHost();
  const extraHosts = trustedHosts();
  primary = await startTransportServer({
    port: Number.isFinite(requested) ? requested : 0,
    host,
    authenticate,
    // dispatchLocal applies the same per-channel argument validation the
    // renderer's IPC always got, then the real handler.
    dispatch: (channel, args) => dispatchLocal(channel, args),
    registeredChannels: serverChannels,
    pair: async (code) => {
      const minted = await redeemPairingCode(code);
      return { deviceId: minted.device.id, token: minted.token };
    },
    stageUpload,
    openDownload: resolveDownload,
    // What a client is told the instant it connects. A turn that kept running
    // while it was away is otherwise indistinguishable from one that finished
    // without it — both look like a thread that stopped producing deltas — and
    // the two need opposite things on screen.
    connectSnapshot: () => ({ liveTurns: liveTurnSnapshot() }),
    extraHosts
  });
  // Uploads outlive the request that made them, so somebody has to notice the
  // ones nothing ever came back for. Started with the listener because that is
  // what makes them possible in the first place.
  startStagingSweeper();
  const url = originFor(host, primary.port);
  log('transport', 'listening', { host, port: primary.port, dev: !!cfg.devUrl, extraHosts });
  await writeEndpointFile(url);
  return { url };
}

/**
 * Fan an event out to every connected client. Filtering is the client's job —
 * each one keys on threadId exactly as the main window always did — and with a
 * single role there is nothing here that decides who may see what.
 *
 * That last property is load-bearing now that the transport keeps a replay
 * buffer: every frame in it went to every device, so handing one back to a
 * device that was offline at the time discloses nothing it would not have been
 * sent live. A push aimed at a single device would break that, which is why
 * there is no parameter here to aim one with.
 */
export function pushToClients(channel: string, payload: unknown): void {
  if (!primary) return;
  primary.push({ id: ++eventSeq, channel, payload });
}

/**
 * Cut every event stream a device has open. Called with (not instead of) revoking
 * its record: the registry decides the next request, this decides the one already
 * in flight, and a revocation that only did the first would leave a removed
 * device watching the stream indefinitely.
 */
export function dropDeviceStreams(deviceId: string): number {
  return primary?.dropDevice(deviceId) ?? 0;
}

/** Shut the listener down (app quit). Resolves even with SSE streams open. */
export async function closeTransport(): Promise<void> {
  const current = primary;
  primary = null;
  stopStagingSweeper();
  if (!current) return;
  await current
    .close()
    .catch((e) => log('transport', 'close failed', { error: String((e as Error)?.message ?? e) }));
}
