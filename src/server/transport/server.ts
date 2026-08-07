import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { log } from '../log';
import { presentedToken, requestOriginProblem, type DeviceRole, type OriginPolicy } from './auth';

// Stem's transport: a node:http server bound to 127.0.0.1 ONLY. Every client
// reaches the server through this file and nothing else.
//
// Binding loopback is the outermost layer of the security model — nothing but a
// process on this machine can open the socket at all, so a misconfigured tunnel
// cannot expose it. Never bind 0.0.0.0: the address is an option (a standalone
// stem-server takes it from the environment), and LOOPBACK_HOSTS is what keeps
// that option from becoming a public listener.
//
// Four routes:
//   POST /rpc      {channel, args}  → {ok:true, result} | {ok:false, error}
//   GET  /events                    → Server-Sent Events, server → client
//   GET  /channels                  → what this client may invoke
//   POST /pair     {code}           → {deviceId, token}, the ONE unauthenticated one
//
// There is deliberately no fifth. This server used to serve the phone's web
// bundle out of dist/renderer, with a traversal guard and a dev-mode proxy to
// Vite behind it; that client is gone, every remaining client loads its own UI
// off its own disk, and a static file server nobody reads from is only ever a
// way to leak a file. Anything that is not one of the four routes is a 404.
//
// SSE rather than a WebSocket on purpose: it is one-directional (which is exactly
// the shape of the push side), it survives a reverse proxy without an upgrade
// dance — and node:http can serve it with no new dependency, which a WebSocket
// could not.
//
// Everything security-relevant is injected (authentication, dispatch, the origin
// policy) so this file stays a transport and the tests can drive it end to end
// over a real socket.

/** 25 MB: base64-encoded photo attachments ride POST /rpc as startTurn arguments. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** A pairing code and its JSON wrapper. Unauthenticated, so it gets its own cap. */
const MAX_PAIR_BODY_BYTES = 1024;

/**
 * Keepalive cadence for idle SSE streams. Comfortably under the 60s idle timeout
 * a reverse proxy typically applies — an idled-out stream would silently stop
 * delivering turns with the phone still showing "connected".
 */
const SSE_KEEPALIVE_MS = 25_000;

/** How long the client should wait before reconnecting a dropped stream. */
const SSE_RETRY_MS = 3_000;

/**
 * The only addresses this server will bind, enforced rather than documented.
 *
 * A standalone `stem-server` takes its bind address from the environment, which
 * is exactly the knob somebody reaches for when they want to run it on a VPS —
 * so the refusal has to live here, at the socket, where no caller can route
 * around it. Stem speaks no TLS; being reachable from elsewhere is a proxy's job
 * (Caddy in the deployed configuration), and the proxy talks to this loopback
 * socket. That stays true even on a public domain, which is the point: there is
 * no configuration in which Stem itself answers a public interface.
 *
 * A fronted deployment does need one thing from us — its own hostname arrives in
 * the Host header instead of our port — and that is what `extraHosts` is for.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Who a request turned out to be, resolved once per request from its token. */
export interface DeviceIdentity {
  /** The registry id, so a stream can be torn down when that device is revoked. */
  id: string;
  role: DeviceRole;
}

/** What a redeemed pairing code hands back to the device that spent it. */
export interface PairingGrant {
  deviceId: string;
  token: string;
}

export interface TransportServerOptions {
  /** Loopback port to bind. 0 picks a free one (callers read it back off `port`). */
  port: number;
  /** Loopback address to bind. Defaults to 127.0.0.1; see LOOPBACK_HOSTS. */
  host?: string;
  /**
   * Constant-time bearer check that also answers WHO. Returns the device the
   * token belongs to, or null when nothing matches — so authentication and
   * authorization are decided from one lookup and can never disagree.
   */
  authenticate(presented: string | null): DeviceIdentity | null | Promise<DeviceIdentity | null>;
  /** Runs a registered channel — guard.ts's dispatchLocal. */
  dispatch(channel: string, args: unknown[]): Promise<unknown>;
  /** Every channel registered on the server, for GET /channels to answer with. */
  registeredChannels(): readonly string[];
  /**
   * Spend a pairing code. Rejecting with a `status` property picks the response
   * code (401 for a bad code, 429 once the attempt lockout has tripped); anything
   * else is a 500. Omitted entirely = no /pair route at all, which is what a
   * deployment that only ever pairs off shared disk should do.
   */
  pair?(code: string): Promise<PairingGrant>;
  /** Host values accepted beyond loopback and the tailnet. */
  extraHosts?: readonly string[];
}

/** One server → client push, already stamped with its place in the stream. */
export interface PushEvent {
  /**
   * Monotonic, per-server-run. Nothing consumes it yet — replay is Phase 2 — but
   * it is on the wire from the first release on purpose: adding it later would be
   * a protocol change across every client rather than a server-side addition.
   */
  id: number;
  channel: string;
  payload: unknown;
}

