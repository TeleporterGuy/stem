// Secrets-at-rest suite: the safeStorage-wrapped key (pi/secrets.ts, via the
// reversible electron-stub fake), the encrypted mcp.json fields and
// mcp-oauth.json envelope, the plaintext→encrypted boot migration, and the
// bridge extension's crypto twin operating on the same files with the same key
// (handed to it via STEM_SECRET_KEY, as PiRuntime does at spawn).
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  decryptSecretValue,
  encryptSecretValue,
  secretKeyAvailable,
  secretKeyHex
} from '../../src/server/pi/secrets';
import {
  mcpServerAuthIdentity,
  migrateLegacyOAuthTokens,
  piMcpOAuthPath,
  readMcpConfig,
  readOAuthTokens,
  saveOAuthToken,
  writeMcpConfig
} from '../../src/server/pi/mcp-config';
import { persistBridgeOAuthToken } from '../../src/server/pi/stem-mcp-extension.mjs';
import { SECRET_ENVELOPE_KEY, SECRET_VALUE_PREFIX } from '../../src/server/pi/protocol';
import { piMcpConfigPath, secretKeyPath } from '../../src/server/workspace/paths';

const TOKEN = {
  resource: 'https://remote.example/mcp',
  tokenEndpoint: 'https://remote.example/token',
  clientId: 'client',
  scope: 'tools',
  accessToken: 'super-secret-access-token',
  refreshToken: 'super-secret-refresh-token',
  expiresAt: 0
};

beforeEach(() => {
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  for (const p of [piMcpConfigPath(), piMcpOAuthPath(), `${piMcpOAuthPath()}.lock`, `${piMcpConfigPath()}.state.lock`]) {
    rmSync(p, { force: true });
  }
});

describe('secret values', () => {
  it('provisions a wrapped key and round-trips a value', () => {
    expect(secretKeyAvailable()).toBe(true);
    // The on-disk key is safeStorage-wrapped (the test stub's wrap is a
    // transparent tag, so only the wrapping itself is asserted here).
    expect(readFileSync(secretKeyPath(), 'utf8')).toContain('stub-wrapped:');
    const sealed = encryptSecretValue('hunter2');
    expect(sealed.startsWith(SECRET_VALUE_PREFIX)).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(decryptSecretValue(sealed)).toBe('hunter2');
    // Distinct IV per call — equal plaintexts never produce equal ciphertexts.
    expect(encryptSecretValue('hunter2')).not.toBe(sealed);
  });

  it('passes legacy plaintext through and nulls tampered ciphertext', () => {
    expect(decryptSecretValue('plain-old-value')).toBe('plain-old-value');
    const sealed = encryptSecretValue('hunter2');
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(decryptSecretValue(tampered)).toBeNull();
    expect(decryptSecretValue(`${SECRET_VALUE_PREFIX}not-base64!`)).toBeNull();
  });
});

describe('mcp-oauth.json at rest', () => {
  it('stores tokens as an envelope with no plaintext secrets on disk', async () => {
    await saveOAuthToken('remote', TOKEN);
    const raw = readFileSync(piMcpOAuthPath(), 'utf8');
    expect(raw).toContain(SECRET_ENVELOPE_KEY);
    expect(raw).not.toContain(TOKEN.accessToken);
    expect(raw).not.toContain(TOKEN.refreshToken);
    expect((await readOAuthTokens()).remote).toEqual(TOKEN);
  });

  it('migrates a legacy plaintext token file to the encrypted envelope', async () => {
    const servers = { remote: { url: 'https://remote.example/mcp', trusted: true } };
    await writeMcpConfig({ servers });
    writeFileSync(piMcpOAuthPath(), JSON.stringify({ remote: TOKEN }, null, 2));

    await migrateLegacyOAuthTokens();

    const raw = readFileSync(piMcpOAuthPath(), 'utf8');
    expect(raw).toContain(SECRET_ENVELOPE_KEY);
    expect(raw).not.toContain(TOKEN.accessToken);
    const migrated = (await readOAuthTokens()).remote;
    expect(migrated?.accessToken).toBe(TOKEN.accessToken);
    expect(migrated?.serverIdentity).toBe(mcpServerAuthIdentity(servers.remote)!);
  });

  it('reads an undecryptable envelope as empty instead of throwing', async () => {
    writeFileSync(
      piMcpOAuthPath(),
      JSON.stringify({ [SECRET_ENVELOPE_KEY]: `${SECRET_VALUE_PREFIX}${'A'.repeat(64)}` })
    );
    await expect(readOAuthTokens()).resolves.toEqual({});
  });
});

describe('mcp.json auth fields at rest', () => {
  const SERVERS = {
    remote: {
      url: 'https://remote.example/mcp',
      headers: { Authorization: 'Bearer static-bearer-secret' },
      oauthClientSecret: 'confidential-client-secret',
      trusted: true
    },
    local: {
      command: '/bin/echo',
      env: { API_KEY: 'stdio-env-secret' },
      trusted: true
    }
  };

  it('encrypts headers, stdio env, and the client secret; reads back plaintext', async () => {
    await writeMcpConfig({ servers: SERVERS });
    const raw = readFileSync(piMcpConfigPath(), 'utf8');
    for (const secret of ['static-bearer-secret', 'confidential-client-secret', 'stdio-env-secret']) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain(SECRET_VALUE_PREFIX);
    // Non-secret structure stays readable for debugging.
    expect(raw).toContain('https://remote.example/mcp');
    expect((await readMcpConfig()).servers).toEqual(SERVERS);
  });

  it('keeps token identity stamps stable across the encrypted round-trip', async () => {
    const before = mcpServerAuthIdentity(SERVERS.remote)!;
    await writeMcpConfig({ servers: SERVERS });
    expect(mcpServerAuthIdentity((await readMcpConfig()).servers.remote)).toBe(before);
  });

  it('lets the bridge refresh a token against the encrypted files', async () => {
    await writeMcpConfig({ servers: SERVERS });
    const identity = mcpServerAuthIdentity(SERVERS.remote)!;
    await saveOAuthToken('remote', { ...TOKEN, serverIdentity: identity });
    const expected = (await readOAuthTokens()).remote!;

    await expect(
      persistBridgeOAuthToken(piMcpOAuthPath(), piMcpConfigPath(), 'remote', expected, identity, {
        ...expected,
        accessToken: 'bridge-refreshed-token'
      })
    ).resolves.toBe(true);

    const raw = readFileSync(piMcpOAuthPath(), 'utf8');
    expect(raw).not.toContain('bridge-refreshed-token');
    expect((await readOAuthTokens()).remote?.accessToken).toBe('bridge-refreshed-token');
  });
});
