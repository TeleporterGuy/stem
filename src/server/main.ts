import { host } from './host';
import { startServer } from './index';

// `stem-server`: Stem with no windows, run by plain `node`.
//
// Everything interesting is in ./index.ts — this file is only the process. It
// resolves the two things a host has to decide (where state lives, where the
// built client bundle lives), starts the server, prints where it is listening,
// and translates SIGINT/SIGTERM into a graceful shutdown.
//
// Its real job is to be the tripwire. `src/server` must not import Electron,
// and an ESLint rule is not proof of that: a transitive import through a barrel
// file satisfies every static rule anybody writes and still resolves at runtime
// because the desktop bundle happens to have Electron underneath it. A process
// with no `electron` module to resolve is proof. That is why scripts/server-boot.mjs
// runs this entry in CI on every push, and why this file exists from day one
// rather than when somebody first wants to deploy it (see the Phase 1 plan,
// step 5).
//
// Phase 1 puts this process on the same machine as the desktop that talks to it,
// sharing one state root. No TLS, no remote host, no service manager — those are
// Phase 2, and the loopback-only bind in transport/server.ts is what keeps this
// from being deployed as if they had already happened.

async function main(): Promise<void> {
  // Registered BEFORE startServer, which is load-bearing twice over: the host
  // shim defers its own signal handling to whoever got there first (see
  // headlessHost.onShutdown), and a Ctrl-C during a slow boot would otherwise
  // find no handler at all and leave a half-started backend behind.
  let stopping: Promise<void> | null = null;
  const stop = (signal: string, shutdown: () => Promise<void>): void => {
    if (stopping) return; // a second Ctrl-C while draining
    console.log(`[stem-server] ${signal} — shutting down`);
    stopping = shutdown()
      .catch((err: unknown) => {
        console.error('[stem-server] shutdown failed:', err);
      })
      .then(() => {
        process.exit(0);
      });
  };
  // Until startServer resolves there is nothing to drain, but the signal still
  // has to be answered — a listener that does nothing would hang the process.
  let shutdown = async (): Promise<void> => {};
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => stop(signal, () => shutdown()));
  }

  const stateRoot = host().stateRoot();
  console.log(`[stem-server] state ${stateRoot}`);

  const handle = await startServer({
    // Alternate profiles are a desktop affordance (`--fresh` / `--profile`);
    // headless, the state root IS the profile and STEM_STATE_DIR picks it.
    alternateProfile: false,
    // No Vite dev server behind a standalone run, and nothing to serve either:
    // the transport has no static route since the web client was removed.
    devUrl: null
  });
  shutdown = () => handle.shutdown();

  // The one line a supervisor, a test, or a person needs. Printed on stdout
  // rather than logged, because it is this process's interface: scripts/server-boot.mjs
  // and the external-server E2E harness both wait for it.
  console.log(`[stem-server] listening on ${handle.endpoint.url}`);

  // Spawn pi and connect MCP now. The desktop defers this until its first window
  // has painted; there is no window here, so there is nothing to defer behind.
  void handle.prewarm();
}

main().catch((err: unknown) => {
  console.error('[stem-server] failed to start:', err);
  process.exit(1);
});
