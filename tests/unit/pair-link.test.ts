import { describe, expect, it } from 'vitest';
import { pairingLink, reachableFromAnotherDevice } from '../../src/shared/pair-link';

// What the "Pair a phone" dialog shows, decided before any of it is drawn.
//
// The interesting case is the one a default install is in: Stem started its own
// server on loopback, the pairing code is real, and there is still no QR worth
// showing. The dialog handles that by explaining rather than hiding the button,
// which only works if this returns a null link instead of a confident-looking
// `stem://pair?url=http%3A%2F%2F127.0.0.1%3A52413`.

describe('reachableFromAnotherDevice', () => {
  it('accepts addresses a phone can dial', () => {
    expect(reachableFromAnotherDevice('https://stem.example.com')).toBe(true);
    expect(reachableFromAnotherDevice('http://192.168.1.20:7070')).toBe(true);
    expect(reachableFromAnotherDevice('https://macbook.tail1234.ts.net')).toBe(true);
    // Bonjour names resolve on a phone on the same network; they stay in.
    expect(reachableFromAnotherDevice('http://macbook.local:7070')).toBe(true);
  });

  it('rejects every spelling of "this machine"', () => {
    expect(reachableFromAnotherDevice('http://127.0.0.1:52413')).toBe(false);
    expect(reachableFromAnotherDevice('http://127.1.2.3:80')).toBe(false);
    expect(reachableFromAnotherDevice('http://localhost:7070')).toBe(false);
    expect(reachableFromAnotherDevice('http://LocalHost:7070')).toBe(false);
    expect(reachableFromAnotherDevice('http://[::1]:7070')).toBe(false);
    expect(reachableFromAnotherDevice('http://0.0.0.0:7070')).toBe(false);
  });

  it('rejects what is not an address', () => {
    expect(reachableFromAnotherDevice('')).toBe(false);
    expect(reachableFromAnotherDevice('stem.example.com')).toBe(false);
    expect(reachableFromAnotherDevice('ftp://stem.example.com')).toBe(false);
  });

  it('reads the host past credentials and a port', () => {
    expect(reachableFromAnotherDevice('http://user:pass@127.0.0.1:7070')).toBe(false);
    expect(reachableFromAnotherDevice('https://user@stem.example.com/x')).toBe(true);
  });
});

describe('pairingLink', () => {
  it('builds the payload the phone parses', () => {
    expect(pairingLink('https://stem.example.com', 'ABCD-EFGH')).toEqual({
      serverUrl: 'https://stem.example.com',
      link: 'stem://pair?url=https%3A%2F%2Fstem.example.com&code=ABCD-EFGH'
    });
  });

  it('drops a trailing slash so both sides store the same address', () => {
    expect(pairingLink('https://stem.example.com//', '2345-6789').serverUrl).toBe(
      'https://stem.example.com'
    );
  });

  it('escapes an address with a port and a path', () => {
    const { link } = pairingLink('http://192.168.1.20:7070/stem', 'ABCD-EFGH');
    expect(link).toBe('stem://pair?url=http%3A%2F%2F192.168.1.20%3A7070%2Fstem&code=ABCD-EFGH');
  });

  it('has no link to offer for a server only this computer can reach', () => {
    expect(pairingLink('http://127.0.0.1:52413', 'ABCD-EFGH')).toEqual({
      serverUrl: null,
      link: null
    });
    expect(pairingLink(null, 'ABCD-EFGH')).toEqual({ serverUrl: null, link: null });
    expect(pairingLink('   ', 'ABCD-EFGH')).toEqual({ serverUrl: null, link: null });
  });
});
