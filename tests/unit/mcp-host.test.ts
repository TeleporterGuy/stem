// The client half of an MCP server pinned to a device — the thing that actually
// spawns something on your computer (docs/mcp-device-pinning.md, step 3).
//
// Step 2's tests cover the server side with a stub host at the far end. These
// cover the host itself with a stub CLIENT at the far end: no process is ever
// spawned here and no file is ever written, because what is under test is the
// decision to spawn and not the spawning.
//
// Four properties carry this step, and each has a test by name below:
//
//  - nothing runs that this machine has not approved, and editing an approved
//    spec puts it back to unapproved (④);
//  - what is approved starts by itself at launch, without a second click (⑥);
//  - one broken server fails alone;
//  - every request gets an answer, including the ones that are refusals.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHost, previewOf, unboundedSurface, type McpHost } from '../../src/desktop/mcp-host';
import {
  fileApprovalStore,
  mcpApprovalsPath,
  memoryApprovalStore,
  type ApprovalStore
} from '../../src/desktop/mcp-host/approvals';
import type { McpClient, McpToolDefinition } from '../../src/desktop/mcp-host/clients';
import { mcpSpecFingerprint } from '../../src/shared/mcp-fingerprint';
import type {
  DeviceMcpAnnouncement,
  DeviceMcpAssignment,
  DeviceMcpResult,
  DeviceMcpSpec,
  McpHostLocalState
} from '../../src/shared/types';

const FILES_SPEC: DeviceMcpSpec = {
  command: '/usr/bin/mcp-files',
  args: ['--root', '/Users/ada'],
  env: { API_KEY: 'read-only' }
};

const READ_FILE: McpToolDefinition = {
  name: 'read_file',
  description: 'Read a file from disk. Paths are relative to the configured root.',
  inputSchema: { properties: { path: {}, encoding: {} }, required: ['path'] }
};

/** A connection that answers from memory. It never touches a pipe or a socket. */
class FakeClient implements McpClient {
  alive = false;
  stops = 0;
  readonly calls: { tool: string; args: unknown }[] = [];

  constructor(
    readonly name: string,
    readonly tools: McpToolDefinition[],
    /** When set, start() throws it — a binary that is not there. */
    readonly startFailure?: string
  ) {}

  start(): void {
    if (this.startFailure) throw new Error(this.startFailure);
    this.alive = true;
  }

  handshake(): Promise<McpToolDefinition[]> {
    return Promise.resolve(this.tools);
  }

  callTool(tool: string, args: unknown): Promise<unknown> {
    this.calls.push({ tool, args });
    if (!this.alive) return Promise.reject(new Error(`${this.name} is not running.`));
    return Promise.resolve({ content: [{ type: 'text', text: `${tool} says hello` }] });
  }

  stop(): void {
    this.alive = false;
    this.stops += 1;
  }
}

interface Harness {
  host: McpHost;
  /** What the server would answer `mcpHost:hello` with; rewrite it and refresh. */
  assign(...assignments: { name: string; spec: DeviceMcpSpec; lostSecrets?: string[] }[]): void;
  /** Every name connect() was asked for, in order. One entry per spawn attempt. */
  readonly spawned: string[];
  readonly clients: Map<string, FakeClient>;
  readonly announcements: DeviceMcpAnnouncement[];
  readonly results: { requestId: string; result: DeviceMcpResult }[];
  readonly pushed: McpHostLocalState[];
  /** Let every queued promise run — the host settles and announces off-thread. */
  flush(): Promise<void>;
}

function harness(
  options: {
    approvals?: ApprovalStore;
    failures?: Record<string, string>;
    /** What `mcpHost:hello` throws instead of answering — an older server. */
    helloFailure?: string;
  } = {}
): Harness {
  let assignments: DeviceMcpAssignment[] = [];
  const spawned: string[] = [];
  const clients = new Map<string, FakeClient>();
  const announcements: DeviceMcpAnnouncement[] = [];
  const results: { requestId: string; result: DeviceMcpResult }[] = [];
  const pushed: McpHostLocalState[] = [];

  const host = createMcpHost({
    invoke: async (channel, args) => {
      if (channel === 'mcpHost:hello') {
        if (options.helloFailure) throw new Error(options.helloFailure);
        return assignments;
      }
      if (channel === 'mcpHost:announce') {
        announcements.push(args[0] as DeviceMcpAnnouncement);
        return undefined;
      }
      if (channel === 'mcpHost:result') {
        results.push({ requestId: args[0] as string, result: args[1] as DeviceMcpResult });
        return undefined;
      }
      throw new Error(`the host called an unexpected channel: ${channel}`);
    },
    approvals: options.approvals ?? memoryApprovalStore(),
    connect: (name) => {
      spawned.push(name);
      const client = new FakeClient(name, [READ_FILE], options.failures?.[name]);
      clients.set(name, client);
      return client;
    },
    changed: (state) => pushed.push(state)
  });

  return {
    host,
    assign: (...next) => {
      assignments = next.map(({ name, spec, lostSecrets }) => ({
        name,
        spec,
        fingerprint: mcpSpecFingerprint(spec),
        ...(lostSecrets ? { lostSecrets } : {})
      }));
    },
    spawned,
    clients,
    announcements,
    results,
    pushed,
    flush: async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    }
  };
}

