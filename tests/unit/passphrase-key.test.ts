// The key wrapper a server in a container has instead of a keychain.
//
// It is a compatibility contract before it is anything else: an archive written
// on a Mac today has to be openable by a container built later from the same
// envelope description. So the tests below pin the parts of that contract a
// future change could break silently — the magic that identifies the format, the
// fact that a wrap is never twice the same bytes, and the one rule about trailing
// newlines that decides whether `echo` and `printf` produce the same passphrase.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPassphraseWrapped,
  passphraseKeyWrapper,
  passphraseProblem,
  readPassphraseFile
} from '../../src/server/host/passphrase-key';

const KEY = 'ab'.repeat(32);

describe('wrapping a data key under a passphrase', () => {
  it('round-trips it', () => {
    const wrapper = passphraseKeyWrapper('a passphrase for the container');
    expect(wrapper.unwrap(wrapper.wrap(KEY))).toBe(KEY);
  });

  it('never produces the same bytes twice, so a repeated export leaks nothing', () => {
    const wrapper = passphraseKeyWrapper('a passphrase for the container');
    expect(wrapper.wrap(KEY).equals(wrapper.wrap(KEY))).toBe(false);
  });

  it('says plainly when the passphrase is wrong, rather than returning rubbish', () => {
    const wrapped = passphraseKeyWrapper('a passphrase for the container').wrap(KEY);
    expect(() => passphraseKeyWrapper('some other passphrase').unwrap(wrapped)).toThrow(/Wrong passphrase/);
  });

  it('refuses to be handed something the platform keychain wrapped', () => {
    // The two wrappers write into the same file. Telling them apart is what stops
    // a passphrase attempt on a safeStorage blob reading as a wrong passphrase.
    const safeStorageLookalike = Buffer.from('v10some-electron-ciphertext-goes-here', 'utf8');
    expect(isPassphraseWrapped(safeStorageLookalike)).toBe(false);
    expect(() => passphraseKeyWrapper('a passphrase for the container').unwrap(safeStorageLookalike)).toThrow(
      /not wrapped with a passphrase/
    );
  });

  it('detects a tampered envelope', () => {
    const wrapped = passphraseKeyWrapper('a passphrase for the container').wrap(KEY);
    wrapped[wrapped.length - 1] ^= 0xff;
    expect(() => passphraseKeyWrapper('a passphrase for the container').unwrap(wrapped)).toThrow();
  });

  it('holds the line on passphrase length going in, but never coming out', () => {
    expect(passphraseProblem('')).toMatch(/required/);
    expect(passphraseProblem('short')).toMatch(/at least 12/);
    expect(passphraseProblem('twelve chars')).toBeNull();
    // A rule tightened later must not lock somebody out of an old backup.
    const wrapped = passphraseKeyWrapper('tiny').wrap(KEY);
    expect(passphraseKeyWrapper('tiny').unwrap(wrapped)).toBe(KEY);
  });
});

describe('reading a passphrase out of a key file', () => {
  it('forgives one trailing newline and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stem-keyfile-'));
    try {
      writeFileSync(join(dir, 'echoed'), 'hunter2hunter2\n');
      writeFileSync(join(dir, 'printed'), 'hunter2hunter2');
      writeFileSync(join(dir, 'windows'), 'hunter2hunter2\r\n');
      writeFileSync(join(dir, 'padded'), '  hunter2hunter2  ');
      expect(readPassphraseFile(join(dir, 'echoed'))).toBe('hunter2hunter2');
      expect(readPassphraseFile(join(dir, 'printed'))).toBe('hunter2hunter2');
      expect(readPassphraseFile(join(dir, 'windows'))).toBe('hunter2hunter2');
      // Spaces might be deliberate, so they are taken literally.
      expect(readPassphraseFile(join(dir, 'padded'))).toBe('  hunter2hunter2  ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
