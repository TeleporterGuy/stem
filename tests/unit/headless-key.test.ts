// The seam the whole migration balances on: a state root exported from a Mac,
// imported on a server, and then OPENED by a container that has no keychain and
// one mounted file.
//
// Every other part of the move announces itself when it goes wrong — a chat that
// did not arrive is a chat that is not there. This part does not. If the
// container's key wrapper reads the passphrase by a different rule than
// `stem-server import` did (one trailing newline, or not), the data key does not
// unwrap, pi/secrets.ts mints a fresh one over the top, and every MCP sign-in in
// the archive becomes unreadable ciphertext — silently, on first boot, with the
// old key gone. So the round trip is exercised here end to end rather than each
// half being checked against its own idea of what the other does.
//
// The passphrase file below is written the way a person writes one — `echo`, with
// the newline that comes with it — because that is the case where the two rules
// differ.

import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { host, resetHostForTests, setHost } from '../../src/server/host';
import { passphraseKeyWrapper } from '../../src/server/host/passphrase-key';
import { decryptSecretValue, secretKeyAvailable } from '../../src/server/pi/secrets';
import { SECRET_VALUE_PREFIX } from '../../src/server/pi/protocol';
import { exportState, importState } from '../../src/server/workspace/state-transfer';

const PASSPHRASE = 'a passphrase for the container';
const DATA_KEY = 'ab'.repeat(32);
const CREDENTIAL = 'Bearer the-token-that-must-survive';

/** setup-unit.ts's stand-in for the Keychain — the Mac end of the journey. */
const KEYCHAIN = {
  wrap: (plain: string) => Buffer.from(`stub-wrapped:${plain}`, 'utf8'),
  unwrap: (wrapped: Buffer) => {
    const text = wrapped.toString('utf8');
    if (!text.startsWith('stub-wrapped:')) throw new Error('not stub-wrapped ciphertext');
    return text.slice('stub-wrapped:'.length);
  }
};

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stem-headless-key-'));
  scratches.push(dir);
  return dir;
}

/** One MCP credential as pi/secrets.ts writes it: AES-256-GCM under the data key. */
function encrypted(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(DATA_KEY, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SECRET_VALUE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.STEM_KEY_FILE;
});

describe('the key file a container has instead of a keychain', () => {
  it('is absent on an ordinary machine, and that is the plaintext fallback, not a failure', () => {
    // `stem-server` on somebody's own Linux box has no /run/secrets. It must not
    // start refusing to run because of a path only a container ever has: the
    // 0600-plaintext degradation is the documented behaviour and stays.
    resetHostForTests();
    process.env.STEM_KEY_FILE = join(tmpdir(), `stem-no-such-key-${process.pid}`);
    expect(host().keyWrapper()).toBeNull();
  });

  it('will not be talked into opening a key it cannot actually open', () => {
    resetHostForTests();
    const keyFile = join(scratch(), 'stem_key');
    writeFileSync(keyFile, 'the wrong passphrase entirely\n', { mode: 0o600 });
    process.env.STEM_KEY_FILE = keyFile;
    const wrapper = host().keyWrapper();
    expect(wrapper).not.toBeNull();
    // Wrong, and it says so. The alternative — returning rubbish — is what would
    // put a corrupt data key into pi/secrets.ts.
    expect(() => wrapper!.unwrap(passphraseKeyWrapper(PASSPHRASE).wrap(DATA_KEY))).toThrow(/Wrong passphrase/);
  });

  it('opens the MCP credentials of a Stem that was exported here and imported there', async () => {
    // ---- on the Mac ----
    const from = scratch();
    setHost({ stateRoot: () => from, keyWrapper: () => KEYCHAIN });
    process.env.STEM_SECRET_KEY_FILE = join(from, 'pi-home', 'secret.key');
    mkdirSync(join(from, 'pi-home'), { recursive: true });
    writeFileSync(join(from, 'pi-home', 'secret.key'), KEYCHAIN.wrap(DATA_KEY), { mode: 0o600 });
    writeFileSync(
      join(from, 'pi-home', 'mcp.json'),
      JSON.stringify({ servers: { fastmail: { url: 'https://api.fastmail.com/mcp', headers: { Authorization: encrypted(CREDENTIAL) } } } })
    );

    const archive = join(scratch(), 'move.tar');
    expect((await exportState({ out: archive, passphrase: PASSPHRASE })).secrets).toBe('rewrapped');

    // ---- on the server, before the container is up ----
    const to = scratch();
    setHost({ stateRoot: () => to, keyWrapper: () => KEYCHAIN });
    expect((await importState({ archive, passphrase: PASSPHRASE })).secrets).toBe('opened');
    const imported = readFileSync(join(to, 'pi-home', 'secret.key'));

    // ---- and now the container: no keychain, one file, mounted ----
    resetHostForTests();
    const keyFile = join(scratch(), 'stem_key');
    // `echo "$PASSPHRASE" > stem_key`, newline and all. Reading this file by the
    // wrong rule is the whole failure mode this test exists for.
    writeFileSync(keyFile, `${PASSPHRASE}\n`, { mode: 0o600 });
    process.env.STEM_KEY_FILE = keyFile;
    process.env.STEM_SECRET_KEY_FILE = join(to, 'pi-home', 'secret.key');
    setHost({ stateRoot: () => to });

    // Encrypting, not degrading: secretKeyAvailable() is false in plaintext mode,
    // and a server that quietly stopped encrypting is the other silent failure.
    expect(secretKeyAvailable()).toBe(true);
    const config = JSON.parse(readFileSync(join(to, 'pi-home', 'mcp.json'), 'utf8')) as {
      servers: Record<string, { headers: Record<string, string> }>;
    };
    expect(decryptSecretValue(config.servers.fastmail.headers.Authorization)).toBe(CREDENTIAL);

    // And the key file it opened is the one that arrived — untouched. Had the
    // unwrap failed, pi/secrets.ts would have minted a fresh key over the top of
    // it, and everything above would still have "worked" while every credential
    // in the archive became unreadable.
    expect(readFileSync(join(to, 'pi-home', 'secret.key')).equals(imported)).toBe(true);
  });
});
