// Dictation off the Mac, end to end: Chromium's fake microphone plays a WAV of
// synthesized speech, the preload captures it, and Whisper in the dictation
// worker must put the words into the composer. Downloads the Fast model (240 MB)
// on a first run, so it only runs when STEM_E2E_DICTATION is set. A Mac's
// dictation is Apple's speech model in the helper, which this does not cover.
import { fileURLToPath } from 'node:url';
import { closeApp, expect, launchApp, mainWindowOf, test } from './electron';

const WAV = fileURLToPath(new URL('../fixtures/dictation-en.wav', import.meta.url));

test('spoken words land in the composer', async () => {
  test.skip(!process.env.STEM_E2E_DICTATION || process.platform === 'darwin', 'set STEM_E2E_DICTATION (Windows or Linux)');
  test.setTimeout(600_000);
  const launched = await launchApp({
    seedSettings: { onboarding: { completed: true }, releaseNotes: { showOnUpdate: false, lastSeenVersion: null } },
    extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`]
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    const box = win.getByPlaceholder('Ask Stem…');
    await box.click();
    await win.getByRole('button', { name: 'Dictate' }).first().click();
    // The first run downloads the model; the live text comes once it is loaded.
    await expect(box).toHaveValue(/quarterly report/i, { timeout: 540_000 });
    await win.getByRole('button', { name: 'Stop dictating' }).first().click();
    await expect(win.getByRole('button', { name: 'Dictate' }).first()).toBeVisible({ timeout: 60_000 });
    await expect(box).toHaveValue(/schedule a meeting/i);
  } finally {
    await closeApp(launched);
  }
});
