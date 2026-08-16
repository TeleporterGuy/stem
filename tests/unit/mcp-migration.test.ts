// Moving a pinned MCP server, and what happens to one whose machine went away
// (docs/mcp-device-pinning.md, step 5 and decision ⑩).
//
// Two things are being protected here, and both are easy to get wrong in a way
// no type catches.
//
// The move is a ONE-FIELD edit of an entry that already exists. Rebuilding the
// entry from what the panel can see would silently drop `env`, `headers` and the
// OAuth token — the panel is never given any of them — so the tests below move a
// server that carries all three and then look for them.
//
// An orphan is an entry pinned to a device that was unpaired. It must stay,
// visibly and named, rather than being deleted or quietly repointed at the
// server; the assistant must stop being told it can call its tools; and a call
// that does reach the router must be refused with the sentence for a machine
// that is gone, not the one for a machine that is asleep.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  addMcpServer,
  listMcpServers,
  setMcpServerLocation,
  withStoredLocation
} from '../../src/server/pi/mcp';
import {
  mcpServerAuthIdentity,
  oauthTokenMatchesServer,
  piMcpOAuthPath,
  readMcpConfig,
  readOAuthTokens,
  saveOAuthToken
} from '../../src/server/pi/mcp-config';
import { createDeviceMcpRouter, closeDeviceMcpRouter, deviceMcpRouter } from '../../src/server/mcp-device/router';
import { emptyCatalog, type DeviceMcpCatalogStore } from '../../src/server/mcp-device/catalog';
import { registerDevicesIpc } from '../../src/server/ipc/devices';
import { dispatchLocal } from '../../src/server/ipc/guard';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, mintDevice, readDevices } from '../../src/server/transport/auth';
import { devicesStorePath, piMcpConfigPath, piMcpDeviceCatalogPath } from '../../src/server/workspace/paths';
import type { DeviceMcpCatalog, DeviceMcpRequest } from '../../src/shared/types';

