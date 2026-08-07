// The headless tripwire: boot `stem-server` under plain `node`, on a filesystem
// with no `electron` to resolve, and make it answer real calls over its real
// transport.
//
// WHY THIS EXISTS, and why the ESLint rule next to it is not enough.
//
// `src/server` must not depend on Electron — that is the whole property the
// Phase 1 split bought, and the thing that makes a VPS deployment a packaging
// question rather than a rewrite. A lint rule checks import specifiers, which
// means it sees `import { app } from 'electron'` and nothing else: an `electron`
// import reached through a barrel file, a re-export, or a dynamic
// `await import('electron')` satisfies every static rule anybody writes. It also
// only ever sees the files it was pointed at, so a dependency that grows an
// Electron import in a later npm install is invisible to it.
//
// A process is not fooled by any of that. This script copies the BUILT output
// into a throwaway directory with no node_modules anywhere above it — so
// `electron` genuinely cannot be resolved, exactly as on a server — starts
// dist/main/server.js there with plain `node`, and then talks to it. If anything
// under src/server has picked up Electron by any route, the boot dies here.
//
// The copy is the load-bearing part. Running dist/main/server.js from inside the
// repo would find node_modules/electron, whose plain-Node export is a harmless
// path string — so a stray import would resolve, hand back `undefined` for `app`,
// and fail much later somewhere unrelated. The tripwire has to be a machine that
// does not have Electron on it.
//
// Hermetic by construction: STEM_E2E puts the scripted FakeBackend behind the
// seam, so there is no pi spawn, no auth and no network. What is under test is
// the server's boot path and its transport, not the model.
//
//   npm run test:server          # locally, same thing CI runs
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(root, 'dist', 'main', 'server.js');

/** Generous: a cold boot writes the workspace, the recall DB and the registry. */
const BOOT_TIMEOUT_MS = 60_000;
/** How long to wait for the turn started over /rpc to stream and settle. */
const TURN_TIMEOUT_MS = 30_000;

const checks = [];
let failed = 0;

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fatal(message) {
  console.error(`\n[server-boot] ${message}`);
  process.exit(1);
}

// -- the isolated machine -----------------------------------------------------

if (!existsSync(ENTRY)) {
  console.log('[server-boot] no dist/main/server.js — building first');
  const build = spawn('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) fatal('the build failed; nothing to boot');
}

const sandbox = mkdtempSync(join(tmpdir(), 'stem-server-boot-'));
const appDir = join(sandbox, 'app');
const stateDir = join(sandbox, 'state');

// dist + package.json and nothing else. package.json comes along for its `type:
// "module"` (without it Node reads the bundle as CommonJS) and its version.
cpSync(join(root, 'dist'), join(appDir, 'dist'), { recursive: true });
cpSync(join(root, 'package.json'), join(appDir, 'package.json'));

// A clean environment: the developer running this locally may well have STEM_*
// pointing at their real profile, and the server must not touch it.
const env = {
  PATH: process.env.PATH,
  HOME: sandbox,
  TMPDIR: process.env.TMPDIR,
  SystemRoot: process.env.SystemRoot,
  STEM_STATE_DIR: stateDir,
  STEM_RECALL_DB: join(stateDir, 'recall.sqlite'),
  STEM_FILES_DIR: join(stateDir, 'files'),
  STEM_TASKS_STORE: join(stateDir, 'tasks.json'),
  STEM_E2E: '1'
};

// Before booting anything: the built layout the main bundle's own sibling joins
// depend on. Several modules locate an artifact relative to `import.meta.url`
// (the embed/scan workers, recall-mcp-server, pi-node-shim, the bridge
// extension), which is only correct while every module of the main bundle sits
// directly in dist/main. Rollup emits shared chunks into a chunks/ subdirectory
// by default and hoists a module there the moment two entries share it — which
// is what the standalone server entry made possible. That failure surfaces at
// runtime as ERR_MODULE_NOT_FOUND for a file nobody wrote, on a path the e2e
// suite never walks, so it is asserted here where the build output is in hand.
const distMain = join(appDir, 'dist', 'main');
for (const rel of ['embed-worker.js', 'scan-worker.js', 'recall-mcp-server.js', 'pi/pi-node-shim.mjs', 'pi/stem-mcp-extension.mjs']) {
  check(`${rel} sits where its sibling join expects it`, existsSync(join(distMain, rel)));
}
check(
  'no chunks/ subdirectory — sibling joins would resolve one level too deep from inside one',
  !existsSync(join(distMain, 'chunks'))
);

console.log(`[server-boot] booting ${join(appDir, 'dist/main/server.js')}`);
console.log(`[server-boot] state ${stateDir}`);

const child = spawn(process.execPath, ['dist/main/server.js'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(`  [server] ${chunk}`);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(`  [server] ${chunk}`);
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

// The finally block below stops the server on every path this script takes to its
// own end — but not on the paths taken FOR it. Ctrl-C, a killed CI step, or a
// closed terminal all end this process without unwinding, and the server, being a
// child rather than a process group, simply carries on: a stem-server left
// listening on a port with a pi backend under it, which is exactly what happened
// once and went unnoticed for half an hour. These handlers are the backstop.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!exited) child.kill('SIGKILL');
    process.exit(1);
  });
}
process.on('exit', () => {
  if (!exited) child.kill('SIGKILL');
});

