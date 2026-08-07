import { request as httpRequest } from 'node:http';
import { log } from '../server/log';
import type {
  AuthUiEvent,
  BackendEventEnvelope,
  QuickChatSettings,
  StartTurnInput,
  TurnAttachment
} from '../shared/types';
import { uploadFile } from './file-transfer';
import type { OAuthCourier } from './oauth-courier';
import { updateClientQuickChat, withClientSettings } from './settings';

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
//   client:info                                  this client's device id and where
//                                                it is connected — the server has
//                                                no notion of who is calling
//   client:pair, client:useBuiltIn               changing which server this client
//                                                talks to. Answered here for the
//                                                obvious reason: the server being
//                                                replaced cannot broker it
//   releaseNotes:get, releaseNotes:markSeen,     the "what's new" popup, decided
//   settings:updateReleaseNotes                  from the version installed HERE
//                                                and the notes shipped beside it
//   dialog:openFiles, dialog:openDirectory       native pickers
//   files:reveal, files:preview                  shell.showItemInFolder; preview
//                                                reads an image path that, by
//                                                construction, is on the client's
//                                                own disk (the `att.path` branch
//                                                of renderer/attachments.ts)
//   files:download                               GET /files/<rel>, saved into this
//                                                machine's Downloads folder and
//                                                shown there. Not an RPC: the file
//                                                streams, and where it lands is a
//                                                fact about this desk
//   cfolders:reveal, cfolders:revealWorkspace    shell.showItemInFolder. The PATH
//                                                comes from the server, so these
//                                                only mean anything when both
//                                                halves share a disk — and refuse
//                                                when they don't (desktop/local)
//   quickchat:*, main:reveal                     the overlay/HUD windows
//   quickchat:handoffSnapshot, renderer:ready    ipcMain.on, not invoke
//   getPathForFile                               webUtils, not a channel at all
//   pushes: quickchat:focus/adopt/sessionStarted/status/handoffRequest,
//           hud:playChime
//
//   They live in desktop/local/, desktop/quickchat/ and desktop/ipc-bridge.ts.
//
// WRAPPED — client behavior AND a server call, in a fixed order. They are
// declared as data below rather than special-cased at the call site on purpose:
// an ad-hoc `if (channel === …)` in the invoke path is how the next one appears
// without anybody deciding to add it.
//
//   chats:open                 the sidebar opening the overlay's live thread is an
//                              implicit hand-off. It runs HERE and FIRST — capture
//                              the snapshot, flip ownership through the barrier,
//                              hide the overlay, replay the buffered events — and
//                              only then is the open forwarded. Refusing it throws
//                              before anything is sent, which is how its two error
//                              strings still reach the renderer unchanged.
//   every settings:* channel   they all answer with the WHOLE settings document,
//   + auth:completeOnboarding  and part of that document lives on this machine
//                              (see ./settings.ts). So every one of them is
//                              merged on the way back — not just settings:get,
//                              or the next unrelated toggle would hand the
//                              renderer a document with the hotkey reset.
//   settings:updateQuickChat   the same merge, plus the two things that are not
//                              settings once they leave the file: the global
//                              accelerator (a grab on an OS) and the overlay's
//                              cached preferences. The machine's half of the
//                              patch is stored only after the server's half has
//                              landed, so a failed call changes neither side.
//   auth:providerLogin,        a sign-in ends in a browser, and the browser is
//   mcp:login                  HERE. Both do nothing but tell the OAuth courier
//                              that the authorization URL about to arrive on the
//                              push stream is one this machine asked for — the
//                              stream is a broadcast, and every other device
//                              paired to the same server sees it too.
//   backend:startTurn,         both carry paths to files on THIS disk, which is
//   files:add                  only a thing the server can read when it is on
//                              this disk too. When it isn't, the bytes are
//                              streamed up first and the paths are replaced with
//                              handles to them — see attachmentsForServer(). The
//                              REMOTE case only: a local install keeps handing
//                              over paths, because copying every pasted
//                              screenshot through loopback to prove a point
//                              would be a cost with nothing on the other side
//                              of it.
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
 * machine and can refuse the call by throwing; anything it RETURNS replaces the
 * arguments that go on the wire. `after` runs once the server has answered, with
 * what it answered, and anything it returns replaces that answer on the way to
 * the renderer. Either may return nothing to leave its side alone.
 */
export interface WrappedChannel {
  before?: (args: unknown[]) => Promise<unknown[] | void> | unknown[] | void;
  after?: (args: unknown[], result: unknown) => unknown;
}

const mergeSettingsAnswer: WrappedChannel = { after: (_args, result) => withClientSettings(result) };

