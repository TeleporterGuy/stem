import type { StemApi } from '../../shared/types';

// The phone's stand-in for the preload bridge. There is no preload on this
// surface — the mobile bundle is fetched over HTTP rather than loaded into a
// BrowserWindow — so `window.stem` has to be built in the renderer itself, out
// of the two things the bridge exposes: `POST /rpc` and the `GET /events` SSE
// stream (see src/main/mobile/server.ts).
//
// It is deliberately GENERIC. Every member of StemApi is either
// `invoke(channel, …args)` or `on(channel, listener)` returning an unsubscribe
// (all 301 lines of src/preload/index.ts are one or the other), so a single
// request function plus a single event multiplexer cover the whole surface. The
// only per-member knowledge is which channel a name maps to, and that lives in
// the two tables below — which mirror src/main/mobile/channels.ts. A member
// absent from them is one the phone genuinely cannot have (`getPathForFile`
// needs Electron's webUtils; the dialogs open pickers on a Mac nobody is sitting
// at), so asking for it throws by name instead of returning undefined and
// failing later somewhere unrelated.
//
// Everything the transport touches from the outside — fetch, EventSource, the
// token store — is injectable, so the tests drive it without opening a socket.

/**
 * StemApi member → allowlisted /rpc channel. Kept in the same order as
 * MOBILE_INVOKE_CHANNELS so the two files read as one list; a channel here that
 * the server does not allow would be rejected with a 403 at runtime, which is
 * why the tests check this table against that one.
 */
export const INVOKE_CHANNELS: Readonly<Record<string, string>> = {
  startTurn: 'backend:startTurn',
  interruptTurn: 'backend:interruptTurn',
  rollbackToTurn: 'chats:rollbackToTurn',
  taskThreadSettings: 'tasks:threadSettings',

  listChats: 'chats:list',
  openChat: 'chats:open',

  addMemoryNote: 'memory:addNote',
  getActiveFacts: 'memory:activeFacts',

  previewImage: 'files:preview',

  respondExecApproval: 'exec:resolveApproval',
  respondMcpAdminApproval: 'mcp:adminDecision',
  respondInstructionsApproval: 'instructions:resolveApproval',

  getSettings: 'settings:get'
};

/** StemApi subscription → the SSE channel it is fed from (MOBILE_PUSH_CHANNELS). */
export const EVENT_CHANNELS: Readonly<Record<string, string>> = {
  onBackendEvent: 'backend:event',

  onExecApproval: 'exec:approvalRequest',
  onExecApprovalResolved: 'exec:approvalResolved',
  onMcpAdminApproval: 'mcp:adminApproval',
  onMcpAdminApprovalResolved: 'mcp:adminApprovalResolved',
  onInstructionsApproval: 'instructions:approvalRequest',
  onInstructionsApprovalResolved: 'instructions:approvalResolved',

  onMcpStatus: 'mcp:status'
};

/** Where the pairing token is kept once read out of the URL fragment. */
export const TOKEN_STORAGE_KEY = 'stem.mobile.token';

/** Reconnect backoff for a stream the browser itself gave up on. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** EventSource.CLOSED — the browser will not retry this stream on its own. */
const ES_CLOSED = 2;

/**
 * How the phone currently stands with the Mac. `offline` is a NORMAL state, not
 * an error: Stem does not keep the Mac awake, so a sleeping desk is the expected
 * resting condition and the UI has to say so plainly and recover by itself.
 */
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unauthorized';

/** Subscribable connection state, shaped for React's useSyncExternalStore. */
export interface ConnectionMonitor {
  get(): ConnectionState;
  subscribe(listener: () => void): () => void;
  /**
   * Re-open the stream now (the phone woke, the network came back, a tap).
   * `force` replaces a stream that still claims to be open — after the phone has
   * been suspended, `readyState` can say OPEN over a connection that is long
   * dead, and there is no way to tell an idle stream from a dead one from here.
   */
  retryNow(force?: boolean): void;
}