export interface TransportServer {
  /** The bound port (resolved, so a `port: 0` caller learns what it got). */
  readonly port: number;
  /** Fan an event out to every connected client. */
  push(event: PushEvent): void;
  /** Connected SSE clients — diagnostics and tests. */
  clientCount(): number;
  /**
   * End every stream belonging to `deviceId`, returning how many were closed.
   * Revoking a device removes its credential, which stops the NEXT request — an
   * already-open event stream would otherwise keep delivering everything the
   * server pushes, for as long as the socket lives.
   */
  dropDevice(deviceId: string): number;
  close(): Promise<void>;
}

/** Marker for a body that blew the cap, so the caller can answer 413 not 400. */
class BodyTooLarge extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The bridge's responses are per-request state; a proxy must never reuse them.
    'cache-control': 'no-store'
  });
  res.end(text);
}

/**
 * Buffer a request body up to `limit`. An over-cap body is refused rather than
 * accumulated: the declared Content-Length short-circuits before a byte arrives,
 * and a lying (or chunked) sender is cut off the moment it crosses the line.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      rejectBody(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/**
 * One SSE frame. JSON.stringify escapes newlines, so `data:` is always one line.
 * The `id:` line is what a future replay implementation resumes from; browsers
 * echo it back as Last-Event-ID for free, and this server ignores that header.
 */
