// The OAuth callback courier, both halves.
//
// The bug it exists for cannot be reproduced on one machine: a sign-in started
// on a server elsewhere ends with the user's browser fetching 127.0.0.1, which
// is the laptop, while the flow that is waiting for it is in a data centre. What
// CAN be reproduced is every mechanism the fix is made of — parsing the address
// out of the authorization URL, binding it, catching exactly one browser,
// refusing everything else, and replaying what was caught to a listener that
// believes it was called by a browser.
//
// So the two halves are driven over real sockets, with real HTTP between them,
// and the seam where a laptop and a VPS would be is the one thing simulated. The
// join test below says where that seam is and what it costs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOAuthCourier, type OAuthCourier } from '../../src/desktop/oauth-courier';
import {
  expectCallback,
  forgetExpectedCallbacks,
  relayCallback
} from '../../src/server/pi/oauth-courier';
import { isLoopbackHost, loopbackFlow, loopbackRedirectUri } from '../../src/shared/oauth-redirect';

/** The shapes the real providers use, so the parser is tested against life. */
const ANTHROPIC = (port: number, state = 'anthropic-state') =>
  `https://claude.ai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=${encodeURIComponent(
    `http://localhost:${port}/callback`
  )}&scope=user%3Aprofile&state=${state}`;
const CODEX = (port: number, state = 'codex-state') =>
  `https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(
    `http://localhost:${port}/auth/callback`
  )}&state=${state}`;
const MCP = (port: number, state = 'mcp-state') =>
  `https://mcp.example.test/authorize?response_type=code&redirect_uri=${encodeURIComponent(
    `http://127.0.0.1:${port}/callback`
  )}&state=${state}`;

/** A port nothing is on. Ephemeral, so the window between here and bind is tiny. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Stand in for the browser, retrying until the courier's listener is up. */
async function visit(url: string, tries = 50): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { redirect: 'manual' });
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** A request with a Host header of our choosing — what a rebinding attack sends. */
function visitAs(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

interface Harness {
  courier: OAuthCourier;
  /** URLs handed to the browser. */
  opened: string[];
  /** What was delivered to the server, in order. */
  delivered: { redirectUri: string; params: Record<string, string> }[];
}

function harness(
  enabled = true,
  deliver?: (redirectUri: string, params: Record<string, string>) => Promise<unknown>
): Harness {
  const opened: string[] = [];
  const delivered: { redirectUri: string; params: Record<string, string> }[] = [];
  const courier = createOAuthCourier({
    enabled,
    openExternal: (url) => opened.push(url),
    deliver: (redirectUri, params) => {
      delivered.push({ redirectUri, params });
      return deliver ? deliver(redirectUri, params) : Promise.resolve({ ok: true });
    }
  });
  return { courier, opened, delivered };
}

/** Wait for something the courier does off the request handler (the delivery). */
async function settle(check: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; !check(); i++) {
    if (i >= tries) throw new Error('the courier never got there');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let open: OAuthCourier[] = [];
let listeners: Server[] = [];

function track(courier: OAuthCourier): OAuthCourier {
  open.push(courier);
  return courier;
}

afterEach(async () => {
  for (const courier of open.splice(0)) courier.close();
  for (const server of listeners.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  forgetExpectedCallbacks();
  vi.useRealTimers();
});

describe('reading the callback address out of an authorization URL', () => {
  it('finds the loopback redirect the real providers announce', () => {
    // The whole reason the courier needs no table of ports: every one of these
    // says where it is listening, in the URL it asks the user to visit.
    expect(loopbackFlow(ANTHROPIC(53692))).toEqual({
      // `localhost` and 127.0.0.1 must be one address, or the client would bind
      // one and the server would replay to the other.
      host: '127.0.0.1',
      port: 53692,
      path: '/callback',
      redirectUri: 'http://localhost:53692/callback',
      state: 'anthropic-state'
    });
    expect(loopbackFlow(CODEX(1455))).toMatchObject({ port: 1455, path: '/auth/callback' });
    expect(loopbackFlow(MCP(41759))).toMatchObject({ host: '127.0.0.1', port: 41759, path: '/callback' });
    expect(loopbackFlow(`https://p.test/a?redirect_uri=${encodeURIComponent('http://[::1]:7/cb')}`)).toMatchObject({
      host: '::1',
      port: 7
    });
  });

  it('finds nothing in the flows that never wanted a callback', () => {
    // A device-code flow (xAI) has no redirect at all, and a provider that hosts
    // its own redirect is completing the sign-in without anybody's loopback.
    expect(loopbackFlow('https://x.ai/device?user_code=ABCD-EFGH')).toBeNull();
    expect(loopbackFlow(`https://p.test/a?redirect_uri=${encodeURIComponent('https://p.test/cb')}`)).toBeNull();
    // An https loopback redirect is not something either half could serve.
    expect(loopbackFlow(`https://p.test/a?redirect_uri=${encodeURIComponent('https://127.0.0.1:9/cb')}`)).toBeNull();
    expect(loopbackFlow('not a url at all')).toBeNull();
    expect(loopbackRedirectUri('http://192.168.1.4:8080/cb')).toBeNull();
  });

  it('knows which Host headers name this machine', () => {
    expect(isLoopbackHost('127.0.0.1:53692')).toBe(true);
    expect(isLoopbackHost('localhost:1455')).toBe(true);
    expect(isLoopbackHost('[::1]:1455')).toBe(true);
    expect(isLoopbackHost('stem.example.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('the client half', () => {
  it('binds the announced port, catches one callback and hands it to the server', async () => {
    const port = await freePort();
    const { courier, opened, delivered } = harness();
    track(courier);

    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));
    // Nobody else will: a headless server's openExternal is a no-op.
    expect(opened).toEqual([ANTHROPIC(port)]);

    const res = await visit(`http://127.0.0.1:${port}/callback?code=the-code&state=anthropic-state`);
    expect(res.status).toBe(200);
    // The same page the server's own listener serves, so a user cannot tell
    // which machine caught their browser.
    expect(await res.text()).toContain('You can close this tab');

    await settle(() => delivered.length === 1);
    expect(delivered[0]).toEqual({
      // The redirect verbatim, because that is what the server matched its own
      // record against — not a re-serialized equivalent of it.
      redirectUri: `http://localhost:${port}/callback`,
      params: { code: 'the-code', state: 'anthropic-state' }
    });

    // One callback, then the port goes back. A second browser finds nothing.
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=again&state=anthropic-state`)).rejects.toThrow();
    expect(delivered).toHaveLength(1);
  });

  it('forwards whatever the provider sent, not just code and state', async () => {
    const port = await freePort();
    const { courier, delivered } = harness();
    track(courier);
    courier.expectSignIn();
    courier.offer(MCP(port));

    await visit(`http://127.0.0.1:${port}/callback?code=c&state=mcp-state&scope=read+write&iss=https%3A%2F%2Fp`);
    await settle(() => delivered.length === 1);
    // The listener on the other end is pi's, not ours: trimming the query to the
    // fields we know about would be guessing at somebody else's protocol.
    expect(delivered[0].params).toEqual({
      code: 'c',
      state: 'mcp-state',
      scope: 'read write',
      iss: 'https://p'
    });
  });

  it('refuses a callback with the wrong state, and keeps waiting for the right one', async () => {
    const port = await freePort();
    const { courier, delivered } = harness();
    track(courier);
    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));

    // A page in the user's own browser can make this request. It cannot read the
    // answer — but if the code were accepted, Stem would be signed into an
    // account that page chose.
    const forged = await visit(`http://127.0.0.1:${port}/callback?code=attacker&state=guess`);
    expect(forged.status).toBe(400);
    expect(delivered).toHaveLength(0);

    // And the flow is still alive: one wrong guess must not cancel a sign-in the
    // user is halfway through.
    const wrongPath = await visit(`http://127.0.0.1:${port}/elsewhere?code=x`);
    expect(wrongPath.status).toBe(404);
    // Nor may a request that reached the port under another name — the browser
    // we are waiting for arrives at the address the redirect named.
    expect(await visitAs('evil.example.test', port, '/callback?code=x&state=anthropic-state')).toBe(404);

    await visit(`http://127.0.0.1:${port}/callback?code=real&state=anthropic-state`);
    await settle(() => delivered.length === 1);
    expect(delivered[0].params.code).toBe('real');
  });

  it('does nothing at all when the server is this machine', async () => {
    const port = await freePort();
    const { courier, opened } = harness(false);
    track(courier);

    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));

    // No tab (the embedded server opened one already) and no listener racing the
    // flow for the port it is sitting on.
    expect(opened).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=x`)).rejects.toThrow();
  });

  it('ignores an authorization URL nobody here asked for', async () => {
    const port = await freePort();
    const { courier, opened } = harness();
    track(courier);

    // The push stream is a broadcast: this is another paired device's sign-in.
    courier.offer(ANTHROPIC(port));
    expect(opened).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=x`)).rejects.toThrow();

    // And one URL per request — a second one is not covered by the first ask.
    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));
    courier.offer(CODEX(port));
    expect(opened).toEqual([ANTHROPIC(port)]);
  });

  it('opens the browser anyway when the port is already taken', async () => {
    const port = await freePort();
    const squatter = createServer((_req, res) => res.writeHead(204).end());
    listeners.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));

    const { courier, opened } = harness();
    track(courier);
    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));

    // The interesting case is a "remote" server that is in fact another process
    // on this machine: the flow bound that port before it announced the URL, so
    // it is the flow's own listener that answers and the sign-in completes
    // without us. Losing the race must therefore be quiet — and the browser must
    // still open, or a genuinely remote sign-in would have nothing to show for
    // itself at all.
    expect(opened).toEqual([ANTHROPIC(port)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=anthropic-state`);
    expect(res.status).toBe(204);
  });

  it('gives the port back when the browser never arrives', async () => {
    vi.useFakeTimers();
    const port = await freePort();
    const { courier } = harness();
    track(courier);
    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));
    // listen() resolves on the event loop, which fake timers do not stop.
    await vi.advanceTimersByTimeAsync(50);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    vi.useRealTimers();
    // An abandoned sign-in must not leave a socket on the user's machine that
    // accepts codes for the rest of the session.
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=x&state=anthropic-state`)).rejects.toThrow();
  });
});

