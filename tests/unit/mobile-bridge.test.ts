// The phone bridge's main-side transport, driven over a real loopback socket:
// the bearer token, the request-origin (DNS-rebinding) check, the channel
// allowlist, the per-channel args/result policy, the reuse of the IPC arg-spec
// table, the static handler's traversal guard, and SSE framing/fan-out. The
// handlers under /rpc are registered through the real handleIpc, so this
// exercises the same registry the app uses.
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipcMain } from '../electron-stub';
import { handleIpc } from '../../src/main/ipc';
import { dispatchLocal } from '../../src/main/ipc/guard';
import { ensureMobileToken, requestOriginProblem, rerollMobileToken, tokenEquals } from '../../src/main/mobile/auth';
import { isMobileInvocable, isMobilePushable } from '../../src/main/mobile/channels';
import { startMobileServer, type MobileServer } from '../../src/main/mobile/server';
import type { AppSettings } from '../../src/shared/types';

const TOKEN = 'a'.repeat(64);

/**
 * The four secrets settings.json can hold, in a form no other field could
 * produce — so "does the phone's answer contain this string" is a real question
 * about the serialized response, not about the shape we happened to assert on.
 */
const SECRETS = ['brave-key-SECRET', 'embed-key-SECRET', 'rerank-key-SECRET', 'custom-key-SECRET'];

