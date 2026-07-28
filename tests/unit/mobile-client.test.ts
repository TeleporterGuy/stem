// The phone client's transport: the generic StemApi shim over POST /rpc and the
// /events SSE stream. This is the renderer half of the bridge that
// mobile-bridge.test.ts covers from the main side, so the two meet at the wire
// contract — the channel tables here are checked against the server's own
// allowlist, and every error status the server can answer with is mapped to
// something the UI can act on.
//
// Nothing here opens a socket: fetch, EventSource and the token store are all
// injected, which is exactly how the transport is built to be driven.

import { describe, expect, it } from 'vitest';
import { MOBILE_INVOKE_CHANNELS, MOBILE_PUSH_CHANNELS } from '../../src/main/mobile/channels';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  RpcError,
  TOKEN_STORAGE_KEY,
  UnreachableError,
  clearPairingToken,
  createMobileTransport,
  pairFromPastedLink,
  readPairingToken,
  type EventSourceLike,
  type TokenStore
} from '../../src/renderer/mobile/transport';

const TOKEN = 'a'.repeat(64);

/** EventSource stand-in: the test drives open/message/error by hand. */
class FakeEventSource implements EventSourceLike {
  static readonly opened: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** A frame exactly as the server writes it: the JSON after `data: `. */
  emit(channel: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ channel, payload }) });
  }

  raw(data: string): void {
    this.onmessage?.({ data });
  }

  /** `retrying` = the browser will reconnect itself; otherwise it gave up. */
  fail(retrying: boolean): void {
    this.readyState = retrying ? 0 : 2;
    this.onerror?.({});
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

interface FakeCall {
  url: string;
  channel: string;
  args: unknown[];
  authorization: string | undefined;
}

/** Build a transport over a scripted fetch and a fake stream. */
function harness(reply: (channel: string, args: unknown[]) => { status: number; body: unknown } | Error) {
  FakeEventSource.opened.length = 0;
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { channel: string; args: unknown[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      channel: body.channel,
      args: body.args,
      authorization: headers.authorization
    });
    const answer = reply(body.channel, body.args);
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body
    } as Response;
  }) as unknown as typeof fetch;

  const transport = createMobileTransport({
    token: TOKEN,
    baseUrl: 'http://stem.test',
    fetchImpl,
    eventSource: (url) => new FakeEventSource(url)
  });
  const stream = (): FakeEventSource => FakeEventSource.opened[FakeEventSource.opened.length - 1];
  return { transport, calls, stream, opened: FakeEventSource.opened };
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });
const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });

function memoryStore(seed: Record<string, string> = {}): TokenStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  };
}

describe('POST /rpc', () => {
  it('posts {channel, args} with the bearer token and unwraps the result', async () => {
    const { transport, calls } = harness(() => ok({ chats: [{ threadId: 't-1' }], folders: [] }));
    const result = await transport.api.listChats();
    expect(result).toEqual({ chats: [{ threadId: 't-1' }], folders: [] });
    expect(calls).toEqual([
      {
        url: 'http://stem.test/rpc',
        channel: 'chats:list',
        args: [],
        authorization: `Bearer ${TOKEN}`
      }
    ]);
    transport.close();
  });

  it('passes every argument through in order', async () => {
    const { transport, calls } = harness(() => ok(null));
    await transport.api.startTurn({ input: 'hi', format: 'mdx' });
    await transport.api.respondInstructionsApproval(7, true, 'main', 'text');
    expect(calls[0]).toMatchObject({ channel: 'backend:startTurn', args: [{ input: 'hi', format: 'mdx' }] });
    expect(calls[1]).toMatchObject({ channel: 'instructions:resolveApproval', args: [7, true, 'main', 'text'] });
    transport.close();
  });

  it('maps every error status the bridge can answer with', async () => {
    const cases: [number, string][] = [
      [400, 'Rejected local call to backend:startTurn'],
      [401, 'unauthorized'],
      [403, 'channel backend:startTurn is not available on mobile'],
      [413, 'request body too large'],
      [500, 'pi is not running']
    ];
    for (const [status, error] of cases) {
      const { transport } = harness(() => fail(status, error));
      // 401 latches the transport into `unauthorized`, so each case gets a
      // fresh one — that is the behaviour the next test pins.
      await expect(transport.api.startTurn({ input: 'hi' })).rejects.toMatchObject({
        name: 'RpcError',
        status,
        message: error,
        channel: 'backend:startTurn'
      });
      transport.close();
    }
  });

  it('falls back to the status when the bridge sends no error text', async () => {
    const { transport } = harness(() => ({ status: 502, body: null }));
    await expect(transport.api.getSettings()).rejects.toBeInstanceOf(RpcError);
    await expect(transport.api.getSettings()).rejects.toThrow(/HTTP 502/);
    transport.close();
  });

  it('reports a rejected fetch as unreachable, not as a Stem error', async () => {
    const { transport } = harness(() => new TypeError('Failed to fetch'));
    await expect(transport.api.listChats()).rejects.toBeInstanceOf(UnreachableError);
    await expect(transport.api.listChats()).rejects.toThrow(/may be asleep/);
    expect(transport.connection.get()).toBe('offline');
    transport.close();
  });

  it('names a member the phone cannot have instead of returning undefined', async () => {
    const { transport } = harness(() => ok(null));
    // getPathForFile needs Electron's webUtils; there is no such thing here.
    expect(() => transport.api.getPathForFile(null as unknown as File)).toThrow(/getPathForFile/);
    expect(() => transport.api.revealMain()).toThrow(/not available on Stem mobile/);
    transport.close();
  });

  it('only maps channels the bridge actually allows', () => {
    // The client's table and the server's allowlist are two halves of one
    // decision about what a phone may do; drift between them is a 403 at best.
    for (const [member, channel] of Object.entries(INVOKE_CHANNELS)) {
      expect(`${member} → ${channel}`).toBe(
        `${member} → ${MOBILE_INVOKE_CHANNELS.has(channel) ? channel : 'NOT ALLOWLISTED'}`
      );
    }
    expect(Object.values(INVOKE_CHANNELS)).toContain('backend:startTurn');
  });

  it('leaves nothing allowlisted that the client cannot reach', () => {
    // The other direction, and the one that rots quietly: a channel the server
    // permits with no client member behind it is blast radius for free. Both
    // tables are edited together or this fails.
    const mapped = new Set(Object.values(INVOKE_CHANNELS));
    expect([...MOBILE_INVOKE_CHANNELS].filter((c) => !mapped.has(c))).toEqual([]);
  });
});

