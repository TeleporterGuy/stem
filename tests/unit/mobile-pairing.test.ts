// Pairing, against the real transport state machine (src/server/startup/transport.ts)
// and the real settings store. What is under test here is the lifecycle rather
// than the wire: that phones are genuinely off until the Settings toggle says
// otherwise, that flipping it starts and stops a listening socket, and that
// re-rolling the token revokes every paired phone at once.
//
// The toggle now means "may phones connect", not "is there a server" — the
// primary listener the desktop uses is up either way — so several of these also
// assert that the two are independent.
//
// The pairing URL matters as much as the socket. It is what a QR encodes, so it
// has to be the address the phone can actually reach — which nothing on this Mac
// can discover, hence the publicUrl setting and the `reachable` flag.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { readSettings, updateMobileSettings } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';
import { forgetCachedDevices } from '../../src/server/transport/auth';
import {
  closeTransport,
  isPhoneBridgeRunning,
  mobilePairingInfo,
  rerollMobilePairing,
  startTransport,
  syncPhoneAccess,
  type TransportEndpoint
} from '../../src/server/startup/transport';

const settingsPath = settingsStorePath();
/** A high port unlikely to clash; the settings store refuses anything under 1024. */
const PORT = 28823;

/** The primary listener, brought up once — it is bound at boot and never rebound. */
let endpoint: TransportEndpoint;

beforeEach(async () => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  rmSync(settingsPath, { force: true });
  await syncPhoneAccess();
});

afterEach(async () => {
  rmSync(settingsPath, { force: true });
  await syncPhoneAccess();
});

beforeAll(async () => {
  rmSync(process.env.STEM_MOBILE_TOKEN_FILE!, { force: true });
  rmSync(process.env.STEM_DEVICES_FILE!, { force: true });
  forgetCachedDevices();
  endpoint = await startTransport({ rendererDir: dirname(settingsPath), devUrl: null });
});

afterAll(async () => {
  await closeTransport();
});

