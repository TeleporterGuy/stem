import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { log } from '../log';
import { presentedToken, requestOriginProblem, type OriginPolicy } from './auth';
import { channelPolicy, channelsFor, mayInvoke, mayReceive, type DeviceRole } from './roles';

// Stem's transport: a node:http server bound to 127.0.0.1 ONLY. Every client —
// the phone over `tailscale serve`, and since the headless split the desktop
// itself — reaches the server through this file and nothing else.
//
// Binding loopback is the outermost layer of the security model — a Tailscale
// misconfiguration cannot expose this, because nothing but a process on this Mac
// can open the socket at all. `tailscale serve` is what reaches it from the
// phone, and it runs here. Never bind 0.0.0.0.
//
// Four routes:
//   POST /rpc      {channel, args}  → {ok:true, result} | {ok:false, error}
//   GET  /events                    → Server-Sent Events, server → client
//   GET  /channels                  → what this client's role may invoke
//   GET  /*                         → the mobile bundle (dev: proxied to Vite)
//
// SSE rather than a WebSocket on purpose: it is one-directional (which is exactly
// the shape of the push side), it survives a reverse proxy without an upgrade
// dance, browsers reconnect it for free — and node:http can serve it with no new
// dependency, which a WebSocket could not.
//
// Everything security-relevant is injected (authentication, dispatch, the origin
// policy) so this file stays a transport and the tests can drive it end to end
// over a real socket. What a caller may do is never a property of the socket it
// arrived on: it is decided from the ROLE its token resolved to (see roles.ts),
// so the same handler serves the loopback desktop and the tailnet phone.

/** 25 MB: base64-encoded photo attachments ride POST /rpc as startTurn arguments. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Keepalive cadence for idle SSE streams. Comfortably under the 60s idle timeout
 * a reverse proxy typically applies — an idled-out stream would silently stop
 * delivering turns with the phone still showing "connected".
 */
const SSE_KEEPALIVE_MS = 25_000;

/** How long the client should wait before reconnecting a dropped stream. */
const SSE_RETRY_MS = 3_000;

export interface TransportServerOptions {
  /** Loopback port to bind. 0 picks a free one (callers read it back off `port`). */
  port: number;
  /** Absolute directory the production bundle is served from (dist/renderer). */
  rendererDir: string;
  /** ELECTRON_RENDERER_URL in dev: static requests proxy to the Vite server. */
  devUrl?: string | null;
  /**
   * Constant-time bearer check that also answers WHO. Returns the role of the
   * device the token belongs to, or null when nothing matches — so authentication
   * and authorization are decided from one lookup and can never disagree.
   */
  authenticate(presented: string | null): DeviceRole | null | Promise<DeviceRole | null>;
  /** Runs a channel the role is allowed to call — guard.ts's dispatchLocal. */
  dispatch(channel: string, args: unknown[], role: DeviceRole): Promise<unknown>;
  /** Every channel registered on the server, for GET /channels to filter. */
  registeredChannels(): readonly string[];
  /** Host values accepted beyond loopback and the tailnet. */
  extraHosts?: readonly string[];
}

/** One server → client push, already stamped with its place in the stream. */
export interface PushEvent {
  /**
   * Monotonic, per-server-run. Nothing consumes it yet — replay is Phase 2 — but
   * it is on the wire from the first release on purpose: adding it later would be
   * a protocol change across three clients rather than a server-side addition.
   */
  id: number;
  channel: string;
  payload: unknown;
  /**
   * Restrict this event to some roles. Omitted means "every role the channel is
   * pushable to at all". Used for the events a desktop surface has claimed
   * exclusively, which must reach that desktop and no other device.
   */
  roles?: readonly DeviceRole[];
}

