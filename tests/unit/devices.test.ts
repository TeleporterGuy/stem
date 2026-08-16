// The device registry: devices.json, what it stores, and what it refuses.
//
// The load-bearing property here is a negative one — the file contains no
// credential. A token exists on the device that owns it and as a SHA-256 here,
// so every test below that looks at what was written is really asking "can this
// file be turned back into access?".
//
// The rest is refusals: a token nobody registered resolves to nothing, a revoked
// one stops working, a malformed record is dropped rather than trusted — and so
// are the two shapes an earlier release could have left behind, each for its own
// reason (see parseDevices).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  deviceKind,
  forgetCachedDevices,
  hashToken,
  mintDevice,
  readDevices,
  resolveDevice,
  revokeDevice,
  setDevicePushToken
} from '../../src/server/transport/auth';
import { devicesStorePath } from '../../src/server/workspace/paths';

const devicesPath = devicesStorePath();

/** A registry file written by hand, as an earlier release would have left it. */
function writeRegistry(devices: unknown[]): void {
  mkdirSync(dirname(devicesPath), { recursive: true });
  writeFileSync(devicesPath, JSON.stringify({ version: 2, devices }), 'utf8');
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
  it('hands the token back once and keeps only its hash', async () => {
    const { device, token } = await mintDevice('This machine');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(device.role).toBe('device');
    expect(device.lastSeenAt).toBeNull();
    expect(device.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));

    // The point of the whole rewrite: the file cannot be read back into access.
    const onDisk = readFileSync(devicesPath, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk).devices[0].token).toBeUndefined();
  });

  it('mints a distinct record per device rather than one per role', async () => {
    const first = await mintDevice('Desk');
    const second = await mintDevice('Laptop');

    expect(second.device.id).not.toBe(first.device.id);
    expect(second.token).not.toBe(first.token);
    // Both work: there is no single-slot-per-role notion left to collide over.
    expect((await resolveDevice(first.token))?.label).toBe('Desk');
    expect((await resolveDevice(second.token))?.label).toBe('Laptop');
    expect((await readDevices()).length).toBe(2);
  });

  it('writes the registry 0600 — it still says who can reach this machine', async () => {
    await mintDevice('This machine');
    expect(statSync(devicesPath).mode & 0o777).toBe(0o600);
  });

  it('survives a truncated or hand-edited registry rather than locking everyone out', async () => {
    mkdirSync(dirname(devicesPath), { recursive: true });
    writeFileSync(devicesPath, '{"version":2,"devices":[{"id":"x"', 'utf8');
    forgetCachedDevices();
    const { token } = await mintDevice('This machine');
    expect((await resolveDevice(token))?.label).toBe('This machine');

    // A record with a malformed hash is dropped, not trusted: a bad hash can
    // only ever refuse a device that would otherwise have worked.
    await readDevices(); // drain the lastSeenAt write the resolve above queued
    writeRegistry([{ id: 'a', tokenHash: 'not-a-hash', role: 'device', label: 'p', createdAt: '', lastSeenAt: null }]);
    expect(await resolveDevice('not-a-hash')).toBeNull();
    expect((await readDevices()).length).toBe(0);
  });
});

describe('records written by an earlier release', () => {
  it('drops a version 1 plaintext record rather than hashing it into a ghost', async () => {
    const token = 'a'.repeat(64);
    writeRegistry([{ id: 'd1', token, role: 'desktop', label: 'This machine', createdAt: '', lastSeenAt: null }]);

    // Hashing it would keep a record whose device can prove nothing: the client
    // of that era never held a copy of the token, it read this file. The record
    // would linger in Settings → Devices belonging to nobody, so it goes — and
    // the desktop simply mints itself a fresh one off the same shared disk.
    expect(await resolveDevice(token)).toBeNull();
    expect((await readDevices()).length).toBe(0);
  });

  it('drops a phone record instead of promoting it', async () => {
    const phoneHash = hashToken('b'.repeat(64));
    const deskHash = hashToken('c'.repeat(64));
    writeRegistry([
      { id: 'p1', tokenHash: phoneHash, role: 'phone', label: 'Paired phone', createdAt: '', lastSeenAt: null },
      { id: 'd1', tokenHash: deskHash, role: 'desktop', label: 'This machine', createdAt: '', lastSeenAt: null }
    ]);

    // A phone token used to be constrained by an allowlist that no longer
    // exists. Honouring it now would hand it the entire registry, so it stops
    // authenticating at all — the phone it belongs to has no client.
    expect(await resolveDevice('b'.repeat(64))).toBeNull();
    expect((await resolveDevice('c'.repeat(64)))?.id).toBe('d1');
    expect((await readDevices()).map((d) => d.id)).toEqual(['d1']);
  });

  it('carries a desktop record across as the one surviving role', async () => {
    const token = 'd'.repeat(64);
    writeRegistry([
      { id: 'd1', tokenHash: hashToken(token), role: 'desktop', label: 'This machine', createdAt: '', lastSeenAt: null }
    ]);
    expect((await resolveDevice(token))?.role).toBe('device');
  });
});