/** Whether anything is accepting connections on the loopback port. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

describe('phones are off until asked', () => {
  it('defaults to disabled, and syncing does not open a socket', async () => {
    expect((await readSettings()).mobile).toEqual({ enabled: false, port: 8823, publicUrl: '' });
    await syncPhoneAccess();
    expect(isPhoneBridgeRunning()).toBe(false);
    expect(await portOpen(8823)).toBe(false);

    const info = await mobilePairingInfo();
    expect(info.enabled).toBe(false);
    expect(info.running).toBe(false);
    // A token exists even while off, so the pairing panel can be opened first.
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not mean there is no server — the desktop is served either way', async () => {
    // The whole reason the toggle stopped meaning "is there a server": the
    // desktop's own listener is bound once at boot on its own ephemeral port and
    // is never touched by this setting.
    const port = Number(new URL(endpoint.url).port);
    expect(await portOpen(port)).toBe(true);

    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    expect(await portOpen(port)).toBe(true);
    await updateMobileSettings({ enabled: false });
    await syncPhoneAccess();
    expect(await portOpen(port)).toBe(true);
  });

  it('refuses a phone token while the toggle is off, whatever it presents it to', async () => {
    // Belt and braces to the unbound port: the role check is what actually
    // decides, so a phone token reaching the desktop's own listener is refused
    // there too — and refused identically to an unknown one.
    const { token } = await mobilePairingInfo();
    const call = (t: string) =>
      fetch(`${endpoint.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify({ channel: 'settings:get', args: [] })
      });
    expect((await call(token)).status).toBe(401);
    expect((await call('b'.repeat(64))).status).toBe(401);

    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    // Not 401: the gate passed. settings:get has no handler in this process, so
    // dispatch is as far as it gets — which is all this needs to prove.
    expect((await call(token)).status).not.toBe(401);
  });
});

describe('the Settings toggle', () => {
  it('starts and stops a listening socket', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    expect(isPhoneBridgeRunning()).toBe(true);
    expect(await portOpen(PORT)).toBe(true);
    expect((await mobilePairingInfo()).running).toBe(true);

    await updateMobileSettings({ enabled: false });
    await syncPhoneAccess();
    expect(isPhoneBridgeRunning()).toBe(false);
    expect(await portOpen(PORT)).toBe(false);
    expect((await mobilePairingInfo()).running).toBe(false);
  });

  it('rebinds when the port changes', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    await updateMobileSettings({ port: PORT + 1 });
    await syncPhoneAccess();

    expect(await portOpen(PORT)).toBe(false);
    expect(await portOpen(PORT + 1)).toBe(true);
    expect((await mobilePairingInfo()).port).toBe(PORT + 1);
  });

  it('is idempotent — syncing twice neither restarts nor breaks the server', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    const first = await mobilePairingInfo();
    await syncPhoneAccess();
    await syncPhoneAccess();
    expect(await mobilePairingInfo()).toEqual(first);
    expect(await portOpen(PORT)).toBe(true);
  });
});

describe('the pairing URL', () => {
  it('falls back to loopback, and says it is not phone-reachable', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    const info = await mobilePairingInfo();

    expect(info.reachable).toBe(false);
    expect(info.url).toBe(`http://127.0.0.1:${PORT}/mobile.html#token=${info.token}`);
    expect(info.url).toBe(info.loopbackUrl);
  });

  it('uses the tailnet address once the user supplies one', async () => {
    await updateMobileSettings({ enabled: true, port: PORT, publicUrl: 'https://mac.tailnet-name.ts.net' });
    await syncPhoneAccess();
    const info = await mobilePairingInfo();

    expect(info.reachable).toBe(true);
    expect(info.url).toBe(`https://mac.tailnet-name.ts.net/mobile.html#token=${info.token}`);
    // The loopback one stays available for trying the client at the desk.
    expect(info.loopbackUrl).toBe(`http://127.0.0.1:${PORT}/mobile.html#token=${info.token}`);
  });

  it('normalizes whatever the user pastes into a bare origin', async () => {
    // `tailscale serve status` prints a trailing slash, and a hurried paste can
    // drop the scheme — neither should produce a double slash or an http URL.
    for (const [entered, expected] of [
      ['https://mac.tailnet-name.ts.net/', 'https://mac.tailnet-name.ts.net'],
      ['mac.tailnet-name.ts.net', 'https://mac.tailnet-name.ts.net'],
      ['https://mac.tailnet-name.ts.net/mobile.html', 'https://mac.tailnet-name.ts.net'],
      ['   ', '']
    ] as const) {
      const settings = await updateMobileSettings({ publicUrl: entered });
      expect(settings.mobile.publicUrl).toBe(expected);
    }
  });

  it('carries the token in the fragment, never in the path or query', async () => {
    await updateMobileSettings({ enabled: true, port: PORT, publicUrl: 'https://mac.tailnet-name.ts.net' });
    await syncPhoneAccess();
    const info = await mobilePairingInfo();
    const url = new URL(info.url);

    // The whole design rests on this: browsers do not send fragments to servers.
    expect(url.hash).toBe(`#token=${info.token}`);
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/mobile.html');
  });
});

describe('re-rolling the token', () => {
  it('mints a new token and un-pairs the old one immediately', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncPhoneAccess();
    const before = await mobilePairingInfo();

    const after = await rerollMobilePairing();
    expect(after.token).not.toBe(before.token);
    expect(after.token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.url).toContain(after.token);

    // The bridge is back up on the same port, and only the new token works.
    expect(after.running).toBe(true);
    const call = (token: string) =>
      fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel: 'settings:get', args: [] })
      });
    expect((await call(before.token)).status).toBe(401);
    // Not 401: the gate passed. settings:get has no handler in this process, so
    // dispatch is as far as it gets — which is all this needs to prove.
    expect((await call(after.token)).status).not.toBe(401);
  });

  it('leaves the bridge alone when it is off', async () => {
    const before = await mobilePairingInfo();
    const after = await rerollMobilePairing();
    expect(after.token).not.toBe(before.token);
    expect(after.running).toBe(false);
    expect(await portOpen(PORT)).toBe(false);
  });
});
