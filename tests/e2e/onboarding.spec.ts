// Onboarding wizard — driven hermetically via the STEM_E2E_ONBOARDING seam:
// the faked backend starts unauthenticated, and the fake auth:providerLogin /
// auth:setApiKey handlers emit a scripted auth-url → done sequence and flip the
// status to authenticated (see src/main/index.ts). Exercises the wizard's full
// state machine without a browser, network, or real pi.
import { rmSync } from 'node:fs';
import { expect, launchApp, mainWindowOf } from './electron';
import { test as base } from '@playwright/test';

const test = base.extend<{ onboardingApp: Awaited<ReturnType<typeof launchApp>> }>({
  onboardingApp: async ({}, use) => {
    const launched = await launchApp({ env: { STEM_E2E: '1', STEM_E2E_ONBOARDING: '1' } });
    await use(launched);
    await launched.app.close().catch(() => {});
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('first run: welcome → ChatGPT OAuth → main app', async ({ onboardingApp }) => {
  const win = await mainWindowOf(onboardingApp.app);
  await win.waitForLoadState('domcontentloaded');

  // Welcome step (first run: onboarding.completed is false in the fresh store).
  await expect(win.getByText('Welcome to Stem')).toBeVisible();
  await win.getByRole('button', { name: 'Get started' }).click();

  // Provider choice → fake OAuth (scripted auth-url + done events).
  await expect(win.getByRole('button', { name: 'Continue with Claude' })).toBeVisible();
  await win.getByRole('button', { name: 'Continue with ChatGPT' }).click();

  // The fake completes immediately; the wizard finishes and the app mounts.
  await expect(win.getByPlaceholder(/message/i).or(win.locator('.conversation'))).toBeVisible({ timeout: 15_000 });
});

test('first run: API key path reaches the main app', async ({ onboardingApp }) => {
  const win = await mainWindowOf(onboardingApp.app);
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'Get started' }).click();
  await win.getByRole('button', { name: 'Use an API key instead' }).click();

  await expect(win.getByText('Use an API key')).toBeVisible();
  await win.locator('.gate-form input').fill('sk-test-abc');
  await win.getByRole('button', { name: 'Save key' }).click();

  await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
});

test('plain STEM_E2E (authenticated) skips the wizard entirely', async () => {
  const launched = await launchApp(); // default seam: status ok immediately
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
    await expect(win.getByText('Welcome to Stem')).toHaveCount(0);
  } finally {
    await launched.app.close().catch(() => {});
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
