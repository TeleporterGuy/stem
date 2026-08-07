// client.json: the first client-side state Stem has ever had, and the only place
// this machine's bearer token exists now that the server keeps hashes.
//
// Two things matter. The token must be wrapped when the platform can wrap it (the
// setup file installs a reversible stand-in for the keychain), and a wrapper that
// has stopped working must degrade to "no identity" rather than to a crash — a
// device that cannot read its credential has to be able to acquire a new one,
// which is a thing it can only do while it is still running.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setHost } from '../../src/server/host';
import { clientStorePath, readClientIdentity, writeClientIdentity } from '../../src/desktop/client-store';

const path = clientStorePath();

/** The stand-in wrapper tests/setup-unit.ts installs, restored after each test. */
const STUB_WRAPPER = {
  wrap: (plain: string) => Buffer.from(`stub-wrapped:${plain}`, 'utf8'),
  unwrap: (wrapped: Buffer) => {
    const text = wrapped.toString('utf8');
    if (!text.startsWith('stub-wrapped:')) throw new Error('not stub-wrapped ciphertext');
    return text.slice('stub-wrapped:'.length);
  }
};

beforeEach(() => {
  rmSync(path, { force: true });
});

afterEach(() => {
  rmSync(path, { force: true });
  setHost({ keyWrapper: () => STUB_WRAPPER });
});

describe('storing this device\'s identity', () => {
  it('round-trips it, wrapped, and never leaves the token readable', async () => {
    const token = 'a'.repeat(64);
    await writeClientIdentity({ deviceId: 'dev-1', token });

    expect(await readClientIdentity()).toEqual({ deviceId: 'dev-1', token });
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk).token).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('falls back to 0600 plaintext where there is no keyring, rather than to nothing', async () => {
    // A Linux box with no keyring is a supported way to run Stem. The same
    // documented degradation pi/secrets.ts takes, for the same reason.
    setHost({ keyWrapper: () => null });
    await writeClientIdentity({ deviceId: 'dev-2', token: 'b'.repeat(64) });

    expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('b'.repeat(64));
    expect(await readClientIdentity()).toEqual({ deviceId: 'dev-2', token: 'b'.repeat(64) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('reading an identity back', () => {
  it('reports none when the wrapper can no longer unwrap it', async () => {
    await writeClientIdentity({ deviceId: 'dev-3', token: 'c'.repeat(64) });
    // A reset keychain, or a profile copied to another machine. The credential is
    // simply gone — and saying so is what lets the caller pair again instead of
    // failing to start.
    setHost({
      keyWrapper: () => ({
        wrap: STUB_WRAPPER.wrap,
        unwrap: () => {
          throw new Error('the keychain said no');
        }
      })
    });
    expect(await readClientIdentity()).toBeNull();
  });

  it('reports none for an absent, empty or half-written file', async () => {
    expect(await readClientIdentity()).toBeNull();
    writeFileSync(path, '{"version":1,"deviceId":"dev-4"', 'utf8');
    expect(await readClientIdentity()).toBeNull();
    // Present and parseable, but carrying no credential at all.
    writeFileSync(path, JSON.stringify({ version: 1, deviceId: 'dev-4' }), 'utf8');
    expect(await readClientIdentity()).toBeNull();
  });
});