describe('the approval gate', () => {
  it('does not spawn a spec this machine has never approved', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();

    // The whole of ④ in one assertion: the spec arrived, it is pinned here, and
    // nothing ran. A compromised server can write any command into mcp.json and
    // this is where that stops.
    expect(h.spawned).toEqual([]);
    const state = h.host.localState();
    expect(state.status.files).toEqual({ status: 'unapproved' });
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      name: 'files',
      fingerprint: mcpSpecFingerprint(FILES_SPEC),
      changed: false
    });
    // And it did not ambush anybody on the way (⑥) — there is no modal here to
    // raise, only a card that sits in the panel until somebody opens it.
    expect(state.pending[0].preview.command).toBe('/usr/bin/mcp-files');
  });

  it('starts what is already approved, at launch, without being asked again (⑥)', async () => {
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();

    expect(h.spawned).toEqual(['files']);
    expect(h.host.localState().status.files).toEqual({ status: 'ready', tools: 1 });
    expect(h.clients.get('files')!.alive).toBe(true);
  });

  it('puts an approved server back to pending when its spec is edited', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.host.approve('files', mcpSpecFingerprint(FILES_SPEC));
    await h.flush();
    expect(h.host.localState().status.files.status).toBe('ready');

    // Somebody widened it — a second root, or a token with more rights. The
    // approval was given for the first program and does not cover the second.
    const widened: DeviceMcpSpec = { ...FILES_SPEC, args: ['--root', '/'] };
    h.assign({ name: 'files', spec: widened });
    await h.host.refresh();
    await h.flush();

    expect(h.spawned).toEqual(['files']); // not spawned a second time
    expect(h.clients.get('files')!.stops).toBeGreaterThan(0); // and the old one is gone
    const state = h.host.localState();
    expect(state.status.files).toEqual({ status: 'unapproved' });
    expect(state.pending[0]).toMatchObject({ name: 'files', fingerprint: mcpSpecFingerprint(widened) });
    // "Changed" and "new" are answered differently by somebody who knows they
    // did not edit it, so the card has to be able to tell them apart.
    expect(state.pending[0].changed).toBe(true);
  });

  it('refuses an approval for a fingerprint that has already moved on', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();

    await expect(h.host.approve('files', 'a-fingerprint-from-some-older-card')).rejects.toThrow(/changed/i);
    expect(h.spawned).toEqual([]);
  });

  it('stops a server whose approval is withdrawn, and offers it again', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.host.approve('files', mcpSpecFingerprint(FILES_SPEC));
    await h.flush();

    const state = await h.host.reject('files');
    expect(h.clients.get('files')!.alive).toBe(false);
    expect(state.status.files).toEqual({ status: 'unapproved' });
    // A rejection forgets the approval rather than recording a "no": the spec is
    // still pinned here, so the card comes back and can be answered differently.
    expect(state.approved.files).toBeUndefined();
    expect(state.pending.map((p) => p.name)).toEqual(['files']);
  });

  it('will not connect an unapproved spec even to test it', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();

    // Test connection is a diagnostic, not a side door. Spawning here would be
    // exactly the process ④ exists to require a decision for, spent by pressing
    // a button labelled "Test connection".
    const state = await h.host.test('files');
    expect(h.spawned).toEqual([]);
    expect(state.status.files.status).toBe('unapproved');
  });

  it('reconnects an approved server on test, and surfaces the real reason it fails', async () => {
    const h = harness({ failures: { files: 'spawn /usr/bin/mcp-files ENOENT' } });
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.host.approve('files', mcpSpecFingerprint(FILES_SPEC));
    await h.flush();

    const state = await h.host.test('files');
    expect(state.status.files.status).toBe('failed');
    expect(state.status.files.error).toContain('ENOENT');
  });
});

