// Editing an MCP server in place (the panel's Edit…).
//
// Before this, "edit" meant re-adding under the same name, which replaced the
// whole entry: the form could not show a stored token back, so changing the
// URL beside one meant retyping it, and the form's "Runs on" defaulted to the
// server, so an edit of a server pinned to your Mac quietly moved it away.
// What is checked here is exactly those two things — what the form is shown,
// and what survives a save — plus the credential rule an add already has.

import { beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { addMcpServer, getMcpServer, updateMcpServer } from '../../src/server/pi/mcp';
import {
  mcpServerAuthIdentity,
  piMcpOAuthPath,
  readMcpConfig,
  readOAuthTokens,
  saveOAuthToken,
  writeMcpConfig
} from '../../src/server/pi/mcp-config';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, mintDevice, readDevices } from '../../src/server/transport/auth';
import { devicesStorePath, piMcpConfigPath } from '../../src/server/workspace/paths';
import { MCP_SECRET_MASK } from '../../src/shared/types';

beforeEach(async () => {
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  rmSync(piMcpConfigPath(), { force: true });
  rmSync(piMcpOAuthPath(), { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock.reaper`, { force: true });
  await readDevices().catch(() => undefined);
  rmSync(devicesStorePath(), { force: true });
  forgetCachedDevices();
});

describe('what the Edit form is shown', () => {
  it('masks values whose name says credential and shows the rest', async () => {
    await addMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: 'eyJ.secret' }
    });
    expect(await getMcpServer('ha')).toEqual({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      url: '',
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: MCP_SECRET_MASK },
      headers: {},
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: ''
    });
  });

  it('masks bearer headers and the OAuth client secret of a URL server', async () => {
    await addMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: 'Bearer x', 'X-Team': 'eng' },
      oauthClientId: 'client-1',
      oauthClientSecret: 'shh',
      oauthScope: 'chat:write'
    });
    expect(await getMcpServer('slack')).toMatchObject({
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: MCP_SECRET_MASK, 'X-Team': 'eng' },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK,
      oauthScope: 'chat:write'
    });
  });

  it('refuses a name that is not there', async () => {
    await expect(getMcpServer('nope')).rejects.toThrow('No MCP server named "nope"');
  });
});

describe('saving an edit', () => {
  it('changes one env var, keeps the masked token, and keeps where it runs and whether it is on', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: 'eyJ.secret' },
      location: { deviceId: device.id }
    });
    await writeMcpConfig({
      servers: { ...(await readMcpConfig()).servers, ha: { ...(await readMcpConfig()).servers.ha, disabled: true } }
    });

    // What the form sends back: the URL retyped, the token as it was shown.
    const list = await updateMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp==8.4.3'],
      env: { HOMEASSISTANT_URL: 'http://192.168.1.25:8123', HOMEASSISTANT_TOKEN: MCP_SECRET_MASK }
    });

    const stored = (await readMcpConfig()).servers.ha;
    expect(stored).toEqual({
      command: 'uvx',
      args: ['ha-mcp==8.4.3'],
      env: { HOMEASSISTANT_URL: 'http://192.168.1.25:8123', HOMEASSISTANT_TOKEN: 'eyJ.secret' },
      trusted: true,
      location: { deviceId: device.id, label: 'Ada’s MacBook' },
      disabled: true
    });
    expect(list.find((s) => s.name === 'ha')).toMatchObject({
      enabled: false,
      location: { deviceId: device.id, label: 'Ada’s MacBook' }
    });
  });

  it('takes a retyped secret and drops a masked key that has nothing stored under it', async () => {
    await addMcpServer({ name: 'ha', transport: 'stdio', command: 'uvx', env: { HOMEASSISTANT_TOKEN: 'old' } });
    await updateMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      env: { HOMEASSISTANT_TOKEN: 'new', OTHER_TOKEN: MCP_SECRET_MASK }
    });
    expect((await readMcpConfig()).servers.ha.env).toEqual({ HOMEASSISTANT_TOKEN: 'new' });
  });

  it('keeps the OAuth token when the URL and credentials did not change, and revokes it when they did', async () => {
    await addMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: 'Bearer x' },
      oauthClientId: 'client-1',
      oauthClientSecret: 'shh'
    });
    const identity = mcpServerAuthIdentity((await readMcpConfig()).servers.slack)!;
    await saveOAuthToken('slack', {
      serverIdentity: identity,
      resource: 'https://mcp.slack.test/mcp',
      tokenEndpoint: 'https://mcp.slack.test/token',
      clientId: 'client-1',
      scope: 'chat:write',
      accessToken: 'at',
      expiresAt: Date.now() + 60_000
    });

    // Same identity, sent back through the mask: the token is still that server's.
    await updateMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: MCP_SECRET_MASK },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK
    });
    expect((await readMcpConfig()).servers.slack.oauthClientSecret).toBe('shh');
    expect((await readOAuthTokens()).slack?.accessToken).toBe('at');

    // A new URL is a new server as far as a credential is concerned.
    await updateMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/v2/mcp',
      headers: { Authorization: MCP_SECRET_MASK },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK
    });
    expect((await readOAuthTokens()).slack).toBeUndefined();
  });

  it('refuses to change the transport or to edit a server that is not there', async () => {
    await addMcpServer({ name: 'ha', transport: 'stdio', command: 'uvx' });
    await expect(
      updateMcpServer({ name: 'ha', transport: 'http', url: 'https://x.test/mcp' })
    ).rejects.toThrow('keeps its transport');
    await expect(updateMcpServer({ name: 'nope', transport: 'stdio', command: 'x' })).rejects.toThrow(
      'No MCP server named "nope"'
    );
  });
});
