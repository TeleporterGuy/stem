// Starting `stem-server` as its own process, for the E2E variant that proves the
// split is real — and for manufacturing the network it will eventually run over.
//
// Two processes, one machine. The server is dist/main/server.js under plain
// `node` — the same entry the boot tripwire uses and the same one a VPS would run
// — and the Electron app is launched with STEM_SERVER_URL pointing at it, so it
// starts no server of its own and reaches everything over HTTP/SSE.
//
// THE APP DOES NOT TALK TO THE SERVER DIRECTLY. It talks to a proxy this file
// owns, which forwards to the server and can be told to misbehave: add latency,
// cut every connection mid-stream, or let the server be SIGKILLed underneath it.
// That is here because of how Phase 2 is sequenced — everything is built and made
// green against a server on the same machine, and the VPS move is the last step,
// which is exactly the order that hides the bugs only a real network produces. A
// harness that can produce them locally is the compensation.
//
// The proxy has one consequence worth knowing: requests arrive at the server
// carrying the PROXY's host:port in their Host header, which the DNS-rebinding
// check would refuse. The server is therefore started with STEM_TRUSTED_HOSTS
// naming the proxy — the same knob Caddy's hostname will use in the deployed
// configuration, exercised here first.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A cold boot writes the workspace, the recall DB and the device registry. */
const BOOT_TIMEOUT_MS = 60_000;

export interface StemServerProcess {
  /** Origin the desktop should be pointed at — the proxy, not the server. */
  url: string;
  /** The server's own origin, for a test that wants to bypass the proxy. */
  directUrl: string;
  /**
   * A one-shot pairing code, scraped from the first-boot banner. The app is
   * launched with it (STEM_PAIRING_CODE), so every run of this configuration
   * pairs for real rather than reading a credential off the shared disk.
   */
  pairingCode: string | null;
  /** Everything the process has said, for a failure message worth reading. */
  output(): string;
  /** Delay every forwarded byte by `ms` in both directions. 0 = off. */
  setLatency(ms: number): void;
  /**
   * Destroy every connection through the proxy, as a flaky network or a restarted
   * reverse proxy would. The server survives; the client sees its event stream
   * end and its in-flight requests fail, and has to recover on its own.
   */
  cutConnections(): void;
  /**
   * Take the network away and leave it away, or give it back. `false` destroys
   * every live connection AND refuses new ones, which is the difference between
   * a blip and a closed laptop lid — cutConnections() alone is over before the
   * client's first reconnect, so nothing can be staged to happen while the client
   * is genuinely absent. The server runs on regardless, which is the whole point:
   * a turn keeps streaming into a buffer nobody is reading.
   */
  setReachable(reachable: boolean): void;
  /**
   * SIGKILL the server — no shutdown, no drain, exactly what a crashed or
   * OOM-killed container does. `restart()` brings it back on the same port, so
   * the proxy (and therefore the app's URL) keeps pointing at something real.
   */
  kill(): Promise<void>;
  /** Start the server again on the port it had. Resolves when it is listening. */
  restart(): Promise<void>;
  /** SIGTERM and wait; SIGKILL if it will not go. Also closes the proxy. */
  stop(): Promise<void>;
}

export interface StemServerOptions {
  /** The state root to share with the app — its `--user-data-dir`. */
  stateDir: string;
  /** The STEM_* store overrides the app was launched with, verbatim. */
  storeEnv: Record<string, string>;
  /** false = the hermetic FakeBackend, matching the app's own STEM_E2E seam. */
  real: boolean;
}

/** Bind a proxy on an ephemeral loopback port and report which one it got. */
async function listenProxy(
  onConnection: (client: Socket) => void
): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the proxy did not bind a TCP port');
  return { server, port: address.port };
}

/**
 * Start the server behind its proxy and resolve once it says where it is
 * listening. Rejects — with everything the process printed — if it dies or never
 * binds, because a silent timeout here is indistinguishable from a hundred other
 * E2E flakes and this one would mean the headless build is broken.
 */
