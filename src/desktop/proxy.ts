import { request as httpRequest } from 'node:http';
import { log } from '../server/log';
import type { AppSettings, BackendEventEnvelope, QuickChatSettings } from '../shared/types';

// The desktop's half of the wire. Everything the renderer asks for that this
// machine cannot answer itself leaves through here as `POST /rpc`, and everything
// the server pushes arrives here on one SSE stream and is fanned out to the three
// windows.
//
// Embedded or remote, it is the same socket. The server usually runs in this very
// process (started at boot unless STEM_SERVER_URL points elsewhere), and there is
// deliberately NO short-circuit for that case: a turn typed at the desk is
// serialized, written to a loopback socket, read back and parsed, exactly as it
// would be from a VPS. A fast path only the embedded deployment takes is a path
// the remote deployment never gets tested on.
//
// ---------------------------------------------------------------------------
//
// Which side answers a channel. Three buckets, and the middle one is the reason
// this file exists rather than a switch somewhere:
//
// CLIENT-OWNED — never registered on the server, never on the wire. They act on
// THIS machine, so a server that might be elsewhere cannot answer them:
//
//   dialog:openFiles, dialog:openDirectory       native pickers
//   files:reveal, files:preview                  shell.showItemInFolder; preview
//                                                reads an image path that, by
//                                                construction, is on the client's
//                                                own disk (the `att.path` branch
//                                                of renderer/attachments.ts)
//   cfolders:reveal, cfolders:revealWorkspace    shell.showItemInFolder. The PATH
//                                                comes from the server; correct on
//                                                one machine, meaningless remote
//                                                (a known Phase 2 gap)
//   quickchat:*, main:reveal                     the overlay/HUD windows
//   quickchat:handoffSnapshot, renderer:ready    ipcMain.on, not invoke
//   getPathForFile                               webUtils, not a channel at all
//   pushes: quickchat:focus/adopt/sessionStarted/status/handoffRequest,
//           hud:playChime
//
//   They live in desktop/local/, desktop/quickchat/ and desktop/ipc-bridge.ts.
//
// WRAPPED — client behavior AND a server call, in a fixed order. There are two,
// and they are declared as data below rather than special-cased at the call site
// on purpose: an ad-hoc `if (channel === …)` in the invoke path is how a fourth
// and fifth one appear without anybody deciding to add them.
//
//   chats:open                 the sidebar opening the overlay's live thread is an
//                              implicit hand-off. It runs HERE and FIRST — capture
//                              the snapshot, flip ownership through the barrier,
//                              hide the overlay, replay the buffered events — and
//                              only then is the open forwarded. Refusing it throws
//                              before anything is sent, which is how its two error
//                              strings still reach the renderer unchanged.
//   settings:updateQuickChat   forward first so the write lands, then re-register
//                              the global accelerator and re-cache the overlay's
//                              preferences from the settings that came back. The
//                              accelerator is a grab on an OS, not a setting.
//
// SERVER-OWNED — everything else (~110 channels). The server's registry IS the
// surface; this client asks for it at connect time (GET /channels) rather than
// keeping a copy, which is what lets one build talk to an embedded server and a
// standalone one.

/** Origin of an external server to use instead of starting one in-process. */
export const EXTERNAL_SERVER_URL = process.env.STEM_SERVER_URL?.trim() || null;

/**
 * Deliberately generous. An RPC is not a request to a web service — it is a
 * handler that may be waiting on pi to accept a prompt, on an OAuth callback, or
 * on a model download. The timeout exists so a wedged server cannot wedge the
 * renderer forever, not to bound normal work, so it is set well past anything
 * that legitimately happens.
 */
const RPC_TIMEOUT_MS = 10 * 60_000;

/** Reconnect backoff for the event stream. */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 10_000;

/**
 * A channel with behavior on both sides of the wire. `before` runs on this
 * machine and can refuse the call by throwing; `after` runs once the server has
 * answered, with what it answered.
 */
export interface WrappedChannel {
  before?: (args: unknown[]) => Promise<void> | void;
  after?: (args: unknown[], result: unknown) => void;
}

