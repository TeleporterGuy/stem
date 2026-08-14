// One object for "the phone's link to a Stem server": the RPC call, the event
// stream, who is listening to what, and the connection state the UI renders.
//
// This is the file screens talk to; ./rpc.ts and ./stream.ts are its two halves
// and nothing above this line imports them directly. It holds no React and no
// Expo — the provider in ./provider.tsx supplies the streaming fetch and the
// Keychain, and this stays a plain object so a test can drive a whole session
// through it with two fakes.
//
// TWO QUESTIONS THAT MUST NOT BE CONFUSED, the same pair src/desktop/proxy.ts
// calls out: `paired` is whether this phone has a credential for a server at all
// — a fact about the Keychain, changed only by pairing and unpairing.
// `reachable` is whether that server is answering right now. A phone in a tunnel
// is paired and unreachable; a phone that has never been set up is neither.
//
// Fan-out is by channel name and nothing else. The desktop's proxy routes pushes
// to one of three windows and reveals an overlay for approval cards; a phone has
// one surface, so the routing table collapses to "whoever asked for this channel
// gets it" and the filtering that used to happen in the router (which thread is
// this for?) happens in the screen that knows.

import type { BackendEventEnvelope, LiveTurn } from '@shared/types';
import type { ChannelArgs, ChannelName, ChannelResult } from './channels';
import { rpc, type Endpoint } from './rpc';
import { createEventStream, type EventStream, type StreamingFetch } from './stream';

/** What the connection indicator renders, and what a composer would gate on. */
export interface ConnectionStatus {
  /** There is a stored pairing, so there is a server to talk to. */
  paired: boolean;
  /** The server answers. Decided by the transport, never by a response body. */
  reachable: boolean;
  /** A stream is open right now — i.e. events would arrive if anything happened. */
  streaming: boolean;
  /**
   * The server has this device's token and does not accept it (a revoked
   * device). Sticky until the next successful connect, because the answer is
   * "pair again", not "wait".
   */
  unauthorized: boolean;
}

export type Unsubscribe = () => void;

export interface ConnectionDeps {
  /** The streaming fetch used for GET /events; see ./expo-fetch.ts. */
  streamingFetch: StreamingFetch;
  /** The ordinary fetch used for POST /rpc. Defaults to the platform's. */
  fetch?: typeof globalThis.fetch;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface Connection {
  status(): ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): Unsubscribe;
  /** Every push on one channel. The names are the server's (`backend:event`, …). */
  onPush(channel: string, listener: (payload: unknown) => void): Unsubscribe;
  /** The backend's own event stream, typed. Sugar over onPush('backend:event'). */
  onBackendEvent(listener: (event: BackendEventEnvelope) => void): Unsubscribe;
  /**
   * The stream could not be resumed and whatever is on screen is now of unknown
   * age. Every screen holding server data must refetch — that is the entire
   * contract, and it is why the server sends this instead of a partial replay.
   */
  onResync(listener: () => void): Unsubscribe;
  /** What was running when the stream opened; see LiveTurn in shared/types.ts. */
  onLiveTurns(listener: (liveTurns: LiveTurn[]) => void): Unsubscribe;
  rpc<C extends ChannelName>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>>;
  /**
   * Point this connection at a server, or at nothing. Persisting the pairing is
   * the caller's job (./credentials.ts) — this only decides where the next
   * connect goes, and restarts the stream so it goes there immediately.
   */
  setEndpoint(endpoint: Endpoint | null): void;
  /** Reconnect now if the stream is down — what an app returning to the foreground calls. */
  wake(): void;
  start(): void;
  stop(): void;
}

/** The smallest listener set that supports unsubscribing during a dispatch. */
function emitter<T>(): {
  add: (listener: (value: T) => void) => Unsubscribe;
  emit: (value: T) => void;
} {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    }
  };
}

export function createConnection(deps: ConnectionDeps): Connection {
  let endpoint: Endpoint | null = null;
  let status: ConnectionStatus = {
    paired: false,
    reachable: false,
    streaming: false,
    unauthorized: false
  };

  const statusListeners = emitter<ConnectionStatus>();
  const resyncListeners = emitter<void>();
  const liveTurnListeners = emitter<LiveTurn[]>();
  const pushListeners = new Map<string, ReturnType<typeof emitter<unknown>>>();

  const patchStatus = (patch: Partial<ConnectionStatus>): void => {
    const next = { ...status, ...patch };
    if (
      next.paired === status.paired &&
      next.reachable === status.reachable &&
      next.streaming === status.streaming &&
      next.unauthorized === status.unauthorized
    ) {
      return;
    }
    status = next;
    statusListeners.emit(status);
  };

  const stream: EventStream = createEventStream({
    endpoint: () => endpoint,
    fetch: deps.streamingFetch,
    log: deps.log,
    onPush: (channel, payload) => pushListeners.get(channel)?.emit(payload),
    onResync: () => resyncListeners.emit(undefined),
    onSnapshot: (liveTurns) => liveTurnListeners.emit(liveTurns),
    onReachable: (reachable) => patchStatus({ reachable }),
    // A connect that got as far as a stream is a connect the credential passed,
    // so this is also where a stale `unauthorized` is cleared.
    onStreaming: (streaming) => patchStatus(streaming ? { streaming, unauthorized: false } : { streaming }),
    onRefused: (httpStatus) => patchStatus({ unauthorized: httpStatus === 401 })
  });

  const onPush = (channel: string, listener: (payload: unknown) => void): Unsubscribe => {
    let channelListeners = pushListeners.get(channel);
    if (!channelListeners) {
      channelListeners = emitter<unknown>();
      pushListeners.set(channel, channelListeners);
    }
    return channelListeners.add(listener);
  };

  return {
    status: () => status,
    onStatus: (listener) => statusListeners.add(listener),
    onPush,
    onBackendEvent: (listener) =>
      onPush('backend:event', (payload) => listener(payload as BackendEventEnvelope)),
    onResync: (listener) => resyncListeners.add(listener),
    onLiveTurns: (listener) => liveTurnListeners.add(listener),
    async rpc<C extends ChannelName>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>> {
      if (!endpoint) throw new Error('This phone is not paired with a Stem server yet.');
      const result = await rpc(endpoint, channel, args, {
        fetch: deps.fetch,
        onReachable: (reachable) => patchStatus({ reachable })
      });
      // The server answered, so it is up. That does not make the stream healthy
      // — a dead stream means missed events — so re-open it now rather than
      // waiting out the backoff.
      stream.retryNow();
      return result;
    },
    setEndpoint(next) {
      endpoint = next;
      patchStatus({
        paired: next !== null,
        // Nothing is known about a server we have not spoken to yet, and the
        // last one's verdict is not evidence about this one.
        reachable: false,
        unauthorized: false
      });
      stream.stop();
      if (next) stream.start();
    },
    wake() {
      stream.retryNow();
    },
    start() {
      stream.start();
    },
    stop() {
      stream.stop();
    }
  };
}
