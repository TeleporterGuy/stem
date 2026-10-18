// Computer control end to end, on the machine running the tests: the switch in
// Settings, then a scripted turn ([e2e:computer]) that lists the windows,
// selects one app's window and reads its controls — server → router →
// desktop host → the platform's helper (the Swift one on a Mac, the C# one on
// Windows, built on demand) → that app. It needs a real desktop session, so it
// runs only when STEM_E2E_COMPUTER_APP names the app to work on: on the
// Windows VM, `scripts/windows-vm.mjs desktop` with STEM_E2E_COMPUTER_APP=notepad
// (the test opens Notepad itself); on a Mac, an app that is open, from a
// terminal with Screen Recording and Accessibility.
import { spawn } from 'node:child_process';
import { closeApp, expect, launchApp, mainWindowOf, openSettings, test } from './electron';

test('a scripted turn selects a real window and reads its controls', async () => {
  const app = process.env.STEM_E2E_COMPUTER_APP;
  test.skip(!app, 'set STEM_E2E_COMPUTER_APP and run on a real desktop');
  test.setTimeout(180_000);
  if (process.platform === 'win32' && app === 'notepad') spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();

  const launched = await launchApp({
    seedSettings: { onboarding: { completed: true }, releaseNotes: { showOnUpdate: false, lastSeenVersion: null } }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Features');
    const toggle = win.getByRole('switch', { name: /Let Stem control this (Mac|computer)$/ });
    await toggle.click();
    // On once the server has the announcement, which waits on the helper's
    // status — and in a dev run on its first build.
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
    await win.keyboard.press('Escape');
    const box = win.getByPlaceholder('Ask Stem…');
    await box.fill(`[e2e:computer] ${app}`);
    await box.press('Enter');
    const reply = win.locator('.message-assistant:not(.activity-row) .message-body').last();
    // The first build of the helper (a dev run) is part of the wait.
    await expect(reply).toContainText('[computer ok]', { timeout: 150_000 });
    await expect(reply).toContainText(/\d+\s+\S+/);
  } finally {
    await closeApp(launched);
  }
});