beforeEach(async () => {
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  rmSync(piMcpConfigPath(), { force: true });
  rmSync(piMcpOAuthPath(), { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock.reaper`, { force: true });
  rmSync(piMcpDeviceCatalogPath(), { force: true });
  // The registry stamps lastSeenAt behind the request; drain its queue before
  // wiping the file so a previous test's write cannot land on this one.
  await readDevices().catch(() => undefined);
  rmSync(devicesStorePath(), { force: true });
  forgetCachedDevices();
  closeDeviceMcpRouter();
});

afterEach(() => {
  closeDeviceMcpRouter();
});

describe('moving a server to another machine', () => {
  it('changes where it runs and nothing else — command, credentials and sign-in survive', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'lan',
      transport: 'http',
      url: 'http://homeassistant.local:8123/mcp',
      headers: { Authorization: 'Bearer secret' }
    });
    // A sign-in already stored against this server, which is the thing a move
    // built out of add+remove would take with it.
    const stored = (await readMcpConfig()).servers.lan;
    await saveOAuthToken('lan', {
      serverIdentity: mcpServerAuthIdentity(stored)!,
      resource: 'http://homeassistant.local:8123/mcp',
      tokenEndpoint: 'http://homeassistant.local:8123/token',
      clientId: 'client-1',
      scope: 'read',
      accessToken: 'access-1',
      expiresAt: 0
    });

    const list = await setMcpServerLocation('lan', device.id);

    expect(list[0].location).toEqual({ deviceId: device.id, label: 'Ada’s MacBook' });
    const moved = (await readMcpConfig()).servers.lan;
    // The id, plus the label it had at this moment — a snapshot, so an entry
    // orphaned by a later re-pairing can still name the machine it meant.
    expect(moved.location).toEqual({ deviceId: device.id, label: 'Ada’s MacBook' });
    expect(moved.url).toBe('http://homeassistant.local:8123/mcp');
    // The header still decrypts, i.e. the entry was edited rather than rewritten
    // from the summary the panel holds — which has no headers in it at all.
    expect(moved.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(await readFile(piMcpConfigPath(), 'utf8')).not.toContain('Bearer secret');
    // And the sign-in is still this server's: `location` is outside the auth
    // identity on purpose, so moving a server does not sign it out.
    const tokens = await readOAuthTokens();
    expect(oauthTokenMatchesServer(tokens.lan, moved)).toBe(true);
  });

  it('leaves no trace of the pin when a server is moved back to the server', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      args: ['--root', '/Users/ada'],
      env: { API_KEY: 'k' },
      location: { deviceId: device.id }
    });

    const list = await setMcpServerLocation('files', null);

    expect(list[0].location).toBeUndefined();
    const back = (await readMcpConfig()).servers.files;
    // Absent, not null and not undefined-as-a-key: "runs where stem-server runs"
    // has always been the absence of this field, and an entry moved back has to
    // be indistinguishable from one that was never pinned.
    expect('location' in back).toBe(false);
    expect(back.env).toEqual({ API_KEY: 'k' });
    expect(back.args).toEqual(['--root', '/Users/ada']);
  });

  it('refuses the two machines that cannot host one, and changes nothing when it does', async () => {
    const { device } = await mintDevice('Ada’s iPhone', 'mobile');
    await addMcpServer({ name: 'files', transport: 'stdio', command: '/usr/bin/mcp-files' });

    await expect(setMcpServerLocation('files', device.id)).rejects.toThrow(/goes to sleep/);
    await expect(setMcpServerLocation('files', 'nobody')).rejects.toThrow(/not paired/);
    expect('location' in (await readMcpConfig()).servers.files).toBe(false);
  });

  it('is the only thing that moves a server: the assistant re-adding one keeps its pin', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      location: { deviceId: device.id }
    });

    // What `add_mcp_server` produces: a whole entry, with no notion of where it
    // runs. Applied as-is it would move the server back here, in the middle of a
    // change the user approved for a different reason.
    const proposed = { name: 'files', transport: 'stdio' as const, command: '/usr/bin/mcp-files', args: ['--v2'] };
    await addMcpServer(await withStoredLocation(proposed));

    const after = (await readMcpConfig()).servers.files;
    expect(after.location).toEqual({ deviceId: device.id, label: device.label });
    expect(after.args).toEqual(['--v2']);
    // A caller that DID name a place still decides: the panel's Add form with
    // "Runs on: Server" picked has said something, and it is not this.
    expect(await withStoredLocation({ ...proposed, location: { deviceId: 'somewhere-else' } })).toMatchObject({
      location: { deviceId: 'somewhere-else' }
    });
  });

  it('refuses a name it does not have, and a reserved one', async () => {
    await expect(setMcpServerLocation('ghost', null)).rejects.toThrow(/No MCP server named/);
    await expect(setMcpServerLocation('stem-recall', null)).rejects.toThrow(/reserved/);
  });
});

describe('a device that is unpaired, from the routing side', () => {
  let stored: DeviceMcpCatalog;
  const memoryCatalog: DeviceMcpCatalogStore = {
    read: () => Promise.resolve(stored),
    write: (next) => {
      stored = next;
      return Promise.resolve();
    }
  };

  beforeEach(() => {
    stored = emptyCatalog();
  });

  it('refuses a call with the sentence for a machine that is gone, not one that is asleep', async () => {
    const router = createDeviceMcpRouter({
      pushTo: () => 1,
      connectedDevices: () => new Set<string>(),
      // What the wired one answers for an id that is not in the registry.
      deviceLabel: () => Promise.resolve(null),
      readServers: () => Promise.resolve({}),
      catalog: memoryCatalog
    });
    const result = (await router.callTool('gone', 'files', 'read_file', {})) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('files');
    expect(result.error).toContain('no longer paired');
    // The other sentence promises the tools come back when the machine wakes up,
    // which for an unpaired computer is advice that never comes true.
    expect(result.error).not.toContain('is awake');
    router.close();
  });

  it('forgets what that machine hosted and answers anything still in flight', async () => {
    vi.useFakeTimers();
    try {
      const sent: DeviceMcpRequest[] = [];
      const router = createDeviceMcpRouter({
        pushTo: (_deviceId, _name, data) => {
          sent.push(data as DeviceMcpRequest);
          return 1;
        },
        connectedDevices: () => new Set(['mac']),
        deviceLabel: () => Promise.resolve('“Ada’s MacBook”'),
        readServers: () => Promise.resolve({}),
        catalog: memoryCatalog
      });
      await router.announce('mac', { servers: [{ name: 'files', status: 'ready', tools: [{ name: 'read_file' }] }] });
      const call = router.callTool('mac', 'files', 'read_file', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);

      await router.forget('mac');

      // Nothing waits out two minutes for a machine whose streams were cut by
      // the same revocation.
      await expect(call).resolves.toEqual({ ok: false, error: expect.stringContaining('unpaired') });
      expect((await router.catalog()).devices.mac).toBeUndefined();
      router.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unpairing a device, through the channel that does it', () => {
  it('drops what it announced but keeps the pin, marked orphaned', async () => {
    registerDevicesIpc();
    const { device } = await mintDevice('Old laptop');
    await addMcpServer({
      name: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      location: { deviceId: device.id }
    });
    await deviceMcpRouter().announce(device.id, {
      servers: [{ name: 'files', status: 'ready', tools: [{ name: 'read_file' }] }]
    });

    await dispatchLocal('devices:revoke', [device.id]);

    // The claim made to the model goes: a tool on a machine that can no longer
    // reach this Stem is not a capability it has.
    expect((await deviceMcpRouter().catalog()).devices[device.id]).toBeUndefined();
    // The user's configuration does not. Re-pairing that computer, moving the
    // server, or removing it are all decisions only they get to make.
    expect((await readMcpConfig()).servers.files.location).toEqual({ deviceId: device.id, label: device.label });
    const [summary] = await listMcpServers();
    // Orphaned, and able to say which computer it was — the machine is very
    // probably still on the desk, wearing a new device id after a re-pairing.
    expect(summary.location).toEqual({
      deviceId: device.id,
      label: 'Unpaired device',
      orphaned: true,
      rememberedLabel: device.label
    });
  });
});
