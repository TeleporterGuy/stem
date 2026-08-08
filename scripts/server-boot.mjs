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
// It then does the migration for real, because the migration is a thing that
// happens between PROCESSES and cannot be told apart from a working one inside a
// single test runner: export the running server's state to an archive, refuse to
// unpack it over itself, unpack it into a state root that has never been used,
// and serve THAT — pairing a fresh device with it and asking it for the folder
// the first server made.
//
//   npm run test:server          # locally, same thing CI runs
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
/** Where the exported Stem is unpacked — a state root that has never been used. */
const secondState = join(sandbox, 'moved');
const archive = join(sandbox, 'stem-export.tar');
/** The passphrase file, standing in for the Docker secret at /run/secrets/stem_key. */
const keyFile = join(sandbox, 'stem_key');

// dist + package.json and nothing else. package.json comes along for its `type:
// "module"` (without it Node reads the bundle as CommonJS) and its version.
cpSync(join(root, 'dist'), join(appDir, 'dist'), { recursive: true });
cpSync(join(root, 'package.json'), join(appDir, 'package.json'));

// A clean environment: the developer running this locally may well have STEM_*
// pointing at their real profile, and the server must not touch it. Written as a
// function of the state root because there are two of them now — the one this
// boots, and the one the export is unpacked into further down.
function envFor(dir) {
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    STEM_STATE_DIR: dir,
    STEM_RECALL_DB: join(dir, 'recall.sqlite'),
    STEM_FILES_DIR: join(dir, 'files'),
    STEM_TASKS_STORE: join(dir, 'tasks.json'),
    STEM_E2E: '1'
  };
}
const env = envFor(stateDir);

/**
 * Run one of stem-server's subcommands to completion and hand back what it said.
 * They are the deployment's whole interface — a person on an ssh session types
 * these — so they are exercised as processes, with their exit codes, and not by
 * calling into the module they happen to live in.
 */
function runServerCommand(args, commandEnv) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['dist/main/server.js', ...args], {
      cwd: appDir,
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let text = '';
    for (const pipe of [proc.stdout, proc.stderr]) {
      pipe.setEncoding('utf8');
      pipe.on('data', (chunk) => {
        text += chunk;
      });
    }
    proc.on('exit', (code) => resolve({ code, output: text }));
  });
}

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
 * A credential, obtained the way a device with no access to this server's disk
 * has to: by spending the one-shot code the server printed when it found its
 * registry empty. That makes the whole pairing path — code minted at boot, POST
 * /pair, a device record written, a token that then works — part of the tripwire
 * rather than something only the desktop's own tests ever walk.
 *
 * The registry itself is checked afterwards, and what matters is what is NOT in
 * it: no token, anywhere, in any record.
 */
async function pair() {
  // The banner is printed just after the listening line waitForBoot() returned on.
  const deadline = Date.now() + 10_000;
  let code = null;
  while (!code && Date.now() < deadline) {
    code = /\[stem-server\] pairing code: (\S+)/.exec(output)?.[1] ?? null;
    if (!code) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!code) fatal('the server booted with an empty registry but printed no pairing code');
  const res = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok || !body.result?.token) {
    fatal(`POST /pair refused the code the server itself printed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

const grant = await pair();
check('POST /pair mints a device for a valid code', typeof grant.token === 'string' && !!grant.deviceId);

// A code is spent when it is used. Replaying the same one must not produce a
// second device — that is the difference between a pairing code and a password.
const replay = await fetch(`${url}/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: /\[stem-server\] pairing code: (\S+)/.exec(output)[1] }),
  signal: AbortSignal.timeout(30_000)
});
check('a spent pairing code is refused the second time', replay.status === 401, `HTTP ${replay.status}`);

// The property the whole registry rewrite is for: what is on disk cannot be used
// to authenticate. If a token ever appears here again, this check is the alarm.
const registry = JSON.parse(readFileSync(join(stateDir, 'devices.json'), 'utf8'));
check('the registry holds a record for the paired device', registry.devices.length === 1, `${registry.devices.length} records`);
check(
  'no record contains a token — only its hash',
  registry.devices.every((d) => !d.token && /^[0-9a-f]{64}$/.test(d.tokenHash ?? '')),
  JSON.stringify(registry.devices[0] ?? {}).slice(0, 120)
);
check(
  'the token is not recoverable from the registry',
  !readFileSync(join(stateDir, 'devices.json'), 'utf8').includes(grant.token)
);