export interface ProxyDeps {
  /** Origin of the server, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** This device's bearer token (the `desktop` role). */
  token: string;
  /** Push to the main window through its ready-queue (see RendererPushQueue). */
  sendToMain(channel: string, payload: unknown): void;
  /** Push to the Quick Chat overlay window. */
  sendToOverlay(channel: string, payload: unknown): void;
  /** Bring the overlay back when it owns `threadId` (approval cards). */
  revealIfOwns(threadId: string | null | undefined): void;
  /** Hand a backend thread event to the overlay / HUD / main-window routing. */
  routeBackendEvent(event: BackendEventEnvelope): void;
  /** Raise + focus the main window (notify_user prominence). */
  revealMainWindow(): void;
  /** OS-level attention nudge (dock bounce / taskbar flash). */
  requestAttention(): void;
  /** The implicit Quick Chat hand-off, run before a thread is opened. */
  threadOpened(threadId: string): Promise<void>;
  /** Quick Chat settings were persisted: apply the parts that are not settings. */
  applyQuickChatSettings(patch: Partial<QuickChatSettings>, next: QuickChatSettings): void;
}

export interface ServerProxy {
  /** Ask what we may call and open the event stream. Resolves once both are up. */
  start(): Promise<string[]>;
  /** Call a server channel: wrapped client behavior, then POST /rpc. */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Drop the stream and stop reconnecting (quit; tests). */
  close(): void;
}

