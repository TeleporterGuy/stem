import { beforeEach, describe, expect, it } from 'vitest';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { addMcpServer, removeMcpServer } from '../../src/main/pi/mcp';
import { persistBridgeOAuthToken } from '../../src/main/pi/stem-mcp-extension.mjs';
import {
  piMcpOAuthPath,
  deleteOAuthTokenIfMatches,
  ensureMcpConfig,
  mcpServerAuthIdentity,
  migrateLegacyOAuthTokens,
  readMcpConfig,
  readOAuthTokens,
  saveOAuthToken,
  saveOAuthTokenIfServerMatches,
  writeMcpConfig
} from '../../src/main/pi/mcp-config';
import { secretKeyHex } from '../../src/main/pi/secrets';
import { piMcpConfigPath } from '../../src/main/workspace/paths';

beforeEach(() => {
  // In production PiRuntime hands the bridge the secrets key via the env at
  // spawn; the bridge functions under test read it the same way.
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  rmSync(piMcpConfigPath(), { force: true });
  rmSync(piMcpOAuthPath(), { force: true });
  rmSync(`${piMcpOAuthPath()}.lock`, { force: true });
  rmSync(`${piMcpOAuthPath()}.lock.reaper`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock.reaper`, { force: true });
});

describe('MCP configuration mutations', () => {
  it('preserves every concurrently added server', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => addMcpServer({
        name: `server-${i}`,
        transport: 'stdio' as const,
        command: '/bin/echo',
        args: [String(i)]
      })),
      ...Array.from({ length: 10 }, () => ensureMcpConfig())
    ]);
    const config = await readMcpConfig();
    expect(Object.keys(config.servers).filter((name) => name.startsWith('server-'))).toHaveLength(20);
  });

  it('preserves every concurrently saved OAuth token', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => saveOAuthToken(`remote-${i}`, {
      resource: `https://server-${i}.example/mcp`,
      tokenEndpoint: `https://server-${i}.example/token`,
      clientId: `client-${i}`,
      scope: 'tools',
      accessToken: `token-${i}`,
      expiresAt: 0
    })));
    expect(Object.keys(await readOAuthTokens())).toHaveLength(20);
  });

  it('coordinates OAuth refresh writes from the bridge with main-process saves', async () => {
    const token = (name: string) => ({
      resource: `https://${name}.example/mcp`,
      tokenEndpoint: `https://${name}.example/token`,
      clientId: name,
      scope: 'tools',
      accessToken: `token-${name}`,
      expiresAt: 0
    });
    const servers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
      `bridge-${i}`,
      { url: `https://bridge-${i}.example/mcp`, trusted: true }
    ]));
    await writeMcpConfig({ servers });
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      i % 2 === 1 ? saveOAuthToken(`bridge-${i}`, token(`bridge-${i}`)) : Promise.resolve()
    ));
    await Promise.all(Array.from({ length: 20 }, (_, i) => {
      if (i % 2 === 0) return saveOAuthToken(`main-${i}`, token(`main-${i}`));
      const name = `bridge-${i}`;
      return persistBridgeOAuthToken(
        piMcpOAuthPath(),
        piMcpConfigPath(),
        name,
        token(name),
        mcpServerAuthIdentity(servers[name])!,
        { ...token(name), accessToken: `refreshed-${name}` }
      );
    }));
    expect(Object.keys(await readOAuthTokens())).toHaveLength(20);
  });

  it('does not let an old bridge refresh overwrite a newer login or resurrect a removed token', async () => {
    await addMcpServer({ name: 'remote', transport: 'http', url: 'https://remote.example/mcp' });
    const identity = mcpServerAuthIdentity((await readMcpConfig()).servers.remote)!;
    const oldToken = {
      resource: 'https://remote.example/mcp',
      tokenEndpoint: 'https://remote.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'old-token',
      expiresAt: 0
    };
    const newToken = { ...oldToken, accessToken: 'new-browser-login' };
    const staleRefresh = { ...oldToken, accessToken: 'stale-refreshed-token' };
    await saveOAuthToken('remote', oldToken);
    await saveOAuthToken('remote', newToken);
    await expect(persistBridgeOAuthToken(
      piMcpOAuthPath(), piMcpConfigPath(), 'remote', oldToken, identity, staleRefresh
    )).resolves.toBe(false);
    expect((await readOAuthTokens()).remote?.accessToken).toBe('new-browser-login');

    await removeMcpServer('remote');
    await expect(persistBridgeOAuthToken(
      piMcpOAuthPath(), piMcpConfigPath(), 'remote', newToken, identity, staleRefresh
    )).resolves.toBe(false);
    expect((await readOAuthTokens()).remote).toBeUndefined();
  });

  it('serializes two writers that concurrently recover an abandoned OAuth lock', async () => {
    await addMcpServer({ name: 'remote', transport: 'http', url: 'https://remote.example/mcp' });
    const identity = mcpServerAuthIdentity((await readMcpConfig()).servers.remote)!;
    const token = {
      resource: 'https://remote.example/mcp',
      tokenEndpoint: 'https://remote.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'initial',
      expiresAt: 0
    };
    await saveOAuthTokenIfServerMatches('remote', identity, token);
    const expected = (await readOAuthTokens()).remote;
    const lockPath = `${piMcpOAuthPath()}.lock`;
    writeFileSync(lockPath, 'abandoned');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await Promise.all([
      persistBridgeOAuthToken(
        piMcpOAuthPath(),
        piMcpConfigPath(),
        'remote',
        expected,
        identity,
        { ...expected, accessToken: 'refreshed' }
      ),
      saveOAuthToken('other', { ...token, accessToken: 'other' })
    ]);
    const tokens = await readOAuthTokens();
    expect(tokens.remote?.accessToken).toBe('refreshed');
    expect(tokens.other?.accessToken).toBe('other');
  });

  it('drops a name-keyed OAuth token when that name is repointed to a new server', async () => {
    await addMcpServer({ name: 'remote', transport: 'http', url: 'https://old.example/mcp' });
    const oldIdentity = mcpServerAuthIdentity((await readMcpConfig()).servers.remote)!;
    await saveOAuthToken('remote', {
      resource: 'https://old.example/mcp',
      tokenEndpoint: 'https://old.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'old-secret-token',
      expiresAt: 0
    });

    await addMcpServer({ name: 'remote', transport: 'http', url: 'https://new.example/mcp' });
    expect((await readOAuthTokens()).remote).toBeUndefined();
    await expect(saveOAuthTokenIfServerMatches(
      'remote',
      oldIdentity,
      {
        resource: 'https://old.example/mcp',
        tokenEndpoint: 'https://old.example/token',
        clientId: 'client',
        scope: 'tools',
        accessToken: 'late-login-token',
        expiresAt: 0
      }
    )).resolves.toBe(false);
    expect((await readOAuthTokens()).remote).toBeUndefined();
  });

  it('invalidates OAuth when static auth headers replace it at the same URL', async () => {
    await addMcpServer({ name: 'remote', transport: 'http', url: 'https://same.example/mcp' });
    const identity = mcpServerAuthIdentity((await readMcpConfig()).servers.remote)!;
    await expect(saveOAuthTokenIfServerMatches('remote', identity, {
      resource: 'https://same.example/mcp',
      tokenEndpoint: 'https://same.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'oauth-token',
      expiresAt: 0
    })).resolves.toBe(true);
    expect((await readOAuthTokens()).remote?.serverIdentity).toBe(identity);

    await addMcpServer({
      name: 'remote',
      transport: 'http',
      url: 'https://same.example/mcp',
      headers: { Authorization: 'Bearer static-token' }
    });
    expect((await readOAuthTokens()).remote).toBeUndefined();
  });

  it('stamps pre-migration tokens with their current server identity, and only those', async () => {
    const servers = {
      kept: { url: 'https://kept.example/mcp', trusted: true },
      repointed: { url: 'https://after.example/mcp', trusted: true }
    };
    await writeMcpConfig({ servers });
    const base = {
      resource: 'https://kept.example/mcp',
      tokenEndpoint: 'https://kept.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'secret',
      expiresAt: 0
    };
    // Legacy (pre-stamp) token for a live server, a token whose server is gone,
    // and an already-stamped token for a server since repointed to a new URL.
    await saveOAuthToken('kept', base);
    await saveOAuthToken('orphan', base);
    await saveOAuthToken('repointed', { ...base, serverIdentity: 'stale-identity' });

    await migrateLegacyOAuthTokens();

    const tokens = await readOAuthTokens();
    expect(tokens.kept?.serverIdentity).toBe(mcpServerAuthIdentity(servers.kept)!);
    expect(tokens.kept?.accessToken).toBe('secret');
    expect(tokens.orphan?.serverIdentity).toBeUndefined();
    expect(tokens.repointed?.serverIdentity).toBe('stale-identity');
  });

  it('does not let stale cleanup delete a newer OAuth login', async () => {
    const oldToken = {
      resource: 'https://remote.example/mcp',
      tokenEndpoint: 'https://remote.example/token',
      clientId: 'client',
      scope: 'tools',
      accessToken: 'old-token',
      expiresAt: 0
    };
    const newToken = { ...oldToken, accessToken: 'new-token' };
    await saveOAuthToken('remote', oldToken);
    await saveOAuthToken('remote', newToken);
    expect(await deleteOAuthTokenIfMatches('remote', oldToken)).toBe(false);
    expect((await readOAuthTokens()).remote?.accessToken).toBe('new-token');
  });
});
