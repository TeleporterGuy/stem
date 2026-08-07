import { host } from './host';
import { startServer } from './index';
import { readDevices } from './transport/auth';
import { createPairingCode } from './transport/pairing';

// `stem-server`: Stem with no windows, run by plain `node`.
//
// Everything interesting is in ./index.ts — this file is only the process. It
// resolves the one thing a host has to decide (where state lives), starts the
// server, prints where it is listening, and translates SIGINT/SIGTERM into a
// graceful shutdown.
//
// It also carries the one subcommand a headless deployment cannot do without:
//
//   stem-server pair [--label "Vlado's MacBook"]
//
// which prints a one-shot code a device can spend on POST /pair. It runs WITHOUT
// starting a server — it only writes to the pairing store — so it is safe to run
// as `docker compose exec stem node dist/main/server.js pair` beside a container
// that is already serving.
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

/** `--label "…"` or `--label=…`; the device's name in Settings → Devices. */
function labelArg(argv: string[]): string {
  const inline = argv.find((a) => a.startsWith('--label='));
  if (inline) return inline.slice('--label='.length);
  const flag = argv.indexOf('--label');
  return flag !== -1 ? (argv[flag + 1] ?? '') : '';
}

/** Print a pairing code and say how long it lives. Shared by the subcommand and first boot. */
async function printPairingCode(label: string, why: string): Promise<void> {
  const { code, expiresAt } = await createPairingCode(label);
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  console.log(`\n[stem-server] ${why}`);
  console.log(`[stem-server] pairing code: ${code}`);
  console.log(`[stem-server] valid for ${minutes} minutes, one device, one use.\n`);
}

async function pairCommand(): Promise<void> {
  console.log(`[stem-server] state ${host().stateRoot()}`);
  await printPairingCode(labelArg(process.argv.slice(3)), 'enter this on the device you are pairing:');
}

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

  // Nothing can talk to a server with an empty registry, and there is no window
  // here to ask in — so a first boot says how to get in without being asked.
  // Harmless on a machine whose desktop is about to mint itself a record off the
  // shared state root: the code simply expires unused.
  if ((await readDevices()).length === 0) {
    await printPairingCode('Paired device', 'no devices are paired yet. To connect one:');
  }

  // Spawn pi and connect MCP now. The desktop defers this until its first window
  // has painted; there is no window here, so there is nothing to defer behind.
  void handle.prewarm();
}

const command = process.argv[2];
const run = command === 'pair' ? pairCommand() : main();

run.catch((err: unknown) => {
  console.error(`[stem-server] ${command === 'pair' ? 'could not create a pairing code' : 'failed to start'}:`, err);
  process.exit(1);
});
