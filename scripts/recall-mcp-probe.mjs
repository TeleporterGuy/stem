// Drives the Stem Recall MCP server over stdio to verify the protocol handshake,
// a real search_past_chats call, the FTS-only fallback (no embed socket), and the
// hybrid semantic path against a fake embed endpoint speaking the
// embed-endpoint.ts protocol. Seeds a throwaway DB via the compiled store, then
// spawns the server exactly as the pi backend would (Electron-as-node).
//
// Run (after compiling modules into .recall-build — see recall-verify.mjs header):
//   STEM_RECALL_DB="$PWD/.recall-build/mcp.sqlite" ELECTRON_RUN_AS_NODE=1 \
//     ./node_modules/.bin/electron scripts/recall-mcp-probe.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const store = require(fileURLToPath(new URL('../.recall-build/main/recall/store.js', import.meta.url)));
// The server is TS since v3 (shares search-core.ts with main) — spawn the
// compiled artifact from the same .recall-build the store came from.
const serverPath = fileURLToPath(new URL('../.recall-build/main/recall/mcp-server-main.js', import.meta.url));

const dbPath = process.env.STEM_RECALL_DB;
if (!dbPath) {
  console.log('FAIL: set STEM_RECALL_DB');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${dbPath}${suffix}`, { force: true });
  } catch {}
}

const PROBE_MODEL = 'probe-model';
const PROBE_TOKEN = 'probe-token';
const SOCK = fileURLToPath(new URL('../.recall-build/embed-probe.sock', import.meta.url));

store.recordMessage({
  threadId: 'A',
  turnId: 't1',
  role: 'assistant',
  text: 'Your UZ Gent cardiology appointment is on June 30; Dr. Janssens flagged elevated cholesterol.'
});
store.recordMessage({ threadId: 'B', role: 'user', text: 'unrelated chat about pizza recipes' });
// Semantic-only target: zero lexical overlap with the Slovak query used below;
// its vector matches the fake endpoint's canned query vector exactly.
store.recordMessage({ threadId: 'C', role: 'user', text: 'My rosemary on the balcony is dying from overwatering.' });
const rosemaryId = store.getMessagesForEmbedding(0, 10).find((m) => /rosemary/.test(m.text)).id;
store.upsertMessageVector(rosemaryId, PROBE_MODEL, Float32Array.from([1, 0]));
store.closeForTest();

// Fake embed endpoint: one request per connection, newline-delimited JSON —
// mirrors embed-endpoint.ts (returns [1,0] for any query text).
try {
  rmSync(SOCK, { force: true });
} catch {}
const fakeEndpoint = createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const req = JSON.parse(buf.slice(0, nl));
    const body =
      req.token === PROBE_TOKEN && req.op === 'embed'
        ? { id: req.id, ok: true, model: PROBE_MODEL, dim: 2, vectors: [[1, 0]] }
        : { id: req.id, ok: false, error: 'bad token' };
    socket.end(`${JSON.stringify(body)}\n`);
  });
});
await new Promise((resolve) => fakeEndpoint.listen(SOCK, resolve));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

/** Spawn the MCP server with `extraEnv`, returning {send, waitFor, kill}. */
function spawnServer(extraEnv) {
  // Strip any inherited embed-socket env so the no-socket run is really socketless.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', STEM_RECALL_DB: dbPath, ...extraEnv };
  delete env.STEM_EMBED_SOCK;
  delete env.STEM_EMBED_TOKEN;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    if (msg.id !== undefined) responses.set(msg.id, msg);
  });
  return {
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    waitFor: (id, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (responses.has(id)) return resolve(responses.get(id));
          if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for id ${id}`));
          setTimeout(tick, 25);
        };
        tick();
      }),
    kill: () => child.kill()
  };
}

async function callTool(server, id, query) {
  server.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'search_past_chats', arguments: { query, limit: 5 } }
  });
  return (await server.waitFor(id)).result?.content?.[0]?.text ?? '';
}

// ---- run 1: no embed socket → protocol + keyword search + honest fallback ----
const plain = spawnServer({});
try {
  plain.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await plain.waitFor(1);
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'stem-recall');
  check('initialize advertises tools capability', !!init.result?.capabilities?.tools);

  plain.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  plain.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await plain.waitFor(2);
  check('tools/list includes search_past_chats', list.result?.tools?.some((t) => t.name === 'search_past_chats'));
  check('tools/list includes search_chat_summaries (v3)', list.result?.tools?.some((t) => t.name === 'search_chat_summaries'));

  // v3 summaries tool: graceful empty-state on a DB with no summaries.
  plain.send({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name: 'search_chat_summaries', arguments: { query: 'cardiology appointment' } }
  });
  const sumEmpty = (await plain.waitFor(20)).result?.content?.[0]?.text ?? '';
  check('summaries search degrades gracefully with no summaries', /No matching conversation summaries/.test(sumEmpty));

  const text = await callTool(plain, 3, 'UZ Gent cardiology appointment');
  check('keyword search returns the health snippet', /UZ Gent/.test(text));
  check('keyword search excludes unrelated content', !/pizza/.test(text));

  // Slovak query, zero lexical overlap → keyword-only MUST miss (honest fallback).
  const skText = await callTool(plain, 4, 'ako sa darí mojej rastline na balkóne');
  check('without an embed socket the cross-language query misses (FTS-only)', !/rosemary/.test(skText));
} catch (e) {
  console.log('FAIL:', e.message);
  failures += 1;
} finally {
  plain.kill();
}

// ---- run 2: fake embed socket → the same query hits via the semantic leg ----
const hybrid = spawnServer({ STEM_EMBED_SOCK: SOCK, STEM_EMBED_TOKEN: PROBE_TOKEN });
try {
  hybrid.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await hybrid.waitFor(1);
  hybrid.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const skText = await callTool(hybrid, 2, 'ako sa darí mojej rastline na balkóne');
  check('with the embed socket the cross-language query finds the rosemary message', /rosemary/.test(skText));

  const kwText = await callTool(hybrid, 3, 'UZ Gent cardiology appointment');
  check('keyword hits still surface in hybrid mode', /UZ Gent/.test(kwText));
} catch (e) {
  console.log('FAIL:', e.message);
  failures += 1;
} finally {
  hybrid.kill();
  fakeEndpoint.close();
  try {
    rmSync(SOCK, { force: true });
  } catch {}
}

console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