function sseFrame(event: PushEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify({ channel: event.channel, payload: event.payload })}\n\n`;
}

export async function startTransportServer(opts: TransportServerOptions): Promise<TransportServer> {
  const bindHost = opts.host ?? '127.0.0.1';
  // Before anything is created, so a misconfigured deployment fails at boot with
  // a sentence rather than by quietly answering the internet.
  if (!LOOPBACK_HOSTS.has(bindHost)) {
    throw new Error(
      `refusing to bind ${bindHost}: Stem's transport is loopback-only. Reaching it from another ` +
        'machine goes through a proxy that terminates TLS and forwards to this socket; set ' +
        'STEM_TRUSTED_HOSTS to the name that proxy is reached under.'
    );
  }

  /**
   * Live SSE responses, each tagged with the device that opened it so revocation
   * can find it. A closed client is removed by its own 'close' handler.
   */
  const clients = new Set<{ res: ServerResponse; deviceId: string }>();
  /** Every open socket, so close() can destroy them (see the close() comment). */
  const sockets = new Set<Socket>();

  const originPolicy = (): OriginPolicy => ({ port: boundPort, extraHosts: opts.extraHosts });

  /** Token + origin, the two gates every authenticated route shares. */
  async function gate(
    req: IncomingMessage
  ): Promise<{ device: DeviceIdentity } | { status: number; error: string }> {
    const device = await opts.authenticate(presentedToken(req.headers));
    if (!device) return { status: 401, error: 'unauthorized' };
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) return { status: 403, error: origin };
    return { device };
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /rpc', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        sendJson(res, 413, { ok: false, error: 'request body too large' });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'could not read request body' });
      return;
    }

    let body: { channel?: unknown; args?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      return;
    }
    const channel = body?.channel;
    const args = body?.args ?? [];
    if (typeof channel !== 'string' || !Array.isArray(args)) {
      sendJson(res, 400, { ok: false, error: 'expected {channel: string, args: unknown[]}' });
      return;
    }
    // No allowlist stands between a valid token and the registry: the server's
    // registered handlers ARE the surface, exactly as they were when the desktop
    // reached them through ipcMain. An unregistered channel is refused by
    // dispatch itself, in the guard's own words, and arrives below as a 400 —
    // which is what a pre-check here would have had to reproduce by hand.
    try {
      // dispatch runs the same per-channel argsProblem validation the renderer's
      // IPC gets, then the real handler — so a malformed startTurn is refused
      // here for exactly the reason it would be refused at the desk.
      const result = await opts.dispatch(channel, args);
      sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      // A rejected-call message is the caller's fault (400); anything else is
      // the handler failing, which the client should surface as an error, not a
      // permission problem.
      const status = /^Rejected local call/.test(error) ? 400 : 500;
      sendJson(res, status, { ok: false, error });
    }
  }

  /**
   * What this caller may invoke. A client binds its own IPC surface from this at
   * connect time, so it never has to carry a copy of the server's registry —
   * which is what lets the same desktop build talk to an embedded server and a
   * standalone one.
   */
  async function handleChannels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /channels', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    sendJson(res, 200, { ok: true, result: [...opts.registeredChannels()] });
  }

  async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /events', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx (and anything modelled on it) buffers proxied responses by default,
      // which would hold every delta until the turn ends.
      'x-accel-buffering': 'no'
    });
    // Flush the headers and set the client's reconnect backoff in one dispatch;
    // a block with no `data:` field fires no event.
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    const client = { res, deviceId: gated.device.id };
    clients.add(client);

    const drop = (): void => {
      clients.delete(client);
    };
    // 'close' covers both a clean disconnect and a dropped connection; the
    // 'error' handler exists so a mid-write reset can't reach the process.
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /**
   * Spend a pairing code. The one route that answers without a token, because it
   * is how a device that has no token gets one.
   *
   * The origin check still applies — a page in a browser must not be able to
   * drive it — but the token gate obviously cannot, so the protection is entirely
   * in pairing.ts: a code that only exists for ten minutes, is spent on first
   * use, and locks the route after a handful of wrong guesses. The body cap is
   * its own line of defence: nothing legitimate posts more than a code here.
   */
  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!opts.pair) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) {
      log('transport', 'rejected /pair', { problem: origin });
      sendJson(res, 403, { ok: false, error: origin });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_PAIR_BODY_BYTES);
    } catch {
      sendJson(res, 400, { ok: false, error: 'expected {code: string}' });
      return;
    }
    let code: unknown;
    try {
      code = (JSON.parse(raw) as { code?: unknown })?.code;
    } catch {
      sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      return;
    }
    if (typeof code !== 'string' || !code) {
      sendJson(res, 400, { ok: false, error: 'expected {code: string}' });
      return;
    }
    try {
      const grant = await opts.pair(code);
      log('transport', 'paired a device', { deviceId: grant.deviceId });
      sendJson(res, 200, { ok: true, result: grant });
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      const error = String((e as Error)?.message ?? e);
      log('transport', 'pairing refused', { error });
      sendJson(res, typeof status === 'number' ? status : 500, { ok: false, error });
    }
  }

  /**
   * Anything that is not one of the four routes. A JSON 404 rather than a file:
   * this server has no document root any more, and never gets one back without a
   * client that needs it (see the header comment).
   */
  function handleUnknown(req: IncomingMessage, res: ServerResponse): Promise<void> {
    log('transport', 'no such route', { path: (req.url ?? '/').split('?')[0] });
    sendJson(res, 404, { ok: false, error: 'not found' });
    return Promise.resolve();
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route =
      path === '/rpc' && req.method === 'POST'
        ? handleRpc(req, res)
        : path === '/events' && req.method === 'GET'
          ? handleEvents(req, res)
          : path === '/channels' && req.method === 'GET'
            ? handleChannels(req, res)
            : path === '/pair' && req.method === 'POST'
              ? handlePair(req, res)
              : handleUnknown(req, res);
    // No handler above is expected to reject, but a thrown error here would
    // otherwise become an unhandled rejection and leave the socket hanging.
    void route.catch((e) => {
      log('transport', 'request failed', { path, error: String((e as Error)?.message ?? e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.destroy();
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // A loopback address, never 0.0.0.0 — see LOOPBACK_HOSTS.
    server.listen(opts.port, bindHost);
  });

  const boundPort = (server.address() as AddressInfo | null)?.port ?? opts.port;

  const keepalive = setInterval(() => {
    for (const client of clients) {
      if (client.res.writableEnded || client.res.destroyed) {
        clients.delete(client);
        continue;
      }
      try {
        client.res.write(': keepalive\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, SSE_KEEPALIVE_MS);
  // Never hold the process open for a heartbeat.
  keepalive.unref?.();

  return {
    port: boundPort,
    clientCount: () => clients.size,
    push(event) {
      if (clients.size === 0) return;
      // Serialized once for everybody: every connected client is entitled to
      // every push now that there is one role.
      const text = sseFrame(event);
      for (const client of clients) {
        // A response can be destroyed between its 'close' event and this loop;
        // writing to it would throw ERR_STREAM_DESTROYED into the event emitter.
        if (client.res.writableEnded || client.res.destroyed) {
          clients.delete(client);
          continue;
        }
        try {
          client.res.write(text);
        } catch {
          clients.delete(client);
        }
      }
    },
    dropDevice(deviceId) {
      let dropped = 0;
      for (const client of clients) {
        if (client.deviceId !== deviceId) continue;
        clients.delete(client);
        dropped++;
        // destroy(), not end(): a revoked device must not get a clean EOF it
        // could mistake for an ordinary reconnect cue — and end() waits on a
        // writable that a wedged client may never drain.
        try {
          client.res.destroy();
        } catch {
          // Already gone.
        }
      }
      return dropped;
    },
    close: async () => {
      clearInterval(keepalive);
      for (const client of clients) {
        try {
          client.res.end();
        } catch {
          // Already gone.
        }
      }
      clients.clear();
      // server.close() only stops accepting and then waits for every open
      // connection to end — with an SSE stream open that is forever, so the quit
      // path would hang. Destroy the sockets first, then close.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  };
}