describe('/events multiplexer', () => {
  it('fans one stream out to every listener on a channel', () => {
    const { transport, stream, opened } = harness(() => ok(null));
    expect(opened).toHaveLength(1);
    expect(stream().url).toBe(`http://stem.test/events?token=${TOKEN}`);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const seenMcp: unknown[] = [];
    transport.api.onBackendEvent((e) => seenA.push(e));
    transport.api.onBackendEvent((e) => seenB.push(e));
    transport.api.onMcpStatus((s) => seenMcp.push(s));

    stream().open();
    stream().emit('backend:event', { method: 'item/agentMessage/delta', params: { delta: 'hi' } });
    stream().emit('mcp:status', { servers: [] });
    // A channel nobody subscribed to must not disturb the others.
    stream().emit('exec:approvalRequest', { id: 'x' });

    expect(seenA).toEqual([{ method: 'item/agentMessage/delta', params: { delta: 'hi' } }]);
    expect(seenB).toEqual(seenA);
    expect(seenMcp).toEqual([{ servers: [] }]);
    transport.close();
  });

  it('unsubscribe removes exactly that listener', () => {
    const { transport, stream } = harness(() => ok(null));
    const first: unknown[] = [];
    const second: unknown[] = [];
    const off = transport.api.onBackendEvent((e) => first.push(e));
    transport.api.onBackendEvent((e) => second.push(e));

    stream().open();
    stream().emit('backend:event', { method: 'one' });
    off();
    stream().emit('backend:event', { method: 'two' });
    // Unsubscribing again is harmless.
    off();
    stream().emit('backend:event', { method: 'three' });

    expect(first).toEqual([{ method: 'one' }]);
    expect(second).toEqual([{ method: 'one' }, { method: 'two' }, { method: 'three' }]);
    transport.close();
  });

  it('survives a frame that is not JSON', () => {
    const { transport, stream } = harness(() => ok(null));
    const seen: unknown[] = [];
    transport.api.onBackendEvent((e) => seen.push(e));
    stream().open();
    stream().raw('{ half a frame');
    stream().emit('backend:event', { method: 'ok' });
    expect(seen).toEqual([{ method: 'ok' }]);
    transport.close();
  });

  it('subscribes only to push channels the bridge actually sends', () => {
    // The mirror of the invoke check: a listener on a channel main never pushes
    // is a feature that silently never fires.
    for (const [member, channel] of Object.entries(EVENT_CHANNELS)) {
      expect(`${member} → ${channel}`).toBe(
        `${member} → ${MOBILE_PUSH_CHANNELS.has(channel) ? channel : 'NOT PUSHABLE'}`
      );
    }
    expect(EVENT_CHANNELS.onBackendEvent).toBe('backend:event');
    // And nothing pushed that no listener is wired to receive.
    const subscribed = new Set(Object.values(EVENT_CHANNELS));
    expect([...MOBILE_PUSH_CHANNELS].filter((c) => !subscribed.has(c))).toEqual([]);
  });
});