const auth = { authorization: `Bearer ${grant.token}` };

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
  /** `event:`-named frames — what the stream says about itself, not about a turn. */
  const controls = [];
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
          // `<epoch>.<seq>`: the sequence restarts at 1 on every boot, so the
          // frames of one run have to be distinguishable from another's.
          const id = /^id: \w+\.(\d+)$/m.exec(block)?.[1];
          // Control frames (`snapshot`, `resync`) are about the stream rather
          // than about anything that happened, and are collected separately —
          // they carry no {channel, payload} and no place in the sequence.
          const name = /^event: (\S+)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (name) controls.push({ name, data: parsed });
              else events.push({ id: id ? Number(id) : null, ...parsed });
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
  check('GET /channels answers with the registry', Array.isArray(channels) && channels.length > 50, `${channels.length} channels`);
  for (const expected of ['settings:get', 'chats:list', 'backend:startTurn', 'memory:activeFacts']) {
    check(`  registry exposes ${expected}`, channels.includes(expected));
  }
  check(
    'client-owned channels are absent from the registry',
    !channels.includes('dialog:openFiles') &&
      !channels.includes('quickchat:reveal') &&
      !channels.includes('releaseNotes:get'),
    'a server has no native picker, no overlay window and no build of its own to announce'
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
  // The stream announces what is already running before it sends anything that
  // happened — the whole reason a client can come back mid-turn and know it.
  const snapshot = controls[0];
  check(
    'the stream opens with a live-turn snapshot',
    snapshot?.name === 'snapshot' && Array.isArray(snapshot.data?.liveTurns),
    `${controls.length} control frame(s), first ${snapshot?.name ?? 'none'}`
  );

  const listed = await rpc('chats:list');
  check('the thread joined the chat list', (listed.body?.result?.chats ?? []).some((c) => c.threadId === threadId));

  // -- and the gates are on --
  const anonymous = await rpc('settings:get', [], { headers: {} });
  check('an unauthenticated call is refused', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const unknown = await rpc('definitely:not:a:channel');
  check('an unregistered channel is refused', unknown.status >= 400 && unknown.body?.ok !== true, `HTTP ${unknown.status}`);

  // -- something worth carrying, made through the transport --
  const folder = await rpc('folders:create', ['Moved with me', null]);
  check(
    'folders:create makes a folder',
    folder.status === 200 && (folder.body?.result?.folders ?? []).some((f) => f.name === 'Moved with me'),
    JSON.stringify(folder.body?.error ?? folder.body?.result ?? '').slice(0, 120)
  );
  // And one file put where the user's Files live, because a folder is a row in a
  // JSON file and a file is bytes with a mode on them.
  mkdirSync(join(stateDir, 'workspace', 'files'), { recursive: true });
  writeFileSync(join(stateDir, 'workspace', 'files', 'carried.txt'), 'this should survive the move\n');

  // -- the export, taken WHILE the server is running --
  //
  // Which is the normal case and the awkward one: recall.sqlite has an open
  // write-ahead log at this moment, so this is the check that the snapshot the
  // exporter takes is a database and not a torn copy of one. Running it as its
  // own process is the other half — `stem-server export` has to work on a machine
  // with no Electron, which is the machine it will actually be run on.
  writeFileSync(keyFile, 'a passphrase for the container\n', { mode: 0o600 });
  const exported = await runServerCommand(['export', archive, '--key-file', keyFile], envFor(stateDir));
  check('stem-server export writes an archive', exported.code === 0, exported.output.slice(-200));
  check('the archive exists', existsSync(archive), archive);
  check('the export says what it left behind', /left behind on purpose/.test(exported.output));
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
}

// -- the move, in three more processes ----------------------------------------
//
// The archive written above, unpacked into a state root that has never been used,
// and then SERVED. Nothing in this section touches the first server: it is over,
// and what is left is a file. That is the whole claim the export makes — you can
// pick Stem up, put it somewhere else, and it is still your Stem — and the only
// way to check it is to finish the journey.

if (existsSync(archive)) {
  // Refusing first. Unpacking over a state root somebody has used would merge two
  // Stems file by file, so the refusal is not a nicety, and the message has to
  // name what it found or nobody can act on it.
  const onTop = await runServerCommand(['import', archive, '--key-file', keyFile], envFor(stateDir));
  check('import refuses a state root that has been used', onTop.code !== 0, `exit ${onTop.code}`);
  check('  and says what it found there', /it already has .+ in it/.test(onTop.output), onTop.output.slice(-200));

  const imported = await runServerCommand(['import', archive, '--key-file', keyFile], envFor(secondState));
  check('import unpacks into an empty state root', imported.code === 0, imported.output.slice(-300));
  check(
    '  and says pairing is the next thing to do',
    /stem-server pair/.test(imported.output),
    imported.output.slice(-200)
  );

  // What must NOT have travelled. The registry and this client's credential are
  // the two that would be actively wrong on another machine.
  for (const absent of ['devices.json', 'client.json', 'server.json', 'stem.log']) {
    check(`  ${absent} did not travel`, !existsSync(join(secondState, absent)));
  }
  check(
    '  the Files folder did',
    readFileSync(join(secondState, 'workspace', 'files', 'carried.txt'), 'utf8').trim() === 'this should survive the move'
  );

  // The database the first server was writing to while the snapshot was taken.
  // A torn copy opens and answers nothing; this asks it for the same number of
  // rows the original had.
  const rowsIn = (dir) => {
    const db = new DatabaseSync(join(dir, 'recall.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT count(*) AS n FROM messages').get().n;
    } finally {
      db.close();
    }
  };
  const before = rowsIn(stateDir);
  check('the memory database survived being copied out from under a live server', rowsIn(secondState) === before, `${before} messages`);

  // -- and now serve it --
  const second = spawn(process.execPath, ['dist/main/server.js'], {
    cwd: appDir,
    env: envFor(secondState),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let secondOutput = '';
  for (const pipe of [second.stdout, second.stderr]) {
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk) => {
      secondOutput += chunk;
      process.stdout.write(`  [moved] ${chunk}`);
    });
  }
  let secondExited = null;
  second.on('exit', (code, signal) => {
    secondExited = { code, signal };
  });
  process.on('exit', () => {
    if (!secondExited) second.kill('SIGKILL');
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let secondUrl = null;
  while (!secondUrl && Date.now() < deadline && !secondExited) {
    secondUrl = /\[stem-server\] listening on (\S+)/.exec(secondOutput)?.[1] ?? null;
    if (!secondUrl) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('the imported Stem boots', !!secondUrl, secondUrl ? '' : `exited ${secondExited?.code ?? 'never listened'}`);

  if (secondUrl) {
    // An empty registry is what makes this print a code at all — which is the
    // strongest available evidence that no device came along with the archive.
    let movedCode = null;
    const codeDeadline = Date.now() + 10_000;
    while (!movedCode && Date.now() < codeDeadline) {
      movedCode = /\[stem-server\] pairing code: (\S+)/.exec(secondOutput)?.[1] ?? null;
      if (!movedCode) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('the imported Stem has nothing paired with it yet', !!movedCode);

    if (movedCode) {
      const paired = await fetch(`${secondUrl}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: movedCode }),
        signal: AbortSignal.timeout(30_000)
      });
      const grantThere = (await paired.json().catch(() => null))?.result;
      check('a device can be paired with it', !!grantThere?.token);

      if (grantThere?.token) {
        const res = await fetch(`${secondUrl}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${grantThere.token}` },
          body: JSON.stringify({ channel: 'chats:list', args: [] }),
          signal: AbortSignal.timeout(30_000)
        });
        const folders = (await res.json().catch(() => null))?.result?.folders ?? [];
        check(
          'the moved Stem serves the state that travelled with it',
          folders.some((f) => f.name === 'Moved with me'),
          JSON.stringify(folders).slice(0, 160)
        );
      }
    }
  }

  const secondStopped = new Promise((resolve) => second.once('exit', resolve));
  second.kill('SIGTERM');
  await Promise.race([secondStopped, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (!secondExited) second.kill('SIGKILL');
}

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n[server-boot] ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
