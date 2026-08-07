// The device registry: devices.json, the single role it hands out, and what it
// refuses to honour.
//
// This is the file that decides who the transport answers, so what is under test
// is mostly refusals: a token nobody registered resolves to nothing, a re-roll
// invalidates the previous one, a malformed record is dropped rather than
// trusted — and a `phone` record left over from an earlier release is dropped
// too, which is the one case where dropping is a security decision rather than
// hygiene (see parseDevices).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureDevice,
  forgetCachedDevices,
  readDevices,
  rerollDeviceToken,
  resolveDevice
} from '../../src/server/transport/auth';
import { devicesStorePath } from '../../src/server/workspace/paths';

const devicesPath = devicesStorePath();

/** A registry file written by hand, as an earlier release would have left it. */
function writeRegistry(devices: unknown[]): void {
  mkdirSync(dirname(devicesPath), { recursive: true });
  writeFileSync(devicesPath, JSON.stringify({ version: 1, devices }), 'utf8');
  forgetCachedDevices();
}

beforeEach(async () => {
  // lastSeenAt is stamped behind the request, so drain the registry's queue
  // before wiping the file — otherwise a previous test's write lands on top of
  // the next one's fixture.
  await readDevices().catch(() => undefined);
  mkdirSync(dirname(devicesPath), { recursive: true });
  rmSync(devicesPath, { force: true });
  forgetCachedDevices();
});

afterEach(() => {
  rmSync(devicesPath, { force: true });
});

describe('minting devices', () => {
  it('mints one record per device, each with its own token', async () => {
    const first = await ensureDevice('device', 'This machine');
    expect(first.role).toBe('device');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.lastSeenAt).toBeNull();

    // Idempotent: asking again is a read, never a re-credentialing.
    expect((await ensureDevice('device', 'This machine')).token).toBe(first.token);
    expect((await readDevices()).length).toBe(1);
  });

  it('writes the registry 0600 — it is a file full of bearer tokens', async () => {
    await ensureDevice('device', 'This machine');
    expect(statSync(devicesPath).mode & 0o777).toBe(0o600);
  });

  it('survives a truncated or hand-edited registry rather than locking everyone out', async () => {
    mkdirSync(dirname(devicesPath), { recursive: true });
    writeFileSync(devicesPath, '{"version":1,"devices":[{"id":"x"', 'utf8');
    forgetCachedDevices();
    const device = await ensureDevice('device', 'This machine');
    expect(device.token).toMatch(/^[0-9a-f]{64}$/);

    // A record with a malformed token is dropped, not trusted: a bad token can
    // only ever refuse a device that would otherwise have worked.
    writeRegistry([{ id: 'a', token: 'not-a-token', role: 'device', label: 'p', createdAt: '', lastSeenAt: null }]);
    expect(await resolveDevice('not-a-token')).toBeNull();
  });
});

describe('records written by an earlier release', () => {
  it('carries a desktop record across as the one surviving role', async () => {
    const token = 'a'.repeat(64);
    writeRegistry([{ id: 'd1', token, role: 'desktop', label: 'This machine', createdAt: '', lastSeenAt: null }]);

    // Same credential, same slot: the desktop this registry belongs to keeps
    // working across the upgrade without re-pairing.
    const resolved = await resolveDevice(token);
    expect(resolved?.id).toBe('d1');
    expect(resolved?.role).toBe('device');
  });

  it('drops a phone record instead of promoting it', async () => {
    const phoneToken = 'b'.repeat(64);
    const deskToken = 'c'.repeat(64);
    writeRegistry([
      { id: 'p1', token: phoneToken, role: 'phone', label: 'Paired phone', createdAt: '', lastSeenAt: null },
      { id: 'd1', token: deskToken, role: 'desktop', label: 'This machine', createdAt: '', lastSeenAt: null }
    ]);

    // The whole point: a phone token used to be constrained by an allowlist that
    // no longer exists. Honouring it now would hand it the entire registry, so
    // it stops authenticating at all — the phone it belongs to has no client.
    expect(await resolveDevice(phoneToken)).toBeNull();
    expect((await resolveDevice(deskToken))?.id).toBe('d1');
    expect((await readDevices()).map((d) => d.id)).toEqual(['d1']);
  });
});

describe('resolving a presented token', () => {
  it('answers with the device behind the token, and nothing for anything else', async () => {
    const device = await ensureDevice('device', 'This machine');

    expect((await resolveDevice(device.token))?.role).toBe('device');
    expect(await resolveDevice(null)).toBeNull();
    expect(await resolveDevice('')).toBeNull();
    // A token of a different length must be refused, not throw out of
    // timingSafeEqual (which rejects mismatched lengths).
    expect(await resolveDevice(device.token.slice(0, 10))).toBeNull();
    expect(await resolveDevice('b'.repeat(64))).toBeNull();
  });

  it('stamps lastSeenAt on the way past', async () => {
    const device = await ensureDevice('device', 'This machine');
    expect(device.lastSeenAt).toBeNull();
    await resolveDevice(device.token);
    // The stamp is written behind the request; give the queued write a turn.
    await readDevices();
    expect((await readDevices()).find((d) => d.id === device.id)?.lastSeenAt).toMatch(/^\d{4}-/);
  });
});

describe('re-rolling', () => {
  it('replaces the token in place and invalidates the old one', async () => {
    const before = await ensureDevice('device', 'This machine');
    const rolled = await rerollDeviceToken('device', 'This machine');

    expect(rolled.token).not.toBe(before.token);
    expect(await resolveDevice(before.token)).toBeNull();
    expect((await resolveDevice(rolled.token))?.role).toBe('device');
    // The same device slot, re-credentialed — not a new device.
    expect(rolled.id).toBe(before.id);
    expect(rolled.createdAt).toBe(before.createdAt);
  });
});