/** The line stem-server prints once it is listening — its whole interface. */
function boundUrl() {
  return /\[stem-server\] listening on (\S+)/.exec(output)?.[1] ?? null;
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = boundUrl();
    if (url) return url;
    if (exited) {
      // The interesting failure. An `electron` import that survived into
      // src/server lands here, as ERR_MODULE_NOT_FOUND, before anything listens.
      fatal(
        `stem-server exited before it listened (code ${exited.code}, signal ${exited.signal}).\n` +
          'If that is ERR_MODULE_NOT_FOUND for "electron", something under src/server now imports it — ' +
          'directly or through something it imports. Route the capability through src/server/host instead.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fatal(`stem-server never printed a listening address within ${BOOT_TIMEOUT_MS}ms`);
}

const url = await waitForBoot();

// -- talking to it ------------------------------------------------------------

/**
 * The desktop's bearer token, read out of the registry the server just wrote.
 * The same move src/desktop/server-endpoint.ts makes: on one machine, sharing
 * one state root, the credential is simply on disk.
 */
function desktopToken() {
  const store = JSON.parse(readFileSync(join(stateDir, 'devices.json'), 'utf8'));
  const device = store.devices.find((d) => d.role === 'desktop');
  if (!device) fatal('the server booted without minting a desktop device record');
  return device.token;
}

const token = desktopToken();
const auth = { authorization: `Bearer ${token}` };

async function rpc(channel, args = [], { headers = auth } = {}) {
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ channel, args }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let sse = null;
try {
  // The event stream, opened BEFORE the turn that has to arrive on it.
  const events = [];
  const streamRes = await fetch(`${url}/events`, { headers: { ...auth, accept: 'text/event-stream' } });
  check('GET /events opens a stream', streamRes.status === 200, `HTTP ${streamRes.status}`);
  sse = streamRes.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await sse.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const id = /^id: (\d+)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (data) {
            try {
              events.push({ id: id ? Number(id) : null, ...JSON.parse(data) });
            } catch {
              // A partial frame is the reader's problem, not a failure.
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // The stream is torn down at the end of the run; that is not an error.
    }
  })();

  // -- the registry is the surface --
  const channelsRes = await fetch(`${url}/channels`, { headers: auth });
  const channels = (await channelsRes.json()).result ?? [];
  check('GET /channels answers the desktop role', Array.isArray(channels) && channels.length > 50, `${channels.length} channels`);
  for (const expected of ['settings:get', 'chats:list', 'backend:startTurn', 'memory:activeFacts']) {
    check(`  registry exposes ${expected}`, channels.includes(expected));
  }
  check(
    'client-owned channels are absent from the registry',
    !channels.includes('dialog:openFiles') && !channels.includes('quickchat:reveal'),
    'a server has no native picker and no overlay window'
  );

  // -- a handful of RPCs, over the real transport --
  const settings = await rpc('settings:get');
  check('settings:get returns the settings document', settings.status === 200 && !!settings.body?.result?.defaults, JSON.stringify(settings.body?.error ?? '').slice(0, 120));

  const status = await rpc('runtime:status');
  check('runtime:status answers', status.status === 200 && status.body?.ok === true);

  const chats = await rpc('chats:list');
  check('chats:list answers with an empty workspace', status.status === 200 && Array.isArray(chats.body?.result?.chats), `${chats.body?.result?.chats?.length ?? '?'} chats`);

  // -- a real turn, end to end, with the reply arriving on the SSE stream --
  const thread = await rpc('backend:createThread');
  const threadId = thread.body?.result;
  check('backend:createThread mints a thread', typeof threadId === 'string' && !!threadId, String(threadId));

  const turn = await rpc('backend:startTurn', [{ threadId, input: 'headless hello', surface: 'main' }]);
  check('backend:startTurn accepts a turn', turn.status === 200 && turn.body?.ok === true, JSON.stringify(turn.body?.error ?? '').slice(0, 120));

  const turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < turnDeadline && !events.some((e) => e.payload?.method === 'turn/completed')) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const backendEvents = events.filter((e) => e.channel === 'backend:event');
  check('the turn streamed back over SSE', backendEvents.length > 0, `${backendEvents.length} backend:event frames`);
  check('the turn completed', backendEvents.some((e) => e.payload?.method === 'turn/completed'));
  const ids = events.map((e) => e.id);
  check(
    'every SSE frame carries a monotonic id',
    ids.length > 0 && ids.every((id, i) => Number.isInteger(id) && (i === 0 || id > ids[i - 1])),
    `ids ${ids[0]}..${ids[ids.length - 1]}`
  );

  const listed = await rpc('chats:list');
  check('the thread joined the chat list', (listed.body?.result?.chats ?? []).some((c) => c.threadId === threadId));

  // -- and the gates are on --
  const anonymous = await rpc('settings:get', [], { headers: {} });
  check('an unauthenticated call is refused', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const unknown = await rpc('definitely:not:a:channel');
  check('an unregistered channel is refused', unknown.status >= 400 && unknown.body?.ok !== true, `HTTP ${unknown.status}`);
} finally {
  // -- and it stops when asked --
  await sse?.cancel().catch(() => {});
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stoppedCleanly = await Promise.race([
    stopped.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15_000))
  ]);
  if (!stoppedCleanly) child.kill('SIGKILL');
  check('SIGTERM shuts the server down', stoppedCleanly);
  check('shutdown was graceful', /\[stem-server\] SIGTERM — shutting down/.test(output));
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n[server-boot] ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