export function createServerProxy(deps: ProxyDeps): ServerProxy {
  const base = deps.url.replace(/\/$/, '');
  const auth = `Bearer ${deps.token}`;

  const wrapped: Readonly<Record<string, WrappedChannel>> = {
    'chats:open': {
      before: ([threadId]) => deps.threadOpened(threadId as string)
    },
    'settings:updateQuickChat': {
      after: ([patch], result) =>
        deps.applyQuickChatSettings(patch as Partial<QuickChatSettings>, (result as AppSettings).quickChat)
    }
  };

  // ---- POST /rpc ----

  async function post(channel: string, args: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ channel, args }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
      });
    } catch (e) {
      // The server could not be reached (or took longer than any handler should).
      // Distinct from a call it answered, and the only error shape here the
      // renderer could not have seen before the split.
      throw new Error(`Stem's server is unreachable: ${String((e as Error)?.message ?? e)}`);
    }
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | null;
    if (res.ok && body?.ok) {
      // The server answered, so it is up. That does not make the stream healthy —
      // a dead stream means missed events — so re-open it now rather than waiting
      // out the backoff.
      if (!streamOpen) retryNow();
      return body.result;
    }
    // The server's own message, verbatim, so the renderer's error handling cannot
    // tell which side of the wire answered. The guard's `Rejected local call to X:
    // …` wording arrives here intact and is rethrown unchanged.
    throw new Error(body?.error ?? `${channel} failed (HTTP ${res.status})`);
  }

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    const hooks = wrapped[channel];
    // A throw from `before` never reaches the wire — that is what lets a refused
    // Quick Chat hand-off cancel the open it was called for.
    if (hooks?.before) await hooks.before(args);
    const result = await post(channel, args);
    hooks?.after?.(args, result);
    return result;
  }

  // ---- GET /events ----

  let stream: ReturnType<typeof httpRequest> | null = null;
  let streamOpen = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let closed = false;

  function deliver(raw: string): void {
    let frame: { channel?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return; // a truncated frame is not worth taking the app down for
    }
    if (typeof frame.channel !== 'string') return;
    fanOut(frame.channel, frame.payload);
  }

  /**
   * Which of the desktop's three windows a push is for. This is the table that
   * used to sit behind a direct callback in index.ts; the routing decision and
   * its reasons are unchanged, it just reads from a socket now.
   */
  function fanOut(channel: string, payload: unknown): void {
    switch (channel) {
      // The backend's own event stream. The overlay may own the thread, a
      // hand-off may be buffering — all of that is client state, so the decision
      // is made here and not by the server (see quickchat/index.ts).
      case 'backend:event':
        deps.routeBackendEvent(payload as BackendEventEnvelope);
        return;
      // Things only a machine with a screen can do. They arrive as pushes rather
      // than as calls into this process because a server has no window to raise.
      case 'client:revealMainWindow':
        deps.revealMainWindow();
        return;
      case 'client:requestAttention':
        deps.requestAttention();
        return;
      // Approval cards: both surfaces mount them, and the overlay hides itself
      // while a turn runs — bring it back when the request belongs to its thread,
      // or mounting the card would not actually make the confirmation visible.
      case 'exec:approvalRequest':
      case 'mcp:adminApproval':
      case 'instructions:approvalRequest':
      case 'skills:approvalRequest':
        deps.revealIfOwns((payload as { threadId?: string } | undefined)?.threadId);
        deps.sendToMain(channel, payload);
        deps.sendToOverlay(channel, payload);
        return;
      // Resolutions and catalog/status changes: rendered by both surfaces, and
      // harmlessly ignored by whichever one has no listener mounted.
      case 'exec:approvalResolved':
      case 'mcp:adminApprovalResolved':
      case 'instructions:approvalResolved':
      case 'skills:approvalResolved':
      case 'mcp:changed':
      case 'mcp:status':
      case 'skills:changed':
        deps.sendToMain(channel, payload);
        deps.sendToOverlay(channel, payload);
        return;
      default:
        // Everything else is main-window furniture: sign-in progress, the task
        // feed and its alerts, background-activity and model-download status.
        deps.sendToMain(channel, payload);
    }
  }

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleReconnect(): void {
    if (closed) return;
    clearRetry();
    attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  /**
   * Open the stream. Every handler checks it is still the current request: a
   * replaced one can fire once more on its way out, and a stale error must not
   * tear down a healthy connection.
   */
  function connect(): void {
    if (closed) return;
    clearRetry();
    stream?.destroy();
    streamOpen = false;
    const req = httpRequest(
      `${base}/events`,
      { method: 'GET', headers: { authorization: auth, accept: 'text/event-stream' } },
      (res) => {
        if (stream !== req) return;
        if (res.statusCode !== 200) {
          // 401 means this device's token is not in the registry. There is no
          // pairing UX to fall back to on the desktop (unlike the phone, which
          // stops and asks), so this is logged and retried: a server that
          // re-read its registry can still recover the connection.
          log('proxy', 'event stream refused', { status: res.statusCode });
          res.resume();
          stream = null;
          scheduleReconnect();
          return;
        }
        attempt = 0;
        streamOpen = true;
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          if (stream !== req) return;
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            // `id:` is carried for a Phase 2 replay buffer and ignored here;
            // comment lines are the keepalive.
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n');
            if (data) deliver(data);
            split = buffer.indexOf('\n\n');
          }
        });
        const dropped = (): void => {
          if (stream !== req) return;
          stream = null;
          streamOpen = false;
          scheduleReconnect();
        };
        res.on('end', dropped);
        res.on('error', dropped);
        res.on('close', dropped);
      }
    );
    stream = req;
    req.on('error', () => {
      if (stream !== req) return;
      stream = null;
      streamOpen = false;
      scheduleReconnect();
    });
    req.end();
  }

  function retryNow(): void {
    if (closed || streamOpen) return;
    attempt = 0;
    connect();
  }

  /** What this client may call, asked once at connect time. */
  async function channels(): Promise<string[]> {
    const res = await fetch(`${base}/channels`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(30_000)
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: string[] } | null;
    if (!res.ok || !body?.ok || !Array.isArray(body.result)) {
      throw new Error(`Stem's server would not list its channels (HTTP ${res.status})`);
    }
    return body.result;
  }

  return {
    async start() {
      const list = await channels();
      connect();
      return list;
    },
    invoke,
    close() {
      closed = true;
      clearRetry();
      stream?.destroy();
      stream = null;
      streamOpen = false;
    }
  };
}