export async function startStemServer(opts: StemServerOptions): Promise<StemServerProcess> {
  const entry = join(PROJECT_ROOT, 'dist', 'main', 'server.js');

  /** Every socket pair currently forwarding, so cutConnections() can find them. */
  const live = new Set<Socket>();
  let latencyMs = 0;
  /** False while setReachable(false) is holding the network down. */
  let reachable = true;
  /** Resolved once the server has bound; sockets that arrive earlier wait on it. */
  let serverPort = 0;

  const { server: proxy, port: proxyPort } = await listenProxy((client) => {
    live.add(client);
    // Nothing legitimate connects before the server is up, but a client that
    // retries into the gap after kill() will — and dropping it is the honest
    // answer, since that is what a dead upstream does. Same for a client
    // reconnecting while the network is being held down.
    if (!serverPort || !reachable) {
      client.destroy();
      live.delete(client);
      return;
    }
    const upstream = connect(serverPort, '127.0.0.1');
    live.add(upstream);

    /** Forward one chunk, honouring the configured latency. */
    const relay = (from: Socket, to: Socket) => (chunk: Buffer) => {
      if (latencyMs <= 0) {
        to.write(chunk);
        return;
      }
      // Pause the source while the delay runs, so latency slows the stream
      // rather than just reordering it into one late burst.
      from.pause();
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
        if (!from.destroyed) from.resume();
      }, latencyMs);
    };

    client.on('data', relay(client, upstream));
    upstream.on('data', relay(upstream, client));

    const teardown = (): void => {
      live.delete(client);
      live.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('close', teardown);
      socket.on('error', teardown);
      socket.on('end', teardown);
    }
  });

  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  let child: ChildProcess | null = null;
  let output = '';
  let exited: { code: number | null; signal: string | null } | null = null;

  /**
   * Spawn the server. `port` is 0 on the first boot, the previous one after that.
   * Returns the child and where its output starts, because a restart's banner has
   * to be found in the NEW output — the previous boot's is still in the buffer,
   * and matching it would report "listening" before the port had been rebound.
   */
  function spawnServer(port: number): { child: ChildProcess; from: number } {
    exited = null;
    const from = output.length;
    const next = spawn(process.execPath, [entry], {
      // The repo root: host().appRoot() defaults to the working directory, and the
      // server reads RELEASE_NOTES.md and its bundled pi assets relative to it.
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        // The whole point: the same state root the app is using, so both halves see
        // one settings.json, one recall DB, and one device registry.
        STEM_STATE_DIR: opts.stateDir,
        // Requests arrive through the proxy and carry its address; without this
        // the rebinding check refuses every one of them.
        STEM_TRUSTED_HOSTS: `127.0.0.1:${proxyPort}`,
        ...(port ? { STEM_SERVER_PORT: String(port) } : {}),
        ...opts.storeEnv,
        ...(opts.real ? {} : { STEM_E2E: '1' })
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    next.stdout?.setEncoding('utf8');
    next.stderr?.setEncoding('utf8');
    next.stdout?.on('data', (chunk: string) => (output += chunk));
    next.stderr?.on('data', (chunk: string) => (output += chunk));
    next.on('exit', (code, signal) => {
      exited = { code, signal };
    });
    return { child: next, from };
  }

  /** Wait for the listening banner printed after `from`, and report its port. */
  async function waitForBoot(from: number): Promise<number> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      const url = /\[stem-server\] listening on (\S+)/.exec(output.slice(from))?.[1];
      if (url) return Number(new URL(url).port);
      if (exited) {
        throw new Error(
          `stem-server exited before it listened (code ${exited.code}, signal ${exited.signal}).\n${output}`
        );
      }
      if (Date.now() > deadline) {
        child?.kill('SIGKILL');
        throw new Error(`stem-server never listened within ${BOOT_TIMEOUT_MS}ms.\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const first = spawnServer(0);
  child = first.child;
  serverPort = await waitForBoot(first.from);

  // The pairing banner is printed just after the listening line, and only when
  // the registry is empty — which a fresh state root's is. Waiting for it here
  // (rather than reading `output` the instant boot finishes) is what makes the
  // code reliably available to hand the app.
  const codeDeadline = Date.now() + 5_000;
  let pairingCode: string | null = null;
  while (!pairingCode && Date.now() < codeDeadline) {
    pairingCode = /\[stem-server\] pairing code: (\S+)/.exec(output)?.[1] ?? null;
    if (!pairingCode) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const stopChild = async (signal: NodeJS.Signals): Promise<void> => {
    const current = child;
    if (!current || exited) return;
    const done = new Promise<void>((resolve) => current.once('exit', () => resolve()));
    current.kill(signal);
    const stopped = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
    ]);
    if (!stopped) current.kill('SIGKILL');
  };

  const cutConnections = (): void => {
    for (const socket of live) socket.destroy();
    live.clear();
  };

  return {
    url: proxyUrl,
    directUrl: `http://127.0.0.1:${serverPort}`,
    pairingCode,
    output: () => output,
    setLatency(ms) {
      latencyMs = Math.max(0, ms);
    },
    cutConnections,
    setReachable(next) {
      reachable = next;
      if (!next) cutConnections();
    },
    async kill() {
      // Cut the sockets too: an upstream that is gone would otherwise leave the
      // client waiting on a connection nobody is ever going to answer.
      await stopChild('SIGKILL');
      cutConnections();
    },
    async restart() {
      const next = spawnServer(serverPort);
      child = next.child;
      await waitForBoot(next.from);
    },
    async stop() {
      await stopChild('SIGTERM');
      cutConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  };
}