describe('the server half', () => {
  /** Stand in for the flow's own listener — pi's, or the MCP flow's. */
  async function waitingFlow(port: number, path = '/callback'): Promise<() => string | null> {
    let caught: string | null = null;
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith(path)) caught = req.url ?? null;
      res.writeHead(200).end('ok');
    });
    listeners.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    return () => caught;
  }

  it('replays a couriered callback to the flow that is waiting for it', async () => {
    const port = await freePort();
    const caught = await waitingFlow(port);

    expectCallback(ANTHROPIC(port));
    await relayCallback(`http://localhost:${port}/callback`, {
      code: 'the-code',
      state: 'anthropic-state'
    });

    // pi cannot tell this from a browser: same address, same query, same socket
    // it has been holding open since it announced the URL.
    expect(caught()).toBe('/callback?code=the-code&state=anthropic-state');
  });

  it('refuses a callback no sign-in is waiting for', async () => {
    const port = await freePort();
    await waitingFlow(port);

    // Nothing announced this address, so nothing may make the server fetch it.
    // Without this the channel would be a way for any paired device to have the
    // server issue loopback requests of its choosing.
    await expect(relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x' })).rejects.toThrow(
      /no sign-in/
    );
    // Nor may it reach off this machine, whatever the registry says.
    await expect(relayCallback('http://192.168.1.9:80/callback', { code: 'x' })).rejects.toThrow(
      /not a loopback/
    );
  });

  it('refuses a callback that belongs to a different sign-in, and is spent once', async () => {
    const port = await freePort();
    const caught = await waitingFlow(port);
    expectCallback(MCP(port));

    await expect(
      relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x', state: 'not-it' })
    ).rejects.toThrow(/does not match/);
    expect(caught()).toBeNull();

    await relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x', state: 'mcp-state' });
    expect(caught()).toContain('code=x');

    // Single use, like the pairing codes: a callback that survived being spent
    // is one a second delivery could race for.
    await expect(
      relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x', state: 'mcp-state' })
    ).rejects.toThrow(/no sign-in/);
  });

  it('says so when the flow is no longer listening', async () => {
    const port = await freePort();
    expectCallback(MCP(port));
    // Cancelled, timed out, or the server was restarted under it.
    await expect(
      relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x', state: 'mcp-state' })
    ).rejects.toThrow(/did not answer/);
  });

  it('will not carry an absurd amount of query', async () => {
    const port = await freePort();
    await waitingFlow(port);
    expectCallback(MCP(port));
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, 'v']));
    await expect(relayCallback(`http://127.0.0.1:${port}/callback`, many)).rejects.toThrow(/too many/);

    expectCallback(MCP(port));
    await expect(
      relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'c'.repeat(5000), state: 'mcp-state' })
    ).rejects.toThrow(/too long/);
  });

  it('only ever registers a loopback redirect', async () => {
    const port = await freePort();
    await waitingFlow(port);
    // A provider-hosted redirect is nobody's loopback, so it is not recorded —
    // and a delivery naming it is therefore refused on the way in.
    expectCallback(`https://p.test/a?redirect_uri=${encodeURIComponent('https://p.test/cb')}`);
    await expect(relayCallback(`http://127.0.0.1:${port}/callback`, { code: 'x' })).rejects.toThrow(
      /no sign-in/
    );
  });
});

describe('both halves', () => {
  it('carries a sign-in from a browser here to a flow waiting there', async () => {
    const port = await freePort();
    let caught: string | null = null;

    // THE SEAM. On a laptop and a VPS these two listeners are the same port on
    // different machines, which is the entire problem the courier solves. One
    // machine has one port 53692, so the flow's listener is started at the
    // moment the courier gives the port back — the only compromise in this test,
    // and the reason there is no end-to-end e2e for this path.
    const deliver = async (redirectUri: string, params: Record<string, string>): Promise<unknown> => {
      const server = createServer((req, res) => {
        caught = req.url ?? null;
        res.writeHead(200).end('ok');
      });
      listeners.push(server);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
      await relayCallback(redirectUri, params);
      return { ok: true };
    };

    const { courier, delivered } = harness(true, deliver);
    track(courier);
    expectCallback(ANTHROPIC(port));
    courier.expectSignIn();
    courier.offer(ANTHROPIC(port));

    await visit(`http://127.0.0.1:${port}/callback?code=carried&state=anthropic-state`);
    await settle(() => delivered.length === 1 && caught !== null);

    expect(caught).toBe('/callback?code=carried&state=anthropic-state');
  });
});
