import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KeyWrapper } from './index';

// A {@link KeyWrapper} whose keyring is a passphrase.
//
// The other two wrappers Stem has are the platform's: Electron's safeStorage,
// which is the macOS Keychain, and — where there is no keyring at all — nothing,
// with the documented 0600-plaintext degradation. A server in a container has no
// keychain and no session to unlock one, but it does have a secret file mounted
// into it, and that is what this reads.
//
// It exists now, one step before the deployment that needs it, because the export
// cannot be written without it. `stem:exportState` re-wraps the data key that
// encrypts every MCP credential so the destination can open it, and "the
// destination" is a container whose `keyWrapper()` (Phase 2 step 8) will be
// exactly this function over the contents of /run/secrets/stem_key. The format
// below is therefore a compatibility contract between an archive written today
// and a server that unpacks it later, which is why it is spelled out rather than
// left to whatever crypto seemed convenient on each side.
//
// THE ENVELOPE, version 1:
//
//   "STEMKEY1"   8 bytes, ASCII. Magic and version in one — a version 2 would be
//                "STEMKEY2" and would be told apart before anything is derived.
//   salt        16 bytes, random per wrap.
//   iv          12 bytes, random per wrap.
//   tag         16 bytes, the AES-GCM authentication tag.
//   ciphertext  the rest: AES-256-GCM over the UTF-8 plaintext.
//
// The key is scrypt(passphrase, salt, N=16384, r=8, p=1) → 32 bytes. Those
// parameters are fixed by the version rather than stored, so there is no field an
// attacker can weaken; N=16384 costs ~16MB and a few tens of milliseconds, which
// is the right shape for something unwrapped once at boot and never in a loop.
//
// What this protects: a state archive in transit, and a state root on a disk
// somebody else can read. What it does not: a running server, which necessarily
// holds the unwrapped key in memory — same as the Keychain case, and the reason
// the container keeps its secret in memory only.

const MAGIC = 'STEMKEY1';
const MAGIC_LEN = 8;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * The shortest passphrase that may be used to wrap. scrypt at these parameters
 * buys roughly a factor of ten thousand over a bare hash, which is worth having
 * and nowhere near enough to save a six-character passphrase from a machine that
 * wants it. Twelve is the point where the KDF starts doing the work rather than
 * standing in for it.
 *
 * Enforced on the way IN only. A wrapped file already on disk is unwrapped with
 * whatever opens it — a rule tightened later must never lock somebody out of
 * their own backup.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Why this passphrase can't be used to wrap, or null when it can. */
export function passphraseProblem(passphrase: string): string | null {
  if (!passphrase) return 'A passphrase is required.';
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  return null;
}

/**
 * Where a container finds its passphrase. A Compose secret is mounted here as a
 * file, and the file's PATH is what appears in docker-compose.yml — the value
 * never does. Nothing reads this constant yet; the deployment step (Phase 2 step
 * 8) wires `keyWrapper()` to it, and `stem-server import` already defaults to it
 * so a restore run inside the container needs no arguments at all.
 */
export const DEFAULT_KEY_FILE = '/run/secrets/stem_key';

/**
 * The passphrase held in a key file, by the one rule both ends must agree on: the
 * file's bytes, minus a single trailing newline.
 *
 * That last clause is not fussiness. `printf 'hunter2' > key` and
 * `echo hunter2 > key` produce different files, people use both, and a passphrase
 * that silently includes an invisible newline is a passphrase that works on the
 * machine where it was made and nowhere else. One trailing newline is forgiven;
 * anything else — leading spaces, an internal newline — is taken literally,
 * because it might be deliberate.
 */
export function readPassphraseFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

/** True if `wrapped` looks like this envelope at all (vs. a safeStorage blob). */
export function isPassphraseWrapped(wrapped: Buffer): boolean {
  return wrapped.length > MAGIC_LEN + SALT_LEN + IV_LEN + TAG_LEN && wrapped.subarray(0, MAGIC_LEN).toString('ascii') === MAGIC;
}

/**
 * Wrap/unwrap under `passphrase`. Both directions are synchronous because the
 * KeyWrapper interface is — it is called from module-level lazy initialisation in
 * pi/secrets.ts, once, and an async variant would ripple through every caller for
 * no gain at one derivation per process.
 */
export function passphraseKeyWrapper(passphrase: string): KeyWrapper {
  return {
    wrap(plain: string): Buffer {
      const salt = randomBytes(SALT_LEN);
      const iv = randomBytes(IV_LEN);
      const key = scryptSync(passphrase, salt, 32, SCRYPT);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from(MAGIC, 'ascii'), salt, iv, cipher.getAuthTag(), ct]);
    },
    unwrap(wrapped: Buffer): string {
      if (!isPassphraseWrapped(wrapped)) {
        throw new Error('This key file was not wrapped with a passphrase.');
      }
      let at = MAGIC_LEN;
      const salt = wrapped.subarray(at, (at += SALT_LEN));
      const iv = wrapped.subarray(at, (at += IV_LEN));
      const tag = wrapped.subarray(at, (at += TAG_LEN));
      const key = scryptSync(passphrase, salt, 32, SCRYPT);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(wrapped.subarray(at)), decipher.final()]).toString('utf8');
      } catch {
        // GCM authentication failed. With a fixed format and a fixed KDF there is
        // exactly one ordinary cause, and saying so is more use than "unable to
        // authenticate data".
        throw new Error('Wrong passphrase for this key file.');
      }
    }
  };
}