describe('what this machine has agreed to', () => {
  it('forgets an approval once the server is no longer pinned here', async () => {
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();
    expect(h.spawned).toEqual(['files']);

    // Un-pinned somewhere else — moved back to the server, or deleted.
    h.assign();
    await h.host.refresh();
    await h.flush();
    expect(await approvals.read()).toEqual({});

    // And pinning the very same spec back here later asks again rather than
    // starting silently: consent was given for an assignment, and the
    // assignment is what went away. mcp.json is written centrally, so an
    // approval that outlives its assignment is one this machine keeps honouring
    // for a config it no longer has any part in.
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.refresh();
    await h.flush();
    expect(h.spawned).toEqual(['files']); // not spawned a second time
    expect(h.host.localState().status.files).toEqual({ status: 'unapproved' });
    expect(h.host.localState().pending.map((p) => p.name)).toEqual(['files']);
  });

  it('keeps every approval that is still assigned', async () => {
    const approvals = memoryApprovalStore({
      files: mcpSpecFingerprint(FILES_SPEC),
      notes: mcpSpecFingerprint({ command: '/usr/bin/mcp-notes' })
    });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC }, { name: 'notes', spec: { command: '/usr/bin/mcp-notes' } });
    await h.host.start();
    await h.flush();

    expect(Object.keys(await approvals.read()).sort()).toEqual(['files', 'notes']);
  });

  it('keeps everything when the server cannot be asked at all', async () => {
    // A failed hello must not read as "you host nothing": that would throw away
    // every approval on this machine the first time the network hiccupped.
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals, helloFailure: 'Stem’s server is unreachable: socket hang up' });
    await h.host.start();
    await h.flush();

    expect(await approvals.read()).toEqual({ files: mcpSpecFingerprint(FILES_SPEC) });
    expect(h.host.localState().unsupported).toBeUndefined();
  });

  it('says the server is too old rather than looking like an empty panel', async () => {
    const h = harness({
      helloFailure: 'Rejected local call to mcpHost:hello: no handler registered.'
    });
    await h.host.start();
    await h.flush();

    // Everything below is empty either way; the difference is whether anybody
    // can tell that from "nothing is pinned to this computer".
    expect(h.host.localState().unsupported).toMatch(/older than this copy of Stem/);
    expect(h.host.localState().pending).toEqual([]);
  });
});

describe('a credential that was lost rather than edited', () => {
  it('says so on the card, naming what could not be read', async () => {
    // The wrong-passphrase import: the value is in mcp.json and the key that
    // opens it is gone, so it is dropped, the fingerprint moves, and this
    // machine is asked to approve a spec nobody touched. "Changed — approve it
    // again" is true and misleading, and approving it starts a server with no
    // API key, which fails later in a way nobody connects back to the import.
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    const stripped: DeviceMcpSpec = { command: FILES_SPEC.command, args: FILES_SPEC.args };
    h.assign({ name: 'files', spec: stripped, lostSecrets: ['API_KEY'] });
    await h.host.start();
    await h.flush();

    expect(h.spawned).toEqual([]);
    const [pending] = h.host.localState().pending;
    expect(pending.changed).toBe(true);
    expect(pending.lostSecrets).toEqual(['API_KEY']);
  });

  it('says nothing when every value was readable', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();

    expect(h.host.localState().pending[0].lostSecrets).toBeUndefined();
  });
});

describe('a server that cannot start', () => {
  it('fails alone, leaving its neighbours running', async () => {
    // The behaviour the stdio client's 'error' handler was written for, one
    // level up: an unspawnable binary is one broken entry in one user's config,
    // and it must cost that server and nothing else.
    const broken: DeviceMcpSpec = { command: '/nope/mcp-broken' };
    const approvals = memoryApprovalStore({
      files: mcpSpecFingerprint(FILES_SPEC),
      broken: mcpSpecFingerprint(broken)
    });
    const h = harness({ approvals, failures: { broken: 'spawn /nope/mcp-broken ENOENT' } });
    h.assign({ name: 'files', spec: FILES_SPEC }, { name: 'broken', spec: broken });
    await h.host.start();
    await h.flush();

    const state = h.host.localState();
    expect(state.status.files).toEqual({ status: 'ready', tools: 1 });
    expect(state.status.broken.status).toBe('failed');
    expect(state.status.broken.error).toContain('ENOENT');
  });
});

