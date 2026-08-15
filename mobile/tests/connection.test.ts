import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection, type ConnectionStatus } from '../src/transport/connection';
import type { StreamingFetch } from '../src/transport/stream';

// The object the screens hold: pairing state, connection state, and who hears
// which push. Driven over the same fake socket the reader's own test uses.

function harness(): { fetch: StreamingFetch; send(text: string): void; refuseNext(status: number): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let status = 200;
  const fetch: StreamingFetch = async (_url, init) => {
    if (status !== 200) {
      const refusal = status;
      status = 200;
      return { status: refusal, body: null };
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    init.signal.addEventListener('abort', () => {
      try {
        controller?.error(new Error('aborted'));
      } catch {
        // already closed
      }
    });
    return { status: 200, body };
  };
  return {
    fetch,
    send: (text) => controller?.enqueue(new TextEncoder().encode(text)),
    refuseNext: (next) => {
      status = next;
    }
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
}

const endpoint = { serverUrl: 'https://stem.example', token: 'tok' };

describe('createConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts knowing nothing, and refuses to call anything', async () => {
    const net = harness();
    const connection = createConnection({ streamingFetch: net.fetch });
    expect(connection.status()).toEqual({ paired: false, reachable: false, streaming: false, unauthorized: false });
    await expect(connection.rpc('chats:list')).rejects.toThrow('not paired');
  });

  it('opens the stream when it is given a server, and closes it when it loses one', async () => {
    const net = harness();
    const seen: ConnectionStatus[] = [];
    const connection = createConnection({ streamingFetch: net.fetch });
    connection.onStatus((status) => seen.push(status));
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();
    expect(connection.status()).toMatchObject({ paired: true, reachable: true, streaming: true });

    connection.setEndpoint(null);
    await settle();
    expect(connection.status()).toMatchObject({ paired: false, streaming: false, reachable: false });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('hands each push to whoever asked for that channel', async () => {
    const net = harness();
    const connection = createConnection({ streamingFetch: net.fetch });
    const chats = vi.fn();
    const events = vi.fn();
    connection.onPush('chats:changed', chats);
    connection.onBackendEvent(events);
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    net.send('id: e.1\ndata: {"channel":"chats:changed","payload":null}\n\n');
    net.send('id: e.2\ndata: {"channel":"backend:event","payload":{"method":"turn/completed","params":{"threadId":"t1"},"receivedAt":"x"}}\n\n');
    net.send('id: e.3\ndata: {"channel":"mcp:status","payload":{}}\n\n');
    await settle();

    expect(chats).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({ method: 'turn/completed', params: { threadId: 't1' }, receivedAt: 'x' });
    connection.stop();
  });

  it('passes on the two control frames', async () => {
    const net = harness();
    const connection = createConnection({ streamingFetch: net.fetch });
    const resync = vi.fn();
    const liveTurns = vi.fn();
    connection.onResync(resync);
    connection.onLiveTurns(liveTurns);
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    net.send('event: snapshot\ndata: {"liveTurns":[{"threadId":"t1","turnId":"u1"}]}\n\n');
    net.send('event: resync\ndata: {"head":"e.9"}\n\n');
    await settle();

    expect(liveTurns).toHaveBeenCalledWith([{ threadId: 't1', turnId: 'u1' }]);
    expect(resync).toHaveBeenCalledTimes(1);
    connection.stop();
  });

  it('says so when the server will not have this device, and stops saying it once it does', async () => {
    const net = harness();
    net.refuseNext(401);
    const connection = createConnection({ streamingFetch: net.fetch });
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();
    expect(connection.status()).toMatchObject({ paired: true, reachable: true, unauthorized: true, streaming: false });

    // The retry succeeds: a stream opened at all means the credential passed.
    await vi.advanceTimersByTimeAsync(300);
    expect(connection.status()).toMatchObject({ unauthorized: false, streaming: true });
    connection.stop();
  });

  it('stops listening when a listener unsubscribes', async () => {
    const net = harness();
    const connection = createConnection({ streamingFetch: net.fetch });
    const listener = vi.fn();
    const off = connection.onPush('chats:changed', listener);
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();
    off();
    net.send('id: e.1\ndata: {"channel":"chats:changed","payload":null}\n\n');
    await settle();
    expect(listener).not.toHaveBeenCalled();
    connection.stop();
  });
});

// Where the offline cache is allowed to speak.
//
// The cache's own rules are tested in offline-cache.test.ts; what is tested here
// is the seam, which is the part that makes them safe. A cached answer may only
// ever replace a request that reached NOBODY. A server that answers with an
// error is a server that is up, and its error is what the screen must get —
// getting this backwards is how a stale thread quietly overwrites a live one.
describe('createConnection and the offline cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function stubCache(replayWith?: unknown) {
    return {
      record: vi.fn(),
      replay: vi.fn(() => replayWith),
      schedulePrefetch: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
      close: vi.fn()
    };
  }

  /** An ordinary fetch that answers, or throws as an unreachable network does. */
  function rpcFetch(answer: { ok: boolean; result?: unknown; error?: string } | Error): typeof globalThis.fetch {
    return (async () => {
      if (answer instanceof Error) throw answer;
      return { ok: true, status: 200, json: async () => answer } as Response;
    }) as typeof globalThis.fetch;
  }

  it('answers from the cache when nothing answered at all', async () => {
    const net = harness();
    const cache = stubCache({ chats: [], offline: true });
    const connection = createConnection({
      streamingFetch: net.fetch,
      fetch: rpcFetch(new TypeError('Network request failed')),
      cache
    });
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    await expect(connection.rpc('chats:list')).resolves.toMatchObject({ offline: true });
    expect(cache.replay).toHaveBeenCalledWith('chats:list', []);
    connection.stop();
  });

  it('lets the error the server itself sent through, and never consults the cache for it', async () => {
    const net = harness();
    const cache = stubCache({ chats: [], offline: true });
    const connection = createConnection({
      streamingFetch: net.fetch,
      fetch: rpcFetch({ ok: false, error: 'that chat is gone' }),
      cache
    });
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    await expect(connection.rpc('chats:open', 'a')).rejects.toThrow('that chat is gone');
    expect(cache.replay).not.toHaveBeenCalled();
    connection.stop();
  });

  it('still fails when nothing answered and the cache has nothing either', async () => {
    const net = harness();
    const cache = stubCache(undefined);
    const connection = createConnection({
      streamingFetch: net.fetch,
      fetch: rpcFetch(new TypeError('Network request failed')),
      cache
    });
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    await expect(connection.rpc('chats:open', 'a')).rejects.toThrow(/could not reach/);
    connection.stop();
  });

  it('writes every answer through, and tops the cache up once a stream is open', async () => {
    const net = harness();
    const cache = stubCache();
    const connection = createConnection({
      streamingFetch: net.fetch,
      fetch: rpcFetch({ ok: true, result: { chats: [] } }),
      cache
    });
    connection.start();
    connection.setEndpoint(endpoint);
    await settle();

    // The stream came up, which is the moment the phone is demonstrably on a
    // network and may not be in a minute.
    expect(cache.schedulePrefetch).toHaveBeenCalled();

    await connection.rpc('chats:list');
    expect(cache.record).toHaveBeenCalledWith('chats:list', [], { chats: [] });

    // A server we are no longer pointed at must not have its answers land under
    // the next one's name.
    connection.setEndpoint(null);
    expect(cache.cancel).toHaveBeenCalled();
    connection.stop();
  });
});