export interface TransportServer {
  /** The bound port (resolved, so a `port: 0` caller learns what it got). */
  readonly port: number;
  /** Fan an event out to every connected client its role allows. */
  push(event: PushEvent): void;
  /** Connected SSE clients — diagnostics and tests. */
  clientCount(): number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

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

/** An authenticated SSE subscriber: the response to write to, and who it is. */
interface StreamClient {
  res: ServerResponse;
  role: DeviceRole;
}

export async function startTransportServer(opts: TransportServerOptions): Promise<TransportServer> {
  /** Live SSE responses. A closed client is removed by its own 'close' handler. */
  const clients = new Set<StreamClient>();
  /** Every open socket, so close() can destroy them (see the close() comment). */
  const sockets = new Set<Socket>();

  const originPolicy = (): OriginPolicy => ({ port: boundPort, extraHosts: opts.extraHosts });

  /** Token + origin, the two gates every authenticated route shares. */
  async function gate(
    req: IncomingMessage
  ): Promise<{ role: DeviceRole } | { status: number; error: string }> {
    const role = await opts.authenticate(presentedToken(req.headers, req.url));
    if (!role) return { status: 401, error: 'unauthorized' };
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) return { status: 403, error: origin };
    return { role };
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gated = await gate(req);
    if ('error' in gated) {
      log('transport', 'rejected /rpc', { problem: gated.error });
      sendJson(res, gated.status, { ok: false, error: gated.error });
      return;
    }
    const { role } = gated;

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
    // Least privilege after auth: a valid token does not widen the surface, and
    // what it opens depends entirely on the role behind it (see roles.ts).
    if (!mayInvoke(role, channel)) {
      log('transport', 'rejected /rpc', { channel, role, problem: 'not allowlisted' });
      // A phone was refused by the allowlist. The desktop's surface IS the
      // registry, so the only way it lands here is a channel nothing registered
      // — and that answer has to reach the renderer in the guard's own words,
      // because it is the same failure dispatchLocal would have reported.
      const problem =
        role === 'phone'
          ? { status: 403, error: `channel ${channel} is not available on mobile` }
          : { status: 400, error: `Rejected local call to ${channel}: no handler registered.` };
      sendJson(res, problem.status, { ok: false, error: problem.error });
      return;
    }

    // For a few channels, being allowlisted is not the whole answer: the phone
    // may call them, but not with anything, and not for everything they return
    // (see transport/roles.ts). A refused argument is the caller's fault, so it
    // gets a plain 400 with the policy's own words — it never went near a
    // handler, so it is not a "Rejected local call" and must not be dressed as
    // one by the catch below.
    const policy = channelPolicy(role, channel);
    let callArgs: unknown[] = args;
    if (policy?.args) {
      try {
        callArgs = policy.args(args);
      } catch (e) {
        log('transport', 'rejected /rpc', { channel, problem: 'args policy' });
        sendJson(res, 400, { ok: false, error: String((e as Error)?.message ?? e) });
        return;
      }
    }

    try {
      // dispatch runs the same per-channel argsProblem validation the renderer's
      // IPC gets, then the real handler — so a malformed startTurn is refused
      // here for exactly the reason it would be refused at the desk.
      const result = await opts.dispatch(channel, callArgs, role);
      const shaped = policy?.result ? policy.result(result) : result;
      sendJson(res, 200, { ok: true, result: shaped ?? null });
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
    sendJson(res, 200, { ok: true, result: channelsFor(gated.role, opts.registeredChannels()) });
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
    const client: StreamClient = { res, role: gated.role };
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

  async function handleStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The bundle itself is not token-gated (see auth.ts), but the origin check
    // still applies — a rebound hostname must not even get the client.
    const origin = requestOriginProblem(req.headers, originPolicy());
    if (origin) {
      sendJson(res, 403, { ok: false, error: origin });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request path' });
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request path' });
      return;
    }
    // Traversal guard, checked on the DECODED path so `%2e%2e%2f` is caught too.
    // Rejecting the segments outright (rather than normalizing them away) keeps
    // the refusal explicit and visible in the logs.
    const segments = pathname.split('/').filter((s) => s !== '');
    if (pathname.includes('\0') || segments.some((s) => s === '..' || s === '.')) {
      log('transport', 'rejected static path', { pathname });
      sendJson(res, 403, { ok: false, error: 'forbidden path' });
      return;
    }
    // The phone's entry point. mobile.html is a second rollup entry alongside the
    // desktop index.html; `/` is served as it so the URL a user types is short.
    const rel = segments.length === 0 ? ['mobile.html'] : segments;

    if (opts.devUrl) {
      await proxyToDev(req, res, opts.devUrl, `/${rel.join('/')}${url.search}`);
      return;
    }

    const root = resolve(opts.rendererDir);
    const target = resolve(root, ...rel);
    // Belt and braces: even with the segment check above, never serve a path that
    // isn't inside the bundle directory (symlinks, case-folding surprises).
    if (target !== root && !target.startsWith(root + sep)) {
      sendJson(res, 403, { ok: false, error: 'forbidden path' });
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // The bundle is rebuilt in place on every app update, and the phone caches
      // aggressively once installed to the Home Screen — revalidate every load.
      'cache-control': 'no-cache'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /**
   * Dev only: pass static requests through to the Vite dev server instead of
   * redirecting to it, so the browser's origin stays the tailnet one — a redirect
   * would send the phone to a `localhost` URL it cannot reach, and would break
   * the same-origin assumption /rpc and /events are built on.
   */
  async function proxyToDev(
    req: IncomingMessage,
    res: ServerResponse,
    devUrl: string,
    path: string
  ): Promise<void> {
    try {
      const upstream = await fetch(new URL(path, devUrl), {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: { accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*' }
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      sendJson(res, 502, { ok: false, error: `dev server unreachable: ${String((e as Error)?.message ?? e)}` });
    }
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
            : handleStatic(req, res);
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
    // 127.0.0.1, never 0.0.0.0 — see the module comment.
    server.listen(opts.port, '127.0.0.1');
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
      // Serialized once and only if somebody is entitled to it: a delta frame is
      // built per token, and the phone is not on most channels.
      let text: string | null = null;
      for (const client of clients) {
        // A response can be destroyed between its 'close' event and this loop;
        // writing to it would throw ERR_STREAM_DESTROYED into the event emitter.
        if (client.res.writableEnded || client.res.destroyed) {
          clients.delete(client);
          continue;
        }
        if (event.roles && !event.roles.includes(client.role)) continue;
        if (!mayReceive(client.role, event.channel)) continue;
        text ??= sseFrame(event);
        try {
          client.res.write(text);
        } catch {
          clients.delete(client);
        }
      }
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
