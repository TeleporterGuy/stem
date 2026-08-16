// Settings → Server, clicked for real: pointing this app at a different Stem.
//
// The whole act is a pairing — an address and a credential written together —
// and the only honest thing the UI can say afterwards is "restart". Everything
// the running app has open (the event stream, the list of calls it is allowed to
// make, every panel already filled in) was built against the connection made at
// startup, so this pane deliberately changes what the NEXT launch does and says
// so on screen.
//
// The server paired with here is the app's own embedded one, reached at its own
// address. That is an odd thing for a user to do and exactly the right thing for
// a test: it exercises the real POST /pair round trip, the real code, and the
// real write, with no second process to arrange.
import { readFileSync } from 'node:fs';
import { test, expect, type LaunchedApp } from './electron';
import { closeApp, launchApp, mainWindowOf, openSettings } from './electron';
import type { ClientInfo } from '../../src/shared/types';

function storedClient(app: LaunchedApp): { deviceId?: string; serverUrl?: string } {
  return JSON.parse(readFileSync(app.clientStorePath, 'utf8')) as { deviceId?: string; serverUrl?: string };
}

test('pairs with another server and says the move needs a restart', async () => {
  const launched = await launchApp({
    seedSettings: {
      onboarding: { completed: true },
      // A "What's new" modal would sit over the Settings button.
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
    }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Server');

    // A fresh install is its own server, and the pane leads with that.
    await expect(win.locator('.set-row', { hasText: 'This computer' }).first()).toBeVisible();
    expect(storedClient(launched).serverUrl).toBeUndefined();

    // Where this app is connected, and a code minted the way a second machine
    // would be handed one.
    const info = (await win.evaluate(() => window.stem.clientInfo())) as ClientInfo;
    const { code } = await win.evaluate(() => window.stem.createPairingCode('Settings pane'));
    const wasDeviceId = storedClient(launched).deviceId;

    // A code that was never minted is refused, and the refusal is shown rather
    // than swallowed — otherwise a mistyped code looks like nothing happened.
    await win.getByLabel('Server address').fill(info.serverUrl);
    await win.getByLabel('Pairing code').fill('ZZZZ-ZZZZ');
    await win.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(win.getByText(/pairing code/i).first()).toBeVisible();
    expect(storedClient(launched).serverUrl).toBeUndefined();

    await win.getByLabel('Pairing code').fill(code);
    await win.getByRole('button', { name: 'Connect', exact: true }).click();

    // The address is recorded for next launch, with a credential that belongs to
    // it — a new one, because the code was spent on a new device record.
    await expect(win.getByText('Restart Stem to connect to it.')).toBeVisible();
    await expect.poll(() => storedClient(launched).serverUrl).toBe(info.serverUrl);
    expect(storedClient(launched).deviceId).not.toBe(wasDeviceId);

    // And there is a way back, which there has to be: a machine that paired with
    // the wrong address must not need client.json deleted by hand.
    await win.getByRole('button', { name: 'Use this computer' }).click();
    await expect.poll(() => storedClient(launched).serverUrl).toBeUndefined();
    await expect(win.getByRole('button', { name: 'Use this computer' })).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});

test('an address pinned by the environment is shown, not offered for editing', async () => {
  // STEM_SERVER_URL outranks anything stored, so a form that wrote a setting
  // nobody would read is worse than no form at all.
  const launched = await launchApp({
    externalServer: true,
    seedSettings: { onboarding: { completed: true }, releaseNotes: { showOnUpdate: false, lastSeenVersion: null } }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Server');

    await expect(win.locator('.set-row', { hasText: launched.server!.url })).toBeVisible();
    await expect(win.getByText(/fixed for this launch by/i)).toBeVisible();
    await expect(win.getByLabel('Server address')).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});
