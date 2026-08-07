// The transport itself, driven over a real loopback socket: the bearer token,
// the request-origin (DNS-rebinding) check, the reuse of the IPC arg-spec table,
// the body cap, and SSE framing/fan-out. The handlers under /rpc are registered
// through the real registerServer, so this exercises the same registry the app
// uses.
//
// This file began as the phone's half of the wire, back when a curated allowlist
// and a per-channel args/result policy sat between a token and the registry.
// Those went with the phone role; what they were layered on top of did not, and
// it is what is checked here. transport.test.ts drives the same server from the
// desktop proxy's side, i.e. through the real client.
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipcMain } from '../electron-stub';
import { registerServer } from '../../src/server/ipc';
import { dispatchLocal, serverChannels } from '../../src/server/ipc/guard';
import { requestOriginProblem, tokenEquals } from '../../src/server/transport/auth';
import { startTransportServer, type TransportServer } from '../../src/server/transport/server';

const TOKEN = 'a'.repeat(64);

let server: TransportServer;
let base: string;
/** Channels the fake handlers saw, so we can prove a rejected call never lands. */
const calls: { channel: string; args: unknown[] }[] = [];

beforeAll(async () => {
  registerServer('backend:startTurn', (_e, input) => {
    calls.push({ channel: 'backend:startTurn', args: [input] });
    return { threadId: 't-1', turnId: 'turn-1' };
  });
  registerServer('memory:forget', (_e, id) => {
    calls.push({ channel: 'memory:forget', args: [id] });
    return true;
  });
  registerServer('chats:list', () => {
    calls.push({ channel: 'chats:list', args: [] });
    throw new Error('pi is not running');
  });
  server = await startTransportServer({
    port: 0,
    authenticate: (presented) => (tokenEquals(TOKEN, presented) ? 'device' : null),
    dispatch: dispatchLocal,
    registeredChannels: serverChannels
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  ipcMain.removeHandler('backend:startTurn');
  ipcMain.removeHandler('memory:forget');
  ipcMain.removeHandler('chats:list');
});

/**
 * A request node:http sends verbatim. `fetch` normalizes the path (`/../x` →
 * `/x`) and refuses to let a caller set Host, so the two things the origin check
 * and the traversal guard actually defend against are unreachable through it.
 */
function raw(
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: body === undefined ? 'GET' : 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolveRaw({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('error', rejectRaw);
    req.end(body);
  });
}

function rpc(body: unknown, init: { token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return fetch(`${base}/rpc`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /rpc auth', () => {
  it('rejects an absent or wrong token and accepts the right one', async () => {
    const before = calls.length;

    const anonymous = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: null });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ ok: false, error: 'unauthorized' });

    const wrong = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: 'b'.repeat(64) });
    expect(wrong.status).toBe(401);

    // A token of a different length must be refused, not throw out of
    // timingSafeEqual (which rejects mismatched lengths).
    const short = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] }, { token: 'abc' });
    expect(short.status).toBe(401);

    expect(calls.length).toBe(before); // no rejected call reached a handler

    const ok = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi' }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, result: { threadId: 't-1', turnId: 'turn-1' } });
    expect(calls.at(-1)).toEqual({ channel: 'backend:startTurn', args: [{ input: 'hi' }] });
  });

  it('does not accept the token as a query parameter', async () => {
    // It used to, because the phone's EventSource could not set headers. Nothing
    // needs it now, and a credential in a URL is a credential in an access log
    // the moment a reverse proxy is put in front — so the query form is refused
    // rather than merely unused.
    const res = await fetch(`${base}/rpc?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'chats:list', args: [] })
    });
    expect(res.status).toBe(401);

    const stream = await fetch(`${base}/events?token=${TOKEN}`);
    expect(stream.status).toBe(401);
    await stream.body?.cancel();
  });
});

describe('request-origin check', () => {
  it('refuses a cross-origin caller even with a valid token', async () => {
    const before = calls.length;
    const res = await rpc(
      { channel: 'backend:startTurn', args: [{ input: 'hi' }] },
      { headers: { origin: 'https://evil.example' } }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/does not match Host/);
    expect(calls.length).toBe(before);
  });

  it('refuses a cross-site fetch and a rebound hostname', async () => {
    const site = await rpc(
      { channel: 'backend:startTurn', args: [{ input: 'hi' }] },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    );
    expect(site.status).toBe(403);

    // The DNS-rebinding shape: the socket is ours, the Host header is not — and
    // Origin agrees with Host, which is exactly why Host is what gets checked.
    const before = calls.length;
    const rebound = await raw(
      '/rpc',
      {
        host: 'rebound.example',
        origin: 'http://rebound.example',
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      JSON.stringify({ channel: 'backend:startTurn', args: [{ input: 'hi' }] })
    );
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error).toMatch(/unexpected Host/);
    expect(calls.length).toBe(before);
  });

  it('accepts our own client, loopback and tailnet alike', () => {
    const policy = { port: 8823 };
    expect(requestOriginProblem({ host: '127.0.0.1:8823' }, policy)).toBeNull();
    expect(
      requestOriginProblem(
        { host: '127.0.0.1:8823', origin: 'http://127.0.0.1:8823', 'sec-fetch-site': 'same-origin' },
        policy
      )
    ).toBeNull();
    expect(
      requestOriginProblem({ host: 'mac.tail1234.ts.net', origin: 'https://mac.tail1234.ts.net' }, policy)
    ).toBeNull();
    // Right socket, wrong port in the Host header — not a URL we ever serve.
    expect(requestOriginProblem({ host: '127.0.0.1:9999' }, policy)).toMatch(/unexpected Host/);
    expect(requestOriginProblem({}, policy)).toBe('missing Host header');
    expect(requestOriginProblem({ host: '127.0.0.1:8823', origin: 'null' }, policy)).toBe('opaque Origin');
  });
});

describe('the registry as the surface', () => {
  it('refuses a channel nothing registered, in the guard\'s own words', async () => {
    const before = calls.length;
    const res = await rpc({ channel: 'nope:notAThing', args: [] });
    // 400, not 403: an unregistered channel is a caller mistake, and the answer
    // has to reach the renderer in the words dispatchLocal would have used —
    // which is why there is no pre-check here reproducing them by hand.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Rejected local call to nope:notAThing: no handler registered/);
    expect(calls.length).toBe(before);
  });

  it('reaches a registered handler with no allowlist in the way', async () => {
    // memory:forget is destructive and used to be refused for the phone. With one
    // role, being registered is the whole permission story.
    const res = await rpc({ channel: 'memory:forget', args: [7] });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ channel: 'memory:forget', args: [7] });
  });

  it('tells a client what it may call: the registry, whole', async () => {
    const res = await fetch(`${base}/channels`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: string[] };
    expect(result).toContain('backend:startTurn');
    expect(result).toContain('memory:forget');
    expect(result).toEqual([...serverChannels()]);
    // …and it is still behind the token.
    expect((await fetch(`${base}/channels`)).status).toBe(401);
  });
});

describe('argument validation', () => {
  it('reuses the IPC arg-spec table to reject a malformed backend:startTurn', async () => {
    const before = calls.length;
    for (const args of [['not-an-object'], [], [{ input: 'hi' }, 'extra']]) {
      const res = await rpc({ channel: 'backend:startTurn', args });
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    }
    expect(calls.length).toBe(before);
  });

  it('rejects a body that is not {channel, args}', async () => {
    expect((await rpc({ channel: 42, args: [] })).status).toBe(400);
    expect((await rpc({ channel: 'backend:startTurn', args: 'nope' })).status).toBe(400);
    const notJson = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{'
    });
    expect(notJson.status).toBe(400);
  });

  it('reports a handler failure as a 500, distinct from a rejected call', async () => {
    const res = await rpc({ channel: 'chats:list', args: [] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'pi is not running' });
  });
});

describe('routes', () => {
  it('serves no files: anything that is not /rpc, /events or /channels is a 404', async () => {
    // This server used to serve the phone's bundle out of dist/renderer, with a
    // traversal guard behind it. Both are gone; every client loads its own UI off
    // its own disk. The traversal cases are kept as a regression: if a static
    // route ever comes back, it must not come back by accident.
    for (const path of ['/', '/mobile.html', '/app.js', '/manifest.webmanifest', '/icons/stem-192.png']) {
      const res = await fetch(`${base}${path}`);
      expect(`${path}: ${res.status}`).toBe(`${path}: 404`);
    }
    for (const path of ['/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/../package.json']) {
      const res = await raw(path);
      expect(res.status).toBe(404);
      expect(res.body).not.toMatch(/"name": "stem"/);
    }
  });
});

/** A parsed SSE block: the `id:` line the server stamps, plus its `data:` JSON. */
interface Frame {
  id: string | null;
  channel: string;
  payload: unknown;
}

/** Read SSE frames off a live stream until `count` data events have arrived. */
async function collectFrames(res: Response, count: number): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const lines = block.split('\n');
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      const id = lines.find((line) => line.startsWith('id: '))?.slice(4) ?? null;
      if (data) frames.push({ id, ...(JSON.parse(data) as { channel: string; payload: unknown }) });
      split = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

describe('GET /events', () => {
  it('requires the token', async () => {
    const res = await fetch(`${base}/events`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('frames pushes as one-line JSON data events and fans out to every client', async () => {
    const a = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const b = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(a.headers.get('cache-control')).toMatch(/no-cache/);

    // Both streams have to be registered before the push, and registration
    // happens as the response headers are written — which we've now seen.
    expect(server.clientCount()).toBe(2);

    const collected = Promise.all([collectFrames(a, 2), collectFrames(b, 2)]);
    // A payload with a newline and a quote: it must survive as one `data:` line.
    server.push({
      id: 1,
      channel: 'backend:event',
      payload: { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } }
    });
    server.push({ id: 2, channel: 'mcp:status', payload: { servers: [] } });

    const [fromA, fromB] = await collected;
    expect(fromA).toEqual([
      {
        id: '1',
        channel: 'backend:event',
        payload: { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } }
      },
      { id: '2', channel: 'mcp:status', payload: { servers: [] } }
    ]);
    expect(fromB).toEqual(fromA);
  });

  it('stamps every frame with the id the caller gave it', async () => {
    // Nothing consumes the id yet — replay is Phase 2 — but it has to be on the
    // wire from the start, or adding replay later is a protocol change across
    // every client instead of a server-side addition. Ids come from the caller,
    // not from the fan-out, so the sequence is the caller's to keep monotonic.
    const stream = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const collected = collectFrames(stream, 2);
    server.push({ id: 42, channel: 'mcp:status', payload: { servers: [] } });
    server.push({ id: 43, channel: 'backend:event', payload: { method: 'turn/completed' } });
    expect((await collected).map((f) => f.id)).toEqual(['42', '43']);
  });

  it('drops a disconnected client instead of writing to a dead response', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal
    });
    expect(res.status).toBe(200);
    controller.abort();
    // Give the server's 'close' handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(() => server.push({ id: 4, channel: 'backend:event', payload: { method: 'turn/completed' } })).not.toThrow();
    expect(server.clientCount()).toBe(0);
  });
});

describe('body cap', () => {
  it('refuses an over-sized body on the declared length, before any of it arrives', async () => {
    const before = calls.length;
    const res = await raw(
      '/rpc',
      {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        // 26 MB declared; one byte actually sent. The answer must come back
        // anyway — nothing is buffered waiting for a body we already refused.
        'content-length': String(26 * 1024 * 1024)
      },
      '{'
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'request body too large' });
    expect(calls.length).toBe(before);
  });

  it('refuses an over-sized chunked body mid-stream', async () => {
    const before = calls.length;
    const chunk = 'x'.repeat(1024 * 1024);
    const res = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/rpc',
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        },
        (r) => {
          r.resume();
          resolveStatus(r.statusCode ?? 0);
        }
      );
      req.on('error', rejectStatus);
      // No Content-Length to pre-check: the cap has to bite on the wire.
      const pump = (sent: number): void => {
        if (sent > 26 * 1024 * 1024) {
          req.end();
          return;
        }
        if (req.write(chunk)) setImmediate(() => pump(sent + chunk.length));
        else req.once('drain', () => pump(sent + chunk.length));
      };
      pump(0);
    }).catch(() => 413); // a destroyed request is the same refusal, seen from the client
    expect(res).toBe(413);
    expect(calls.length).toBe(before);
  });
});

describe('close()', () => {
  it('resolves with an SSE stream still open', async () => {
    const other = await startTransportServer({
      port: 0,
      authenticate: () => 'device',
      dispatch: dispatchLocal,
      registeredChannels: serverChannels
    });
    const res = await fetch(`http://127.0.0.1:${other.port}/events`, {
      headers: { authorization: 'Bearer anything' }
    });
    expect(other.clientCount()).toBe(1);
    // Would hang forever without destroying the socket first.
    await other.close();
    await res.body?.cancel().catch(() => undefined);
  });
});
