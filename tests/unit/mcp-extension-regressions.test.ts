import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import stemMcpBridge, {
  bridgeOAuthTokenForServer,
  findProtectedPath,
  isInside,
  makeProtectedRootsGate,
  McpHttpClient,
  MCP_HTTP_REQUEST_TIMEOUT_MS,
  mcpConnectionsSettledForTests,
  resetMcpConnectionCacheForTests
} from '../../src/server/pi/stem-mcp-extension.mjs';
import { mcpServerAuthIdentity } from '../../src/server/pi/mcp-config';

const cleanup: string[] = [];

afterEach(async () => {
  resetMcpConnectionCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STEM_MCP_CONFIG;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('MCP bridge filesystem policy', () => {
  it('treats symlink aliases and new descendants as inside a protected root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-policy-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(vault), mkdir(workspace)]);
    await symlink(vault, join(workspace, 'alias'));
    await symlink(join(vault, 'created-through-link.md'), join(workspace, 'dangling-file'));

    expect(isInside(join(vault, 'direct.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'alias', 'existing-or-new.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'alias', 'new', 'nested.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'dangling-file'), vault)).toBe(true);
    expect(isInside(pathToFileURL(join(vault, 'from-file-url.md')).href, vault)).toBe(true);
    expect(isInside(`@${join(vault, 'from-at-prefix.md')}`, vault)).toBe(true);
    expect(isInside('~/.stem-policy-nonexistent-vault/new.md', join(homedir(), '.stem-policy-nonexistent-vault'))).toBe(true);
    expect(isInside(join(workspace, 'outside.md'), vault)).toBe(false);
  });

  it('keeps the last-known-good roots when the gate file goes missing or corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-roots-gate-'));
    cleanup.push(root);
    const prPath = join(root, 'protected-roots.json');
    const gate = makeProtectedRootsGate(prPath);

    // Never-readable file: a fresh install genuinely has nothing protected.
    expect(gate()).toEqual([]);

    await writeFile(prPath, JSON.stringify({ roots: ['/vault'] }));
    expect(gate()).toEqual(['/vault']);

    // Corrupt rewrite (torn write, disk trouble) must NOT fail open.
    await writeFile(prPath, '{"roots": [tr');
    expect(gate()).toEqual(['/vault']);
    await rm(prPath);
    expect(gate()).toEqual(['/vault']);

    // Only a valid rewrite changes the set — including deliberately to empty.
    await writeFile(prPath, JSON.stringify({ roots: [] }));
    expect(gate()).toEqual([]);
  });

  it('finds path-shaped args inside protected roots, ignoring prose and outside paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-scan-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    await mkdir(vault);

    const roots = [vault];
    const target = join(vault, 'notes', 'secret.md');
    expect(findProtectedPath({ path: target }, roots)).toBe(target);
    expect(findProtectedPath({ nested: { files: [join(root, 'elsewhere.md'), target] } }, roots)).toBe(target);
    expect(findProtectedPath({ uri: pathToFileURL(target).href }, roots)).toBe(pathToFileURL(target).href);
    // Prose mentioning the folder name is not a path; outside paths pass.
    expect(findProtectedPath({ query: 'notes about the vault renovation' }, roots)).toBeNull();
    expect(findProtectedPath({ path: join(root, 'other', 'file.md') }, roots)).toBeNull();
    expect(findProtectedPath({ anything: 42, list: [true, null] }, roots)).toBeNull();
    expect(findProtectedPath({ path: target }, [])).toBeNull();
  });
});

describe('remote MCP request timeout', () => {
  it('never attaches a legacy name-only token without a matching identity stamp', () => {
    const server = { url: 'https://new.example/mcp', trusted: true };
    const legacy = { accessToken: 'old-secret' };
    expect(bridgeOAuthTokenForServer(server, legacy)).toBeNull();
    const stamped = { ...legacy, serverIdentity: mcpServerAuthIdentity(server)! };
    expect(bridgeOAuthTokenForServer(server, stamped)).toBe(stamped);
  });

  it('aborts a server that never returns response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
      )
    );
    const client = new McpHttpClient('hanging', { url: 'https://mcp.test' }, null, () => {});
    client.start();
    const pending = client.handshake();
    const rejected = expect(pending).rejects.toThrow(`timed out after ${MCP_HTTP_REQUEST_TIMEOUT_MS}ms`);

    await vi.advanceTimersByTimeAsync(MCP_HTTP_REQUEST_TIMEOUT_MS + 1);
    await rejected;
  });
});