describe('the announcement', () => {
  it('reports every server pinned here, with its tools and its fingerprint', async () => {
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC }, { name: 'notes', spec: { command: '/usr/bin/mcp-notes' } });
    await h.host.start();
    await h.flush();

    const last = h.announcements.at(-1)!;
    expect(last.servers.map((s) => s.name).sort()).toEqual(['files', 'notes']);

    const files = last.servers.find((s) => s.name === 'files')!;
    expect(files.status).toBe('ready');
    expect(files.fingerprint).toBe(mcpSpecFingerprint(FILES_SPEC));
    // Names, a first sentence and a compact signature — the cheap catalog. The
    // full JSON schema stays on this machine and is fetched on demand.
    expect(files.tools).toEqual([
      { name: 'read_file', description: 'Read a file from disk.', signature: '(path, encoding?)' }
    ]);

    // A server nobody has approved is announced as such rather than omitted:
    // "waiting for somebody to say yes" and "broken" are different sentences for
    // the assistant to say, and neither is "this device hosts nothing".
    const notes = last.servers.find((s) => s.name === 'notes')!;
    expect(notes.status).toBe('unapproved');
    expect(notes.tools).toBeUndefined();
  });

  it('never reports a server as ready while it is still connecting', async () => {
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();

    // Every announcement that was written is one written with nothing in flight,
    // so a 'starting' status can never reach the catalog — which is what keeps
    // ③'s "an unavailable server stays listed, marked" from becoming "an
    // available one is listed as broken".
    expect(h.announcements.length).toBeGreaterThan(0);
    for (const announcement of h.announcements) {
      for (const server of announcement.servers) {
        expect(['ready', 'failed', 'unapproved']).toContain(server.status);
      }
    }
    expect(h.announcements.at(-1)!.servers[0].status).toBe('ready');
  });
});

describe('answering a request', () => {
  async function ready(): Promise<Harness> {
    const approvals = memoryApprovalStore({ files: mcpSpecFingerprint(FILES_SPEC) });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    await h.flush();
    return h;
  }

  it('lists the tools of a server running here', async () => {
    const h = await ready();
    h.host.onRequest({ requestId: 'r1', server: 'files', op: 'tools' });
    await h.flush();

    expect(h.results).toEqual([
      {
        requestId: 'r1',
        result: {
          ok: true,
          tools: [{ name: 'read_file', description: 'Read a file from disk.', signature: '(path, encoding?)' }]
        }
      }
    ]);
  });

  it('runs one tool and hands back its content untouched', async () => {
    const h = await ready();
    h.host.onRequest({ requestId: 'r2', server: 'files', op: 'call', tool: 'read_file', args: { path: 'notes.md' } });
    await h.flush();

    expect(h.clients.get('files')!.calls).toEqual([{ tool: 'read_file', args: { path: 'notes.md' } }]);
    expect(h.results[0]).toEqual({
      requestId: 'r2',
      result: { ok: true, content: [{ type: 'text', text: 'read_file says hello' }] }
    });
  });

  it('answers a call for a tool the server does not have', async () => {
    const h = await ready();
    h.host.onRequest({ requestId: 'r3', server: 'files', op: 'call', tool: 'delete_everything' });
    await h.flush();

    expect(h.results[0].result).toEqual({ ok: false, error: '“files” has no tool “delete_everything”.' });
  });

  it('refuses an unapproved server immediately, and says where to go', async () => {
    const h = harness();
    h.assign({ name: 'files', spec: FILES_SPEC });
    await h.host.start();
    h.host.onRequest({ requestId: 'r4', server: 'files', op: 'call', tool: 'read_file' });
    await h.flush();

    // Answered, not dropped. The alternative is the router waiting out two
    // minutes for a machine that was awake and listening the whole time.
    const result = h.results[0].result as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approved');
    expect(result.error).toContain('files');
  });

  it('hands back a tool’s whole schema when asked to describe it', async () => {
    const h = await ready();
    h.host.onRequest({ requestId: 'r6', server: 'files', op: 'describe', tool: 'read_file' });
    await h.flush();

    // The catalog that travels every turn carries `(path, encoding?)`. The real
    // schema lives here, and only here — this process is the one that handshook
    // with the server — so this is where describe_tool's answer has to come
    // from. Nothing is run to produce it.
    expect(h.results[0]).toEqual({
      requestId: 'r6',
      result: {
        ok: true,
        schema: {
          name: 'read_file',
          description: 'Read a file from disk. Paths are relative to the configured root.',
          inputSchema: { properties: { path: {}, encoding: {} }, required: ['path'] }
        }
      }
    });
    expect(h.clients.get('files')!.calls).toEqual([]);
  });

  it('answers for a server this machine has never heard of', async () => {
    const h = await ready();
    h.host.onRequest({ requestId: 'r5', server: 'ghost', op: 'tools' });
    await h.flush();

    expect(h.results[0].result).toEqual({
      ok: false,
      error: 'This computer is not hosting an MCP server called “ghost”.'
    });
  });
});

