// The device registry: devices.json, the roles it hands out, and the migration
// that keeps an already-paired phone paired.
//
// This is the file that decides who the transport answers, so what is under test
// is mostly refusals and continuity: a token nobody registered resolves to
// nothing, a re-roll invalidates the previous one, and an install that predates
// the registry comes out the other side with the same phone token it had.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureDevice,
  ensurePhoneToken,
  forgetCachedDevices,
  readDevices,
  rerollDeviceToken,
  rerollPhoneToken,
  resolveDevice
} from '../../src/server/transport/auth';
import { devicesStorePath, mobileTokenPath } from '../../src/server/workspace/paths';

const devicesPath = devicesStorePath();
const legacyPath = mobileTokenPath();

beforeEach(async () => {
  // lastSeenAt is stamped behind the request, so drain the registry's queue
  // before wiping the file — otherwise a previous test's write lands on top of
  // the next one's fixture.
  await readDevices().catch(() => undefined);
  mkdirSync(dirname(devicesPath), { recursive: true });
  rmSync(devicesPath, { force: true });
  rmSync(legacyPath, { force: true });
  forgetCachedDevices();
});

afterEach(() => {
  rmSync(devicesPath, { force: true });
  rmSync(legacyPath, { force: true });
});

describe('minting devices', () => {
  it('gives each role its own record and its own token', async () => {
    const desktop = await ensureDevice('desktop', 'This machine');
    const phone = await ensureDevice('phone', 'Paired phone');

    expect(desktop.role).toBe('desktop');
    expect(phone.role).toBe('phone');
    expect(desktop.token).toMatch(/^[0-9a-f]{64}$/);
    expect(phone.token).toMatch(/^[0-9a-f]{64}$/);
    expect(desktop.token).not.toBe(phone.token);
    expect(desktop.id).not.toBe(phone.id);
    expect(desktop.lastSeenAt).toBeNull();

    // Idempotent: asking again is a read, never a re-credentialing.
    expect((await ensureDevice('desktop', 'This machine')).token).toBe(desktop.token);
    expect(await ensurePhoneToken()).toBe(phone.token);
    expect((await readDevices()).length).toBe(2);
  });

  it('writes the registry 0600 — it is a file full of bearer tokens', async () => {
    await ensureDevice('desktop', 'This machine');
    expect(statSync(devicesPath).mode & 0o777).toBe(0o600);
  });

  it('survives a truncated or hand-edited registry rather than locking everyone out', async () => {
    writeFileSync(devicesPath, '{"version":1,"devices":[{"id":"x"', 'utf8');
    forgetCachedDevices();
    const desktop = await ensureDevice('desktop', 'This machine');
    expect(desktop.token).toMatch(/^[0-9a-f]{64}$/);

    // A record with a malformed token is dropped, not trusted: a bad token can
    // only ever refuse a device that would otherwise have worked.
    writeFileSync(
      devicesPath,
      JSON.stringify({
        version: 1,
        devices: [{ id: 'a', token: 'not-a-token', role: 'phone', label: 'p', createdAt: '', lastSeenAt: null }]
      }),
      'utf8'
    );
    forgetCachedDevices();
    expect(await resolveDevice('not-a-token')).toBeNull();
  });
});

describe('resolving a presented token', () => {
  it('answers with the role behind the token, and nothing for anything else', async () => {
    const desktop = await ensureDevice('desktop', 'This machine');
    const phone = await ensureDevice('phone', 'Paired phone');

    expect((await resolveDevice(desktop.token))?.role).toBe('desktop');
    expect((await resolveDevice(phone.token))?.role).toBe('phone');
    expect(await resolveDevice(null)).toBeNull();
    expect(await resolveDevice('')).toBeNull();
    // A token of a different length must be refused, not throw out of
    // timingSafeEqual (which rejects mismatched lengths).
    expect(await resolveDevice(desktop.token.slice(0, 10))).toBeNull();
    expect(await resolveDevice('b'.repeat(64))).toBeNull();
  });

  it('stamps lastSeenAt on the way past', async () => {
    const phone = await ensureDevice('phone', 'Paired phone');
    expect(phone.lastSeenAt).toBeNull();
    await resolveDevice(phone.token);
    // The stamp is written behind the request; give the queued write a turn.
    await readDevices();
    expect((await readDevices()).find((d) => d.id === phone.id)?.lastSeenAt).toMatch(/^\d{4}-/);
  });
});

describe('re-rolling', () => {
  it('replaces the token in place and invalidates the old one', async () => {
    const before = await ensureDevice('phone', 'Paired phone');
    const rolled = await rerollPhoneToken();

    expect(rolled).not.toBe(before.token);
    expect(await resolveDevice(before.token)).toBeNull();
    expect((await resolveDevice(rolled))?.role).toBe('phone');
    // The same device slot, re-credentialed — not a new device.
    const record = (await readDevices()).find((d) => d.role === 'phone')!;
    expect(record.id).toBe(before.id);
    expect(record.createdAt).toBe(before.createdAt);
  });

  it('leaves the other roles alone', async () => {
    const desktop = await ensureDevice('desktop', 'This machine');
    await ensureDevice('phone', 'Paired phone');
    await rerollDeviceToken('phone', 'Paired phone');
    expect((await resolveDevice(desktop.token))?.role).toBe('desktop');
  });
});

describe('migrating an install that predates the registry', () => {
  it('adopts an existing mobile.token as the phone record, so no phone re-pairs', async () => {
    const paired = 'c'.repeat(64);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, `${paired}\n`, 'utf8');
    forgetCachedDevices();

    // The token already on the user's phone still authenticates, unchanged.
    expect((await resolveDevice(paired))?.role).toBe('phone');
    expect(await ensurePhoneToken()).toBe(paired);
    expect(readFileSync(devicesPath, 'utf8')).toContain(paired);

    // And the desktop's own record is minted alongside it, not instead of it.
    const desktop = await ensureDevice('desktop', 'This machine');
    expect(desktop.token).not.toBe(paired);
    expect((await readDevices()).map((d) => d.role).sort()).toEqual(['desktop', 'phone']);
  });

  it('ignores a legacy file that does not hold a well-formed token', async () => {
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, 'half-a-tok', 'utf8');
    forgetCachedDevices();
    expect(await ensurePhoneToken()).not.toBe('half-a-tok');
  });

  it('does not migrate again once the registry exists', async () => {
    const minted = await ensurePhoneToken();
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, `${'d'.repeat(64)}\n`, 'utf8');
    forgetCachedDevices();
    expect(await ensurePhoneToken()).toBe(minted);
  });
});
