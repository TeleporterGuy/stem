// Pairing, against the real bridge state machine (src/main/startup/mobile.ts)
// and the real settings store. What is under test here is the lifecycle rather
// than the transport: that the bridge is genuinely off until the Settings toggle
// says otherwise, that flipping it starts and stops a listening socket, and that
// re-rolling the token revokes every paired phone at once.
//
// The pairing URL matters as much as the socket. It is what a QR encodes, so it
// has to be the address the phone can actually reach — which nothing on this Mac
// can discover, hence the publicUrl setting and the `reachable` flag.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { readSettings, updateMobileSettings } from '../../src/main/workspace/settings';
import { settingsStorePath } from '../../src/main/workspace/paths';
import { forgetCachedMobileToken } from '../../src/main/mobile/auth';
import {
  closeMobileBridge,
  initMobileBridge,
  isMobileBridgeRunning,
  mobilePairingInfo,
  rerollMobilePairing,
  syncMobileBridge
} from '../../src/main/startup/mobile';

const settingsPath = settingsStorePath();
/** A high port unlikely to clash; the settings store refuses anything under 1024. */
const PORT = 28823;

beforeEach(() => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  rmSync(settingsPath, { force: true });
  rmSync(process.env.STEM_MOBILE_TOKEN_FILE!, { force: true });
  forgetCachedMobileToken();
  initMobileBridge({ rendererDir: dirname(settingsPath), devUrl: null });
});

afterEach(async () => {
  await closeMobileBridge();
  rmSync(settingsPath, { force: true });
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

describe('the bridge is off until asked', () => {
  it('defaults to disabled, and syncing does not open a socket', async () => {
    expect((await readSettings()).mobile).toEqual({ enabled: false, port: 8823, publicUrl: '' });
    await syncMobileBridge();
    expect(isMobileBridgeRunning()).toBe(false);

    const info = await mobilePairingInfo();
    expect(info.enabled).toBe(false);
    expect(info.running).toBe(false);
    // A token exists even while off, so the pairing panel can be opened first.
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the Settings toggle', () => {
  it('starts and stops a listening socket', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncMobileBridge();
    expect(isMobileBridgeRunning()).toBe(true);
    expect(await portOpen(PORT)).toBe(true);
    expect((await mobilePairingInfo()).running).toBe(true);

    await updateMobileSettings({ enabled: false });
    await syncMobileBridge();
    expect(isMobileBridgeRunning()).toBe(false);
    expect(await portOpen(PORT)).toBe(false);
    expect((await mobilePairingInfo()).running).toBe(false);
  });

  it('rebinds when the port changes', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncMobileBridge();
    await updateMobileSettings({ port: PORT + 1 });
    await syncMobileBridge();

    expect(await portOpen(PORT)).toBe(false);
    expect(await portOpen(PORT + 1)).toBe(true);
    expect((await mobilePairingInfo()).port).toBe(PORT + 1);
  });

  it('is idempotent — syncing twice neither restarts nor breaks the server', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncMobileBridge();
    const first = await mobilePairingInfo();
    await syncMobileBridge();
    await syncMobileBridge();
    expect(await mobilePairingInfo()).toEqual(first);
    expect(await portOpen(PORT)).toBe(true);
  });
});

describe('the pairing URL', () => {
  it('falls back to loopback, and says it is not phone-reachable', async () => {
    await updateMobileSettings({ enabled: true, port: PORT });
    await syncMobileBridge();
    const info = await mobilePairingInfo();

    expect(info.reachable).toBe(false);
    expect(info.url).toBe(`http://127.0.0.1:${PORT}/mobile.html#token=${info.token}`);
    expect(info.url).toBe(info.loopbackUrl);
  });

  it('uses the tailnet address once the user supplies one', async () => {
    await updateMobileSettings({ enabled: true, port: PORT, publicUrl: 'https://mac.tailnet-name.ts.net' });
    await syncMobileBridge();
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
    await syncMobileBridge();
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
    await syncMobileBridge();
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