describe('shutting down', () => {
  it('kills every child and starts nothing afterwards', async () => {
    const approvals = memoryApprovalStore({
      files: mcpSpecFingerprint(FILES_SPEC),
      notes: mcpSpecFingerprint({ command: '/usr/bin/mcp-notes' })
    });
    const h = harness({ approvals });
    h.assign({ name: 'files', spec: FILES_SPEC }, { name: 'notes', spec: { command: '/usr/bin/mcp-notes' } });
    await h.host.start();
    await h.flush();
    expect([...h.clients.values()].every((c) => c.alive)).toBe(true);

    h.host.close();

    // A server pinned here is a child of the app's own process; quitting without
    // killing it leaves somebody's filesystem server running with no parent.
    expect([...h.clients.values()].every((c) => !c.alive)).toBe(true);
    expect(h.host.localState().status).toEqual({});

    // And a late refresh — the connection callback firing on the way out — must
    // not spawn something during the quit.
    await h.host.refresh();
    await h.flush();
    expect(h.spawned).toEqual(['files', 'notes']);
  });
});

describe('the approval file on this disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stem-approvals-'));
  process.env.STEM_MCP_APPROVALS_FILE = join(dir, 'mcp-approvals.json');
  afterAll(() => {
    delete process.env.STEM_MCP_APPROVALS_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty, survives a round trip, and is owner-only', async () => {
    const store = fileApprovalStore();
    // Nothing readable yet means nothing approved, which is the safe answer as
    // well as the true one: at worst somebody clicks Approve again.
    expect(await store.read()).toEqual({});

    await store.approve('files', 'abc123');
    await store.approve('notes', 'def456');
    expect(await fileApprovalStore().read()).toEqual({ files: 'abc123', notes: 'def456' });

    // A file another user can write is a file another user can pre-approve a
    // spec in, which is the whole gate.
    expect(statSync(mcpApprovalsPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(mcpApprovalsPath(), 'utf8'))).toEqual({
      version: 1,
      approved: { files: 'abc123', notes: 'def456' }
    });

    await store.reject('files');
    expect(await store.read()).toEqual({ notes: 'def456' });
  });
});

describe('what the approval card is allowed to show', () => {
  it('carries the names of a spec’s credentials and never their values', () => {
    const preview = previewOf({
      command: '/usr/bin/mcp-mail',
      args: ['--imap'],
      env: { FASTMAIL_TOKEN: 'fmu1-secret', REGION: 'eu' },
      headers: { Authorization: 'Bearer nope' }
    });
    expect(preview.envKeys).toEqual(['FASTMAIL_TOKEN', 'REGION']);
    expect(preview.headerKeys).toEqual(['Authorization']);
    expect(JSON.stringify(preview)).not.toContain('fmu1-secret');
    expect(JSON.stringify(preview)).not.toContain('Bearer nope');
  });

  it('says so when the thing being approved can run anything', () => {
    // The residual risk the plan accepts knowingly: ⑤ removed per-call
    // confirmation on the argument that an MCP server's surface is bounded at
    // approval time, and for a shell server that argument is simply false.
    expect(unboundedSurface('helper', { command: '/bin/bash', args: ['-c', 'mcp'] })).toMatch(/bash/);
    expect(unboundedSurface('tools', { command: 'uvx', args: ['mcp-server-shell'] })).toMatch(/commands/);
    expect(unboundedSurface('terminal', { command: '/opt/bin/mcp' })).toMatch(/commands/);

    // A runtime handed no program, or handed one as text, is the same thing a
    // shell is — there is no script for it to be bounded by.
    expect(unboundedSurface('helper', { command: 'node' })).toMatch(/node/);
    expect(unboundedSurface('helper', { command: 'python3', args: ['-c', 'import mcp'] })).toMatch(/python3/);

    // And stays quiet for an ordinary bounded one, so the warning keeps meaning
    // something when it does appear.
    expect(unboundedSurface('files', FILES_SPEC)).toBeNull();
    expect(unboundedSurface('home-assistant', { url: 'http://homeassistant.local:8123/mcp' })).toBeNull();
    // The shape most stdio servers actually have. Warning on these would fire on
    // nearly every server anybody adds, and a warning that always appears is one
    // nobody reads by the third time — which would cost the case it exists for.
    expect(unboundedSurface('recall', { command: 'node', args: ['/opt/stem/recall-server.js'] })).toBeNull();
    expect(unboundedSurface('fastmail', { command: 'npx', args: ['-y', '@fastmail/mcp'] })).toBeNull();
  });
});