/**
 * Channels whose answer is the entire settings document, and which therefore all
 * need this machine's half merged back into it. `settings:updateQuickChat` is
 * absent because it has more to do than merge, and gets its own entry below.
 */
const SETTINGS_CHANNELS = [
  'settings:get',
  'auth:completeOnboarding',
  'settings:updateWebSearch',
  'settings:updateEscapeAction',
  'settings:updateMemory',
  'settings:updateSkills',
  'settings:updateChats',
  'settings:updateExec',
  'settings:updateCustomInstructions',
  'settings:updateRetrieval'
];

export interface ProxyDeps {
  /** Origin of the server, e.g. `http://127.0.0.1:52413`. */
  url: string;
  /** This device's bearer token (the `desktop` role). */
  token: string;
  /**
   * False when the server runs in this very process, and therefore reads this
   * machine's disk. The one place that distinction changes what goes on the wire
   * (see the WRAPPED table above); everything else here is identical either way.
   */
  remote: boolean;
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
  /** Catches OAuth callbacks for a server that is not on this machine. */
  oauthCourier: OAuthCourier;
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

  const signInStarted: WrappedChannel = { before: () => deps.oauthCourier.expectSignIn() };

  /**
   * Replace every on-disk path in a set of attachments with a handle to bytes the
   * server now has. Pasted images (`dataBase64`) already travel in the envelope
   * and are left exactly as they are — they are small, they are already on the
   * wire, and uploading them separately would be strictly more work.
   *
   * A failure here is deliberately fatal to the call. The alternative is sending
   * the message with the attachment quietly missing, which reads to the user as
   * the assistant ignoring the thing they attached; throwing instead leaves the
   * message in the composer, with the reason on screen, ready to send again.
   */
  async function attachmentsForServer(atts: TurnAttachment[]): Promise<TurnAttachment[]> {
    return Promise.all(
      atts.map(async (att) => {
        if (!att.path) return att;
        return { ...att, path: await uploadFile({ url: base, token: deps.token }, att.path) };
      })
    );
  }

  /** The remote half of `backend:startTurn` and `files:add`; absent when local. */
  const uploadPaths: Record<string, WrappedChannel> = {
    'backend:startTurn': {
      before: async ([input]) => {
        const turn = input as StartTurnInput;
        if (!turn?.attachments?.length) return;
        return [{ ...turn, attachments: await attachmentsForServer(turn.attachments) }];
      }
    },
    'files:add': {
      before: async ([paths, subdir]) => {
        const list = paths as string[];
        if (!Array.isArray(list) || list.length === 0) return;
        const creds = { url: base, token: deps.token };
        return [await Promise.all(list.map((path) => uploadFile(creds, path))), subdir];
      }
    }
  };

  const wrapped: Readonly<Record<string, WrappedChannel>> = {
    'chats:open': {
      before: ([threadId]) => deps.threadOpened(threadId as string)
    },
    'auth:providerLogin': signInStarted,
    'mcp:login': signInStarted,
    ...(deps.remote ? uploadPaths : {}),
    ...Object.fromEntries(SETTINGS_CHANNELS.map((c) => [c, mergeSettingsAnswer])),
    'settings:updateQuickChat': {
      after: async ([patch], result) => {
        const p = patch as Partial<QuickChatSettings>;
        await updateClientQuickChat(p);
        const next = await withClientSettings(result);
        deps.applyQuickChatSettings(p, next.quickChat);
        return next;
      }
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
    // Quick Chat hand-off cancel the open it was called for, and what makes a
    // failed upload a failed send rather than a send without its attachment.
    let outgoing = args;
    if (hooks?.before) {
      const replaced = await hooks.before(args);
      if (Array.isArray(replaced)) outgoing = replaced;
    }
    const result = await post(channel, outgoing);
    if (!hooks?.after) return result;
    const replacement = await hooks.after(args, result);
    return replacement === undefined ? result : replacement;
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
      case 'backend:event': {
        const event = payload as BackendEventEnvelope;
        // MCP's OAuth sign-in announces its URL down here rather than on
        // `auth:event` — a different flow, in a different file, with the same
        // loopback callback problem (see ./oauth-courier.ts).
        if (event?.method === 'mcp/login/url') {
          const url = (event.params as { url?: unknown } | undefined)?.url;
          if (typeof url === 'string') deps.oauthCourier.offer(url);
        }
        deps.routeBackendEvent(event);
        return;
      }
      // Provider sign-in progress. The courier reads the one event that carries
      // an address a browser will be sent to; everything about the push is
      // otherwise unchanged, including that the window still gets it.
      case 'auth:event': {
        const event = payload as AuthUiEvent | undefined;
        if (event?.kind === 'auth-url') deps.oauthCourier.offer(event.url);
        deps.sendToMain(channel, payload);
        return;
      }
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