describe('connection state', () => {
  it('follows the stream up, down, and back up again', () => {
    const { transport, stream } = harness(() => ok(null));
    const seen: string[] = [];
    transport.connection.subscribe(() => seen.push(transport.connection.get()));

    expect(transport.connection.get()).toBe('connecting');
    stream().open();
    expect(transport.connection.get()).toBe('online');

    // A dropped connection the browser retries on its own: offline, but no new
    // stream is opened here — EventSource owns that retry.
    stream().fail(true);
    expect(transport.connection.get()).toBe('offline');
    expect(FakeEventSource.opened).toHaveLength(1);

    stream().open();
    expect(transport.connection.get()).toBe('online');
    expect(seen).toEqual(['online', 'offline', 'online']);
    transport.close();
  });

  it('re-opens a stream the browser gave up on (a sleeping Mac behind a proxy)', async () => {
    const { transport, stream } = harness(() => ok(null));
    stream().open();
    const first = stream();
    // readyState CLOSED: the response was an error, so EventSource stops. The
    // transport has to take over, or the phone would sit dead until a reload.
    first.fail(false);
    expect(transport.connection.get()).toBe('offline');
    expect(first.closed).toBe(true);

    // The supervisor backs off before retrying; a manual nudge (phone woke,
    // network came back, "Try now") short-circuits the wait.
    transport.connection.retryNow();
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(transport.connection.get()).toBe('connecting');
    stream().open();
    expect(transport.connection.get()).toBe('online');

    // A plain nudge while the stream is live must not interrupt a running turn.
    transport.connection.retryNow();
    expect(FakeEventSource.opened).toHaveLength(2);
    // A forced one does replace it: after the phone has been suspended,
    // readyState can claim OPEN over a connection that is long dead. The state
    // stays 'online' across that swap on purpose — foregrounding the app must
    // not flash a "Connecting…" banner for a stream that is fine.
    transport.connection.retryNow(true);
    expect(FakeEventSource.opened).toHaveLength(3);
    expect(transport.connection.get()).toBe('online');
    transport.close();
  });

  it('latches unauthorized on a 401 and stops reconnecting', async () => {
    const { transport, stream } = harness(() => fail(401, 'unauthorized'));
    stream().open();
    await expect(transport.api.listChats()).rejects.toMatchObject({ status: 401 });
    expect(transport.connection.get()).toBe('unauthorized');
    expect(stream().closed).toBe(true);
    // A wrong token stays wrong: retrying it would just hammer the bridge.
    transport.connection.retryNow(true);
    expect(FakeEventSource.opened).toHaveLength(1);
    transport.close();
  });

  it('asks the stream to re-open when a call proves the Mac is up', async () => {
    let reachable = false;
    const { transport, stream } = harness(() =>
      reachable ? ok(null) : new TypeError('Failed to fetch')
    );
    stream().open();
    stream().fail(false);
    expect(transport.connection.get()).toBe('offline');

    reachable = true;
    await transport.api.listChats();
    // Reachable, but not "online" — that is the stream's word, not the RPC's.
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(transport.connection.get()).toBe('connecting');
    transport.close();
  });
});

describe('pairing token', () => {
  it('reads the token out of the URL fragment and persists it', () => {
    const storage = memoryStore();
    const first = readPairingToken(`#token=${TOKEN}`, storage);
    expect(first).toEqual({ token: TOKEN, fromFragment: true });
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);

    // Second load: the fragment is gone (the entry stripped it), storage answers.
    const second = readPairingToken('', storage);
    expect(second).toEqual({ token: TOKEN, fromFragment: false });
  });

  it('ignores a fragment that is not a token', () => {
    const storage = memoryStore();
    expect(readPairingToken('#section-two', storage)).toEqual({ token: null, fromFragment: false });
    expect(readPairingToken('#token=nope', storage)).toEqual({ token: null, fromFragment: false });
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('reports an unpaired browser rather than a broken one', () => {
    // No fragment, nothing stored: the entry renders the pairing notice.
    expect(readPairingToken('', memoryStore()).token).toBeNull();
    // Stored junk (a hand-edited or truncated value) is not a credential either.
    expect(readPairingToken('', memoryStore({ [TOKEN_STORAGE_KEY]: 'x' })).token).toBeNull();
  });

  it('forgets a pairing on request', () => {
    const storage = memoryStore({ [TOKEN_STORAGE_KEY]: TOKEN });
    clearPairingToken(storage);
    expect(readPairingToken('', storage).token).toBeNull();
  });
});

describe('pairing from a pasted link', () => {
  // The installed-to-Home-Screen path: iOS gives a standalone web app its own
  // storage container and no address bar, so a client installed from a paired
  // Safari tab can start up unpaired with no URL to fix it with.
  it('accepts the whole link, just the fragment, or a bare token', () => {
    for (const input of [
      `https://mac.tailnet-name.ts.net/mobile.html#token=${TOKEN}`,
      `#token=${TOKEN}`,
      TOKEN,
      `  ${TOKEN}  `
    ]) {
      const storage = memoryStore();
      expect(pairFromPastedLink(input, storage)).toBe(true);
      expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    }
  });

  it('refuses a mis-paste without disturbing a working pairing', () => {
    const storage = memoryStore({ [TOKEN_STORAGE_KEY]: TOKEN });
    for (const input of ['', '   ', 'https://mac.tailnet-name.ts.net/mobile.html', '#token=nope', 'hello there']) {
      expect(pairFromPastedLink(input, storage)).toBe(false);
    }
    expect(storage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });
});