describe('failed MCP connection retry', () => {
  it('retries a configured server on the next session factory invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-retry-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { retryme: { url: 'https://mcp.test', trusted: true } } }));
    process.env.STEM_MCP_CONFIG = configPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('server is down'))
      .mockImplementation(async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        const result = request.method === 'tools/list' ? { tools: [] } : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      });
    vi.stubGlobal('fetch', fetchMock);

    const fakePi = {
      registerTool: (_tool: unknown) => {},
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).retryme.status).toBe('failed');

    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    expect(fetchMock).toHaveBeenCalledTimes(4); // failed initialize, then initialize + notify + tools/list
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).retryme.status).toBe('ready');
  });
});

describe('MCP router protected-roots guard', () => {
  it('refuses invoke_tool calls whose args reach into a read-only folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-guard-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    await mkdir(vault);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { fs: { url: 'https://mcp.test', trusted: true } } }));
    await writeFile(join(root, 'protected-roots.json'), JSON.stringify({ roots: [vault] }));
    process.env.STEM_MCP_CONFIG = configPath;

    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        methods.push(request.method ?? '');
        const result = request.method === 'tools/list'
          ? { tools: [{ name: 'write_file', description: 'writes a file' }] }
          : request.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'wrote it' }] }
            : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const registered: RegisteredTool[] = [];
    const fakePi = {
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    const invoke = registered.find((tool) => tool.name === 'invoke_tool');

    const blocked = await invoke!.execute!('call-1', {
      server: 'fs',
      tool: 'write_file',
      args: { path: join(vault, 'notes', 'x.md'), content: 'overwrite' }
    });
    expect(blocked.isError).toBe(true);
    expect(String(blocked.content[0]?.text)).toContain('read-only');
    expect(methods).not.toContain('tools/call');

    // The same tool is untouched for paths outside the protected roots.
    const allowed = await invoke!.execute!('call-2', {
      server: 'fs',
      tool: 'write_file',
      args: { path: join(root, 'open.md'), content: 'fine' }
    });
    expect(allowed.isError).not.toBe(true);
    expect(methods).toContain('tools/call');
  });
});

describe('non-blocking MCP connect', () => {
  it('returns from the factory while routed servers are still handshaking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-nonblock-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { slowpoke: { url: 'https://mcp.test', trusted: true } } }));
    process.env.STEM_MCP_CONFIG = configPath;

    // Every request stalls until the test releases it — a hung remote server.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        await gate;
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        const result = request.method === 'tools/list' ? { tools: [{ name: 'slow_tool', description: 'x' }] } : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    const fakePi = {
      registerTool: (_tool: unknown) => {},
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    // The factory must resolve immediately (pi readiness gates on it) even though
    // the routed server has not answered its handshake yet.
    await stemMcpBridge(fakePi);
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).slowpoke.status).toBe('starting');
    expect(JSON.parse(await readFile(join(root, 'mcp-catalog.json'), 'utf8')).text).toBe('');

    release();
    await mcpConnectionsSettledForTests();
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).slowpoke.status).toBe('ready');
    expect(JSON.parse(await readFile(join(root, 'mcp-catalog.json'), 'utf8')).text).toContain('slow_tool');
  });
});

describe('assistant MCP administration', () => {
  it('leaves config mutation to the main process after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-admin-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    const initial = JSON.stringify({
      servers: { existing: { command: '/bin/echo', args: [], trusted: true, disabled: true } }
    }, null, 2);
    await writeFile(configPath, initial);
    process.env.STEM_MCP_CONFIG = configPath;

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<unknown>;
    };
    const registered: RegisteredTool[] = [];
    const fakePi = {
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    const confirm = vi.fn(async () => true);
    const ctx = { ui: { confirm } };
    const add = registered.find((tool) => tool.name === 'add_mcp_server');
    const remove = registered.find((tool) => tool.name === 'remove_mcp_server');

    await add?.execute?.(
      'add-id',
      {
        name: 'new-server',
        transport: 'http',
        url: 'https://mcp.example',
        oauthClientId: 'client-id',
        oauthClientSecret: 'real-client-secret'
      },
      undefined,
      undefined,
      ctx
    );
    await remove?.execute?.('remove-id', { name: 'existing' }, undefined, undefined, ctx);

    expect(confirm).toHaveBeenCalledTimes(2);
    const proposal = JSON.parse(String(confirm.mock.calls[0]?.[1])) as {
      input?: { oauthClientSecret?: string };
    };
    expect(proposal.input?.oauthClientSecret).toBe('real-client-secret');
    expect(await readFile(configPath, 'utf8')).toBe(initial);
  });
});
