// Where an MCP server runs, as opposed to how it is spoken to (docs/mcp-device-pinning.md).
//
// The whole of step 1 is a fact written down and read back, so that is what is
// checked here: an entry can name a device, an entry that names nothing still
// means "the machine hosting the server", and the two refusals happen at the one
// moment somebody is watching — an unpaired device and a phone.
//
// One negative property is load-bearing: naming a place must not disturb
// mcpServerAuthIdentity(), which is what decides whether a stored OAuth token may
// still be used. If it did, landing this field would sign every remote server out.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMcpServer, listMcpServers } from '../../src/server/pi/mcp';
import {
  mcpServerAuthIdentity,
  piMcpOAuthPath,
  readMcpConfig,
  writeMcpConfig
} from '../../src/server/pi/mcp-config';
import stemMcpBridge, {
  mcpConnectionsSettledForTests,
  resetMcpConnectionCacheForTests
} from '../../src/server/pi/stem-mcp-extension.mjs';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, mintDevice, readDevices, revokeDevice } from '../../src/server/transport/auth';
import { piMcpConfigPath, devicesStorePath } from '../../src/server/workspace/paths';

beforeEach(async () => {
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  rmSync(piMcpConfigPath(), { force: true });
  rmSync(piMcpOAuthPath(), { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock.reaper`, { force: true });
  // The registry stamps lastSeenAt behind the request; drain its queue before
  // wiping the file so a previous test's write cannot land on this one.
  await readDevices().catch(() => undefined);
  rmSync(devicesStorePath(), { force: true });
  forgetCachedDevices();
});

describe('pinning a server to a device', () => {
  it('keeps the device in the config and reports it with the device’s own label', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'files',
      transport: 'stdio',
      command: '/bin/echo',
      args: ['hi'],
      location: { deviceId: device.id }
    });

    expect((await readMcpConfig()).servers.files.location).toEqual({ deviceId: device.id });
    // The label is read from the registry rather than taken from the caller, so
    // a row can never claim to be a machine it is not.
    const [summary] = await listMcpServers();
    expect(summary.location).toEqual({ deviceId: device.id, label: 'Ada’s MacBook' });
  });

  it('leaves an unpinned server exactly as it was — no field, no location', async () => {
    await addMcpServer({ name: 'plain', transport: 'stdio', command: '/bin/echo' });
    const stored = (await readMcpConfig()).servers.plain;
    expect('location' in stored).toBe(false);
    expect((await listMcpServers())[0].location).toBeUndefined();
  });

  it('does not change a server’s auth identity, so stored OAuth tokens survive it', async () => {
    const server = { url: 'https://mcp.test/mcp', headers: { Authorization: 'Bearer x' }, trusted: true };
    const identity = mcpServerAuthIdentity(server);
    // Same server, now pinned: the token is the same server's to reuse, because
    // moving where something runs does not change who it authenticates as.
    expect(mcpServerAuthIdentity({ ...server, location: { deviceId: 'dev-1' } })).toBe(identity);
  });

  it('survives a write/read round trip through the encrypted config', async () => {
    await writeMcpConfig({
      servers: {
        lan: {
          url: 'http://homeassistant.local:8123/mcp',
          headers: { Authorization: 'Bearer secret' },
          location: { deviceId: 'dev-42' }
        }
      }
    });
    const back = (await readMcpConfig()).servers.lan;
    expect(back.location).toEqual({ deviceId: 'dev-42' });
    // The header still decrypts, i.e. the new field rode along with the ones
    // that go to disk encrypted rather than displacing them.
    expect(back.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(await readFile(piMcpConfigPath(), 'utf8')).not.toContain('Bearer secret');
  });
});

describe('what may be named as a host', () => {
  it('refuses a device that is not paired with this server', async () => {
    await expect(
      addMcpServer({ name: 'ghost', transport: 'stdio', command: '/bin/echo', location: { deviceId: 'nobody' } })
    ).rejects.toThrow(/not paired/);
    // And nothing was written: a refused add must not leave half a server behind.
    expect(Object.keys((await readMcpConfig()).servers)).not.toContain('ghost');
  });

  it('refuses a phone, and says why', async () => {
    const { device } = await mintDevice('Ada’s iPhone', 'mobile');
    await expect(
      addMcpServer({ name: 'onphone', transport: 'stdio', command: '/bin/echo', location: { deviceId: device.id } })
    ).rejects.toThrow(/goes to sleep/);
  });
});

describe('a device that is unpaired afterwards', () => {
  it('marks the server orphaned rather than deleting it or claiming it runs here', async () => {
    const { device } = await mintDevice('Old laptop');
    await addMcpServer({
      name: 'stranded',
      transport: 'stdio',
      command: '/bin/echo',
      location: { deviceId: device.id }
    });
    await revokeDevice(device.id);

    const [summary] = await listMcpServers();
    expect(summary.location).toEqual({ deviceId: device.id, label: 'Unpaired device', orphaned: true });
    // The pin itself is untouched: repairing that device must bring the server
    // back, and only the user may decide to move or drop it.
    expect((await readMcpConfig()).servers.stranded.location).toEqual({ deviceId: device.id });
  });
});

describe('the bridge, which is the wrong machine for a pinned server', () => {
  it('skips it the way it skips a disabled one, and says where it went', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-location-'));
    try {
      const configPath = join(root, 'mcp.json');
      await writeFile(
        configPath,
        JSON.stringify({
          servers: {
            here: { url: 'https://mcp.test/mcp', trusted: true },
            there: { url: 'http://homeassistant.local:8123/mcp', trusted: true, location: { deviceId: 'dev-1' } }
          }
        })
      );
      process.env.STEM_MCP_CONFIG = configPath;

      const reached: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          reached.push(String(input));
          const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
          const result = request.method === 'tools/list' ? { tools: [] } : {};
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
      await stemMcpBridge(fakePi);
      await mcpConnectionsSettledForTests();

      const status = JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')) as Record<
        string,
        { status: string }
      >;
      expect(status.here.status).toBe('ready');
      // Reported, not omitted: a server missing from the status map reads as one
      // that was never configured, and the panel has to be able to name its place.
      expect(status.there.status).toBe('elsewhere');
      // The point of the pin: this process never opened that LAN address, which
      // from a VPS would not resolve at all.
      expect(reached.some((url) => url.includes('homeassistant.local'))).toBe(false);
    } finally {
      resetMcpConnectionCacheForTests();
      vi.unstubAllGlobals();
      delete process.env.STEM_MCP_CONFIG;
      await rm(root, { recursive: true, force: true });
    }
  });
});
