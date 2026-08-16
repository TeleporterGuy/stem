import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpStdioClient } from '../../src/desktop/mcp-host/clients';
import { resolveLoginPath } from '../../src/server/exec/executor';

// The one thing about a pinned MCP server that cannot be proved with a stub: the
// spawn itself. Everywhere else the host is tested through an injected client,
// which is right — those tests are about approval and reporting, not about
// process plumbing — but it leaves the transport that actually runs on somebody's
// laptop covered by nothing at all.
//
// So this file starts real children. The server is a few lines of Node written
// out at test time rather than a fixture on disk, because what is being tested is
// the client's half of the conversation and inlining the other half here is what
// makes the protocol legible in one screen: newline-delimited JSON-RPC 2.0,
// initialize then tools/list then tools/call.
//
// It uses process.execPath, so it needs no interpreter on PATH and runs the same
// on a developer's Mac and in CI.

let dir: string;
const written: string[] = [];

/** Write a Node script and answer with the spec that runs it. */
async function server(name: string, body: string): Promise<{ command: string; args: string[] }> {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, body, 'utf8');
  written.push(path);
  return { command: process.execPath, args: [path] };
}

/**
 * A well-behaved MCP server: one tool, which echoes its arguments back, plus a
 * line of prose on stdout before anything else — real servers do print, and a
 * client that took that for a frame would fail on its first handshake.
 */
const GOOD = `
process.stdout.write('starting up\\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue; // a notification; nothing to answer
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params.protocolVersion });
    else if (msg.method === 'tools/list')
      reply({ tools: [{ name: 'echo', description: 'Say it back.', inputSchema: { properties: { text: { type: 'string' } } } }] });
    else if (msg.method === 'tools/call')
      reply({ content: [{ type: 'text', text: 'ECHO:' + msg.params.arguments.text + ':' + process.env.STEM_TEST_TOKEN }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'no such method' } }) + '\\n');
  }
});
`;

/** A server that answers the handshake and then dies mid-conversation. */
const DIES = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === 'tools/call') process.exit(1);
    const result = msg.method === 'tools/list' ? { tools: [{ name: 'boom' }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

/** A server whose only tool answers with the PATH its process was given. */
const REPORTS_PATH = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result =
      msg.method === 'tools/list'
        ? { tools: [{ name: 'env' }] }
        : msg.method === 'tools/call'
          ? { content: [{ type: 'text', text: process.env.PATH || '' }] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stem-mcp-stdio-'));
});

const started: McpStdioClient[] = [];

afterEach(() => {
  for (const client of started.splice(0)) client.stop();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function open(
  name: string,
  spec: { command: string; args: string[]; env?: Record<string, string> }
): Promise<McpStdioClient> {
  const client = new McpStdioClient(name, spec);
  started.push(client);
  // Awaited because start() resolves the PATH a login shell would have before
  // it spawns — see the PATH test below for why that is worth an await.
  await client.start();
  return client;
}

describe('McpStdioClient against a real child', () => {
  it('handshakes, lists tools, and calls one with the spec env applied', async () => {
    const client = await open('echo', { ...(await server('good', GOOD)), env: { STEM_TEST_TOKEN: 'from-the-spec' } });

    const tools = await client.handshake();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0].description).toBe('Say it back.');

    // The env from the spec reaches the child on top of this machine's own — the
    // property that makes an API key in mcp.json mean anything over here.
    const result = (await client.callTool('echo', { text: 'hi' })) as { content: { text: string }[] };
    expect(result.content[0].text).toBe('ECHO:hi:from-the-spec');
    expect(client.alive).toBe(true);
  });

  it('fails only itself when the command does not exist', async () => {
    const client = await open('missing', { command: join(dir, 'no-such-binary'), args: [] });

    // ENOENT arrives as an 'error' event, which is fatal to the whole process
    // when unhandled. The test that it is handled is that this rejects and the
    // suite keeps running.
    await expect(client.handshake()).rejects.toThrow(/missing/);
    expect(client.alive).toBe(false);
  });

  it('rejects what is in flight when the child dies, and refuses to be reused', async () => {
    const client = await open('flaky', await server('dies', DIES));
    await client.handshake();

    await expect(client.callTool('boom', {})).rejects.toThrow(/flaky/);
    expect(client.alive).toBe(false);
    // A dead client answering "not running" rather than throwing EPIPE out of a
    // stream write is what lets the host report it instead of crashing.
    await expect(client.callTool('boom', {})).rejects.toThrow(/not running/);
  });

  it('spawns with the PATH a login shell would have, not the one a GUI app inherits', async () => {
    // The commonest stdio MCP server anywhere is written down as `npx …`. A
    // double-clicked app on macOS gets PATH=/usr/bin:/bin:/usr/sbin:/sbin and
    // nothing else, so that server is ENOENT here while working perfectly in
    // the user's terminal — on the very machine the whole point of pinning was
    // to run it on. It is the same question run_command answers, from the same
    // function, so the assertion is that they agree rather than that some
    // particular directory is present.
    const client = await open('paths', await server('path', REPORTS_PATH));
    await client.handshake();
    const result = (await client.callTool('env', {})) as { content: { text: string }[] };
    expect(result.content[0].text).toBe(await resolveLoginPath());

    // And the spec still wins over everything: it is what the person approving
    // the entry read on the card.
    const overridden = await open('override', {
      ...(await server('path2', REPORTS_PATH)),
      env: { PATH: '/only/what/the/spec/said' }
    });
    await overridden.handshake();
    const forced = (await overridden.callTool('env', {})) as { content: { text: string }[] };
    expect(forced.content[0].text).toBe('/only/what/the/spec/said');
  });

  it('stop() is safe twice and on a client that never started', () => {
    const client = new McpStdioClient('never', { command: process.execPath, args: ['-e', ''] });
    expect(() => client.stop()).not.toThrow();
    expect(() => client.stop()).not.toThrow();
  });
});