// What a device says it is when it pairs. It decides what Stem OFFERS it — only
// a desktop is offered as a host for a pinned MCP server — so the load-bearing
// case is the record that predates the question and has to be read as a desktop.
describe('what a device says it is', () => {
  it('records the kind the caller minted with, and defaults to desktop', async () => {
    const desk = await mintDevice('Desk');
    const phone = await mintDevice('Phone', 'mobile');

    expect(deviceKind(desk.device)).toBe('desktop');
    expect(deviceKind(phone.device)).toBe('mobile');
    // A minted record KNOWS, so it says so on disk; absence is reserved for the
    // records written before the field existed.
    const stored = JSON.parse(readFileSync(devicesPath, 'utf8')).devices as { kind?: string }[];
    expect(stored.map((d) => d.kind)).toEqual(['desktop', 'mobile']);
  });

  it('reads a record from before the field as a desktop', async () => {
    writeRegistry([
      { id: 'd1', tokenHash: hashToken('a'.repeat(64)), role: 'device', label: 'Old', createdAt: '', lastSeenAt: null }
    ]);
    const [device] = await readDevices();
    // Absent stays absent — the file must round-trip to the bytes it arrived as —
    // and only the reader applies the default.
    expect(device.kind).toBeUndefined();
    expect(deviceKind(device)).toBe('desktop');
  });

  it('keeps the kind when a push token is dropped', async () => {
    const { device } = await mintDevice('Phone', 'mobile');
    await setDevicePushToken(device.id, 'f'.repeat(64));
    await setDevicePushToken(device.id, null);
    const [stored] = await readDevices();
    // withoutPushToken rebuilds the record field by field, so a forgotten field
    // here would silently promote a phone to a host Stem would offer.
    expect(stored.apnsToken).toBeUndefined();
    expect(deviceKind(stored)).toBe('mobile');
  });
});

describe('resolving a presented token', () => {
  it('answers with the device behind the token, and nothing for anything else', async () => {
    const { device, token } = await mintDevice('This machine');

    expect((await resolveDevice(token))?.id).toBe(device.id);
    expect(await resolveDevice(null)).toBeNull();
    expect(await resolveDevice('')).toBeNull();
    // A token of a different length must be refused, not throw out of
    // timingSafeEqual (which rejects mismatched lengths).
    expect(await resolveDevice(token.slice(0, 10))).toBeNull();
    expect(await resolveDevice('b'.repeat(64))).toBeNull();
    // Presenting the STORED form must not authenticate: the hash is what an
    // attacker who read the file would have, and it has to be worth nothing.
    expect(await resolveDevice(device.tokenHash)).toBeNull();
  });

  it('stamps lastSeenAt on the way past', async () => {
    const { device, token } = await mintDevice('This machine');
    expect(device.lastSeenAt).toBeNull();
    await resolveDevice(token);
    // The stamp is written behind the request; give the queued write a turn.
    await readDevices();
    expect((await readDevices()).find((d) => d.id === device.id)?.lastSeenAt).toMatch(/^\d{4}-/);
  });
});

describe('revoking', () => {
  it('takes the device out of the registry and stops its token working', async () => {
    const keep = await mintDevice('Desk');
    const lose = await mintDevice('Old laptop');

    expect(await revokeDevice(lose.device.id)).toBe(true);
    expect(await resolveDevice(lose.token)).toBeNull();
    // …and only that one.
    expect((await resolveDevice(keep.token))?.id).toBe(keep.device.id);
    expect((await readDevices()).map((d) => d.id)).toEqual([keep.device.id]);
  });

  it('is a no-op for an id that is already gone', async () => {
    await mintDevice('Desk');
    expect(await revokeDevice('nope')).toBe(false);
    expect((await readDevices()).length).toBe(1);
  });
});