/** The slice of EventSource the multiplexer uses; the tests supply a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface MobileTransport {
  /** Install as `window.stem` before React mounts. */
  api: StemApi;
  connection: ConnectionMonitor;
  /** Drop the stream and stop reconnecting (tests; the app never closes it). */
  close(): void;
}

export interface TransportOptions {
  /** Bearer token from the pairing URL. */
  token: string;
  /** Origin to talk to; '' (the default) means same-origin, which is the app. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  eventSource?: EventSourceFactory;
}

/** A /rpc call the bridge refused or a handler failed; `status` is the HTTP code. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly channel: string
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The Mac could not be reached at all — distinct from a call it answered. */
export class UnreachableError extends Error {
  constructor(readonly channel: string) {
    super('Stem is unreachable — the Mac may be asleep or off the tailnet.');
    this.name = 'UnreachableError';
  }
}

// ---- pairing token ----

/** The subset of Storage the pairing token needs (tests pass a Map-backed fake). */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Shape guard, so a stray `#anchor` can never be persisted as a credential. */
const TOKEN_RE = /^[A-Za-z0-9._-]{16,256}$/;

/**
 * Resolve this device's bearer token. The pairing URL carries it in the URL
 * FRAGMENT (`…/mobile.html#token=…`), which browsers never send to a server — so
 * the first load reads it there and persists it, and every later load reads it
 * straight from storage. `fromFragment` tells the caller to strip the hash, so
 * the token stops riding in a URL that could be shared or restored.
 */
export function readPairingToken(
  hash: string,
  storage: TokenStore
): { token: string | null; fromFragment: boolean } {
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  const presented = fragment.get('token');
  if (presented && TOKEN_RE.test(presented)) {
    storage.setItem(TOKEN_STORAGE_KEY, presented);
    return { token: presented, fromFragment: true };
  }
  const stored = storage.getItem(TOKEN_STORAGE_KEY);
  return { token: stored && TOKEN_RE.test(stored) ? stored : null, fromFragment: false };
}

/**
 * Pair from a link the user pasted, rather than from the URL this page was opened
 * with. Installing to the Home Screen is what makes this necessary: iOS gives a
 * standalone web app its own storage container, so a client installed from a
 * paired Safari tab can start up with nothing stored and no address bar to fix it
 * with. Accepts the whole pairing link, just its fragment, or a bare token —
 * whatever survived the trip through the clipboard.
 *
 * Returns false without touching storage when there is no well-formed token in
 * `input`, so a mis-paste can't overwrite a working pairing.
 */
export function pairFromPastedLink(input: string, storage: TokenStore): boolean {
  const text = input.trim();
  if (!text) return false;
  const hash = text.includes('#') ? text.slice(text.indexOf('#')) : `#token=${text}`;
  const presented = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (!presented || !TOKEN_RE.test(presented)) return false;
  storage.setItem(TOKEN_STORAGE_KEY, presented);
  return true;
}

/** Forget the pairing (a token the bridge no longer accepts). */
export function clearPairingToken(storage: TokenStore): void {
  storage.removeItem(TOKEN_STORAGE_KEY);
}

// ---- transport ----

export function createMobileTransport(opts: TransportOptions): MobileTransport {
  const base = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  // The DOM's EventSource satisfies EventSourceLike; the cast is only needed
  // because its handler properties are typed with a `this` parameter.
  const openStream =
    opts.eventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  let state: ConnectionState = 'connecting';
  const stateListeners = new Set<() => void>();
  /** channel → its listeners. One stream, fanned out per channel. */
  const channelListeners = new Map<string, Set<(payload: unknown) => void>>();
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener();
  }

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ channel, args })
      });
    } catch {
      // A rejected fetch is a network fact, not a Stem error: say so in words the
      // user can act on, and let the connection banner follow.
      if (state !== 'unauthorized') setState('offline');
      throw new UnreachableError(channel);
    }
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | null;
    if (res.ok && body?.ok) {
      // The bridge answered, so the Mac is up. That does NOT make us online —
      // a dead stream means missed events — so ask the stream to re-open now
      // rather than waiting out its backoff. (Only when it had given up:
      // 'connecting' is an attempt already in flight.)
      if (state === 'offline') retryNow();
      return body.result;
    }
    // 401 is the one status that means this phone is no longer paired: stop
    // reconnecting and let the UI ask for a fresh pairing link. A 403 is the
    // origin check or the channel allowlist — a bug in the client, not the token.
    if (res.status === 401) {
      setState('unauthorized');
      stopStream();
    }
    throw new RpcError(body?.error ?? `${channel} failed (HTTP ${res.status})`, res.status, channel);
  }

  function on(channel: string, listener: (payload: unknown) => void): () => void {
    let listeners = channelListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      channelListeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) channelListeners.delete(channel);
    };
  }

  function deliver(raw: string): void {
    let frame: { channel?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return; // a truncated frame is not worth taking the client down for
    }
    if (typeof frame.channel !== 'string') return;
    const listeners = channelListeners.get(frame.channel);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(frame.payload);
  }

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function stopStream(): void {
    clearRetry();
    source?.close();
    source = null;
  }

  function scheduleReconnect(): void {
    clearRetry();
    attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed || state === 'unauthorized') return;
    clearRetry();
    source?.close();
    if (state !== 'online') setState('connecting');
    // EventSource cannot set headers, so /events takes the token as a query
    // parameter (the bridge accepts both forms).
    const es = openStream(`${base}/events?token=${encodeURIComponent(opts.token)}`);
    source = es;
    // Every handler checks it is still the current stream: a replaced one can
    // fire once more on its way out, and a stale error must not put a healthy
    // connection back into 'offline'.
    es.onopen = () => {
      if (source !== es) return;
      attempt = 0;
      setState('online');
    };
    es.onmessage = (ev) => {
      if (source !== es) return;
      deliver(ev.data);
    };
    es.onerror = () => {
      if (source !== es) return;
      setState('offline');
      // A dropped connection is retried by the browser itself (the server sends
      // a `retry:` directive). It gives up — readyState CLOSED — when the
      // response was an error instead, which is exactly what a sleeping Mac
      // behind `tailscale serve` looks like. Re-open those ourselves, or the
      // phone would sit dead until someone reloads it by hand.
      if (es.readyState === ES_CLOSED) {
        es.close();
        if (source === es) source = null;
        scheduleReconnect();
      }
    };
  }

  function retryNow(force = false): void {
    if (closed) return;
    // A stream that is up and answering is left alone unless the caller has
    // reason to distrust it (see the ConnectionMonitor doc comment).
    if (!force && state === 'online' && source && source.readyState !== ES_CLOSED) return;
    attempt = 0;
    connect();
  }

  // `platform` is the one non-function member of StemApi. Nothing on the phone
  // branches on it (it drives the desktop's mod-key glyphs and per-OS CSS), and
  // the client cannot know what the Mac is running, so it reports the only value
  // Stem ships a phone bridge for.
  const api = { platform: 'darwin' } as Record<string, unknown>;
  for (const [member, channel] of Object.entries(INVOKE_CHANNELS)) {
    api[member] = (...args: unknown[]) => invoke(channel, args);
  }
  for (const [member, channel] of Object.entries(EVENT_CHANNELS)) {
    api[member] = (listener: (payload: unknown) => void) => on(channel, listener);
  }

  const bridge = new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return Reflect.get(target, prop);
      if (prop in target) return target[prop];
      // Not in either table: a member that has no meaning on a phone. Fail by
      // name, at the call site, instead of returning undefined.
      return () => {
        throw new Error(`window.stem.${prop}() is not available on Stem mobile.`);
      };
    }
  }) as unknown as StemApi;

  connect();

  return {
    api: bridge,
    connection: {
      get: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      retryNow
    },
    close() {
      closed = true;
      stopStream();
      channelListeners.clear();
    }
  };
}
