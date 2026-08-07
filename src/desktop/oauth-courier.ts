import { createServer, type Server } from 'node:http';
import { log } from '../server/log';
import { callbackPageHtml } from '../server/pi/oauth-courier';
import { isLoopbackHost, loopbackFlow, type LoopbackFlow } from '../shared/oauth-redirect';

// The client's half of the OAuth callback courier.
//
// An OAuth flow started on a server that is somewhere else still ends in a
// browser on THIS machine, and the address that browser is redirected to is
// 127.0.0.1 — which, from where the browser is standing, means here, not the
// server. So the flow's listener is on the wrong computer, and the sign-in dies
// silently at the last step. This file is the fix: bind the port the flow
// announced, catch the browser, and hand what it brought back to the server,
// which replays it to the listener it has been holding open all along
// (src/server/pi/oauth-courier.ts).
//
// TWO THINGS DECIDE WHETHER IT ACTS AT ALL, and both are narrowings on purpose:
//
//   The server must be somebody else's process. When Stem starts its own server
//   — still the default install — the flow's listener is already on this
//   machine and already correct. A courier that raced it for the port would add
//   a way for a working sign-in to break and buy nothing; worse, both ends would
//   open a browser tab.
//
//   A sign-in must have been asked for HERE. `auth:event` is a broadcast: every
//   paired device sees the URL of a login somebody started on one of them. Only
//   the machine whose user pressed the button should open a browser or bind a
//   port, and the honest signal for that is an `auth:providerLogin` / `mcp:login`
//   call that went out of THIS client (see the wrapped table in ./proxy.ts).
//
// The listener is a socket on the user's own machine that accepts a request from
// a browser, so it is treated as a boundary rather than as plumbing: loopback
// only, one callback and then gone, a deadline whether or not anything arrives,
// and the flow's `state` checked before anything is forwarded. A page in the
// user's browser can reach a loopback port — it cannot read the reply, but it
// can make the request — and without the state check that is a way to feed
// Stem an authorization code for an account the user does not own.

/**
 * How long after asking for a sign-in an authorization URL is still believably
 * ours. The push follows the RPC within a second or two in practice (the flow
 * binds its port and announces the URL before it starts waiting); a minute is
 * slack for a slow discovery round trip, not a window worth widening.
 */
const ARM_WINDOW_MS = 60_000;

/**
 * How long to hold the port open for the browser. Matches the deadline the MCP
 * flow puts on the whole round trip, so the two cannot disagree about when a
 * sign-in has been abandoned.
 */
const FLOW_TIMEOUT_MS = 5 * 60_000;

export interface OAuthCourierDeps {
  /**
   * False when this process started the server itself — see the header. Nothing
   * below runs in that case; the courier still exists, so the call sites do not
   * have to know.
   */
  enabled: boolean;
  /** Hand a caught callback to the server (`auth:deliverCallback`). */
  deliver(redirectUri: string, params: Record<string, string>): Promise<unknown>;
  /** Open a URL in this machine's browser (`shell.openExternal`). */
  openExternal(url: string): void;
}

export interface OAuthCourier {
  /** A sign-in was requested from this client: expect its URL to follow. */
  expectSignIn(): void;
  /** An authorization URL arrived on a push. */
  offer(url: string): void;
  /** Drop any open listener (quit). */
  close(): void;
}

export function createOAuthCourier(deps: OAuthCourierDeps): OAuthCourier {
  /** Until when a pushed authorization URL is one this client asked for. */
  let armedUntil = 0;
  let listener: Server | null = null;
  let deadline: NodeJS.Timeout | null = null;

  function stop(): void {
    if (deadline) {
      clearTimeout(deadline);
      deadline = null;
    }
    const server = listener;
    listener = null;
    // close() only stops accepting; a browser holding the connection open would
    // otherwise keep the port bound past the end of the flow — and the next
    // sign-in wants that exact port back.
    server?.closeAllConnections();
    server?.close();
  }

  /**
   * Bind the address the flow announced and wait for one browser. A bind that
   * fails is logged and otherwise ignored: the browser still opens, and the
   * callback still lands wherever the port already leads — which, when the
   * "remote" server is in fact another process on this machine, is the flow's
   * own listener, i.e. the case where the courier was never needed. For a truly
   * remote server the user has pi's manual paste prompt, which every provider
   * flow offers alongside its callback server for exactly this situation.
   */
  function listen(flow: LoopbackFlow): void {
    stop();
    const server = createServer((req, res) => {
      // A page cannot read this reply, but a name that resolves to 127.0.0.1
      // could be used to send it a request with a foreign Host header. The
      // browser we are actually waiting for arrives at the address the redirect
      // named, so anything else is refused before it is looked at.
      if (!isLoopbackHost(req.headers.host) || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== flow.path) {
        res.writeHead(404).end();
        return;
      }
      const params: Record<string, string> = {};
      for (const [name, value] of reqUrl.searchParams) params[name] = value;
      // Wrong state: somebody else's callback, or a page trying its luck. Answer
      // it, keep listening — closing here would let a single guess cancel a
      // sign-in the user is halfway through.
      if (flow.state && params.state !== flow.state) {
        log('oauth', 'ignored a callback that did not match the sign-in', { path: flow.path });
        res.writeHead(400, { 'content-type': 'text/html' }).end(callbackPageHtml(true));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(callbackPageHtml(!!params.error));
      // One callback, then the port goes back: everything after this belongs to
      // the next sign-in, not this one.
      stop();
      // Never the parameters — `code` is a credential, and this log file is
      // ordinary readable state.
      log('oauth', 'caught an OAuth callback for the server', { port: flow.port, path: flow.path });
      void deps.deliver(flow.redirectUri, params).then(
        (result) => {
          const answer = result as { ok?: boolean; error?: string } | null;
          if (answer && answer.ok === false) log('oauth', 'the server refused the callback', { error: answer.error });
        },
        (e: unknown) => log('oauth', 'could not hand the callback to the server', { error: String((e as Error)?.message ?? e) })
      );
    });
    server.on('error', (e) => {
      if (listener === server) listener = null;
      log('oauth', 'could not bind the callback port', {
        port: flow.port,
        error: String((e as Error)?.message ?? e)
      });
    });
    listener = server;
    server.listen(flow.port, flow.host, () => {
      log('oauth', 'listening for an OAuth callback', { port: flow.port, path: flow.path });
    });
    deadline = setTimeout(() => {
      log('oauth', 'gave up waiting for the OAuth callback', { port: flow.port });
      stop();
    }, FLOW_TIMEOUT_MS);
    deadline.unref?.();
  }

  return {
    expectSignIn() {
      if (!deps.enabled) return;
      armedUntil = Date.now() + ARM_WINDOW_MS;
    },
    offer(url) {
      if (!deps.enabled || Date.now() > armedUntil) return;
      // One URL per request. A flow announces exactly one; anything after it is
      // another device's sign-in, or a server saying something it was not asked
      // to say, and neither should be able to make this machine open tabs.
      armedUntil = 0;
      // On a remote server nothing else will: `openExternal` there is a no-op,
      // because a machine in a data centre has no browser to open.
      deps.openExternal(url);
      const flow = loopbackFlow(url);
      if (flow) listen(flow);
    },
    close: stop
  };
}