let server: MobileServer;
let bundleDir: string;
let base: string;
/** Channels the fake handlers saw, so we can prove a rejected call never lands. */
const calls: { channel: string; args: unknown[] }[] = [];

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'stem-mobile-bundle-'));
  await writeFile(join(bundleDir, 'mobile.html'), '<!doctype html><title>Stem</title>', 'utf8');
  await writeFile(join(bundleDir, 'app.js'), 'export const x = 1;\n', 'utf8');
  // The PWA's installability assets, laid out as the real bundle has them.
  await writeFile(join(bundleDir, 'manifest.webmanifest'), '{"name":"Stem"}', 'utf8');
  await mkdir(join(bundleDir, 'icons'), { recursive: true });
  await writeFile(join(bundleDir, 'icons', 'stem-192.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

  handleIpc('backend:startTurn', (_e, input) => {
    calls.push({ channel: 'backend:startTurn', args: [input] });
    return { threadId: 't-1', turnId: 'turn-1' };
  });
  handleIpc('memory:forget', (_e, id) => {
    calls.push({ channel: 'memory:forget', args: [id] });
    return true;
  });
  handleIpc('chats:list', () => {
    calls.push({ channel: 'chats:list', args: [] });
    throw new Error('pi is not running');
  });
  // A settings object with every secret field populated, as the real handler
  // would return it: readSettings() does no redaction of its own.
  handleIpc('settings:get', () => {
    calls.push({ channel: 'settings:get', args: [] });
    return {
      customInstructions: { main: 'be brief', quickChat: '' },
      webSearch: { main: true, quickChat: true, provider: 'brave', credentials: { braveApiKey: SECRETS[0] } },
      retrieval: {
        embeddings: { mode: 'remote', baseUrl: 'http://box:11434', model: 'e', apiKey: SECRETS[1] },
        reranker: { mode: 'remote', baseUrl: 'http://box:8080', model: 'r', apiKey: SECRETS[2] }
      },
      localProviders: { custom: { enabled: true, baseUrl: 'https://gw.example/v1', apiKey: SECRETS[3] } }
    };
  });

  server = await startMobileServer({
    port: 0,
    rendererDir: bundleDir,
    verifyToken: (presented) => tokenEquals(TOKEN, presented),
    dispatch: dispatchLocal
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  ipcMain.removeHandler('backend:startTurn');
  ipcMain.removeHandler('memory:forget');
  ipcMain.removeHandler('chats:list');
  ipcMain.removeHandler('settings:get');
  await rm(bundleDir, { recursive: true, force: true });
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

  it('accepts the token as a query parameter (EventSource cannot set headers)', async () => {
    const res = await fetch(`${base}/rpc?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'memory:activeFacts', args: [] })
    });
    // memory:activeFacts is allowlisted but has no handler registered in this
    // test — proof the token gate passed and we got all the way to dispatch.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no handler registered/);
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

describe('channel allowlist', () => {
  it('rejects a non-allowlisted channel even with a valid token', async () => {
    const before = calls.length;
    // memory:forget IS a real, registered handler — it is simply not something a
    // phone may do. That is the whole point of the layer.
    const res = await rpc({ channel: 'memory:forget', args: [7] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/memory:forget is not available on mobile/);
    expect(calls.length).toBe(before);
  });

  it('agrees with the exported predicates', () => {
    expect(isMobileInvocable('backend:startTurn')).toBe(true);
    expect(isMobileInvocable('memory:forget')).toBe(false);
    expect(isMobileInvocable('settings:updateMobile')).toBe(false);
    expect(isMobileInvocable('mcp:add')).toBe(false);
    expect(isMobilePushable('backend:event')).toBe(true);
    expect(isMobilePushable('quickchat:focus')).toBe(false);
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

describe('per-channel policy', () => {
  it('refuses a path attachment before it can reach the file-reading resolver', async () => {
    const before = calls.length;
    const res = await rpc({
      channel: 'backend:startTurn',
      args: [{ input: 'summarise this', attachments: [{ name: 'hosts', path: '/etc/hosts' }] }]
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/attachments must be inline/);
    expect(calls.length).toBe(before);
  });

  it('passes an inline attachment through untouched', async () => {
    const attachment = { name: 'x.txt', dataBase64: 'aGk=' };
    const res = await rpc({ channel: 'backend:startTurn', args: [{ input: 'hi', attachments: [attachment] }] });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ channel: 'backend:startTurn', args: [{ input: 'hi', attachments: [attachment] }] });
  });

  it('drops a forged scheduled-run marker without failing the turn', async () => {
    const res = await rpc({
      channel: 'backend:startTurn',
      args: [{ input: 'hi', scheduled: { at: '2026-07-30T09:00:00.000Z', taskId: 'task-1' } }]
    });
    expect(res.status).toBe(200);
    // The turn runs — it is a perfectly good interactive turn — but the
    // scheduler's provenance marker is gone, not merely emptied.
    expect(calls.at(-1)).toEqual({ channel: 'backend:startTurn', args: [{ input: 'hi' }] });
    expect('scheduled' in (calls.at(-1)!.args[0] as object)).toBe(false);
  });

  it('does not expose files:preview to a phone at all', async () => {
    const before = calls.length;
    const res = await rpc({ channel: 'files:preview', args: ['/Users/someone/Desktop/private.png'] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/files:preview is not available on mobile/);
    expect(calls.length).toBe(before);
  });

  it('projects settings:get down to what the phone renders, secrets stripped', async () => {
    const res = await rpc({ channel: 'settings:get', args: [] });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The bytes on the wire, not the shape we chose to assert on.
    for (const secret of SECRETS) expect(text).not.toContain(secret);

    const { result } = JSON.parse(text) as { result: AppSettings };
    expect(result.customInstructions).toEqual({ main: 'be brief', quickChat: '' });
    // Everything else is a default, because the projection rebuilds rather than
    // deletes — including the fields that carried the four keys.
    expect(result.webSearch).toEqual({ main: true, quickChat: true, provider: 'auto', credentials: {} });
    expect(result.retrieval.embeddings.apiKey).toBeNull();
    expect(result.retrieval.reranker.apiKey).toBeNull();
    expect(result.localProviders.custom).toEqual({ enabled: false, baseUrl: '' });
  });
});

describe('static handler', () => {
  it('serves the bundle and 404s cleanly for a file that does not exist yet', async () => {
    const html = await fetch(`${base}/mobile.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toMatch(/text\/html/);
    expect(await html.text()).toMatch(/<title>Stem<\/title>/);

    // `/` is the phone's entry point.
    expect((await fetch(`${base}/`)).status).toBe(200);

    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get('content-type')).toMatch(/text\/javascript/);

    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
  });

  it('serves the PWA manifest and icons with the types a browser needs', async () => {
    // The manifest must arrive as application/manifest+json: a browser that gets
    // it as text/plain or octet-stream ignores it, and the app silently stops
    // being installable — with nothing visibly broken.
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(await manifest.json()).toEqual({ name: 'Stem' });

    const icon = await fetch(`${base}/icons/stem-192.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
  });

  it('serves the manifest and icons with no token at all', async () => {
    // The browser fetches the manifest and the apple-touch-icon outside the
    // app's auth context, so these cannot be token-gated (see mobile/auth.ts).
    // Nothing here is a secret; every capability behind the bundle is.
    for (const path of ['/mobile.html', '/manifest.webmanifest', '/icons/stem-192.png']) {
      expect((await fetch(`${base}${path}`)).status).toBe(200);
    }
    // …but a bad Origin still doesn't get them.
    const rebound = await raw('/manifest.webmanifest', { host: 'evil.example', 'sec-fetch-site': 'none' });
    expect(rebound.status).toBe(403);
  });

  it('rejects path traversal, encoded or not', async () => {
    // An encoded slash keeps the `..` intact through URL parsing, so it reaches
    // — and is refused by — the segment guard.
    for (const path of ['/..%2fpackage.json', '/assets%2f..%2f..%2fpackage.json', '/%2e%2e%2fpackage.json']) {
      const res = await raw(path);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toBe('forbidden path');
    }
    // The plain forms are collapsed to a root-relative path by URL parsing before
    // we ever see them, so they land inside the bundle dir and 404. Either way
    // nothing outside rendererDir is ever served.
    for (const path of ['/../package.json', '/assets/../../package.json', '/%2e%2e/package.json', '/./../package.json']) {
      const res = await raw(path);
      expect([403, 404]).toContain(res.status);
      expect(res.body).not.toMatch(/"name": "stem"/);
    }
  });

  it('does not require a token (the token rides the URL fragment)', async () => {
    const res = await fetch(`${base}/mobile.html`);
    expect(res.status).toBe(200);
  });
});

/** Read SSE frames off a live stream until `count` data events have arrived. */
async function collectFrames(
  res: Response,
  count: number
): Promise<{ channel: string; payload: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { channel: string; payload: unknown }[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (data) frames.push(JSON.parse(data));
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
    const a = await fetch(`${base}/events?token=${TOKEN}`);
    const b = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(a.headers.get('cache-control')).toMatch(/no-cache/);

    // Both streams have to be registered before the push, and registration
    // happens as the response headers are written — which we've now seen.
    expect(server.clientCount()).toBe(2);

    const collected = Promise.all([collectFrames(a, 2), collectFrames(b, 2)]);
    // A payload with a newline and a quote: it must survive as one `data:` line.
    server.push('backend:event', { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } });
    server.push('mcp:status', { servers: [] });
    // Not on the push allowlist — must never reach a phone.
    server.push('quickchat:focus', { reset: true });

    const [fromA, fromB] = await collected;
    expect(fromA).toEqual([
      { channel: 'backend:event', payload: { method: 'item/agentMessage/delta', params: { delta: 'line one\nline "two"' } } },
      { channel: 'mcp:status', payload: { servers: [] } }
    ]);
    expect(fromB).toEqual(fromA);
    expect(fromA.some((f) => f.channel === 'quickchat:focus')).toBe(false);
  });

  it('drops a disconnected client instead of writing to a dead response', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events?token=${TOKEN}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    // Give the server's 'close' handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(() => server.push('backend:event', { method: 'turn/completed' })).not.toThrow();
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

describe('token file', () => {
  it('mints a stable 32-byte hex token and re-rolls it on demand', async () => {
    const first = await ensureMobileToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureMobileToken()).toBe(first);

    const rolled = await rerollMobileToken();
    expect(rolled).toMatch(/^[0-9a-f]{64}$/);
    expect(rolled).not.toBe(first);
    expect(await ensureMobileToken()).toBe(rolled);

    expect(tokenEquals(rolled, rolled)).toBe(true);
    expect(tokenEquals(rolled, first)).toBe(false);
    expect(tokenEquals(rolled, null)).toBe(false);
    expect(tokenEquals(rolled, rolled.slice(0, 10))).toBe(false);
  });
});

describe('close()', () => {
  it('resolves with an SSE stream still open', async () => {
    const other = await startMobileServer({
      port: 0,
      rendererDir: bundleDir,
      verifyToken: () => true,
      dispatch: dispatchLocal
    });
    const res = await fetch(`http://127.0.0.1:${other.port}/events?token=x`);
    expect(other.clientCount()).toBe(1);
    // Would hang forever without destroying the socket first.
    await other.close();
    await res.body?.cancel().catch(() => undefined);
  });
});
