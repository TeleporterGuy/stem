// Browser control end to end, on the machine running the tests. Set up
// registers the native host in a throwaway HOME, a real Chromium loads the Stem
// extension from the folder Set up made, and a scripted turn ([e2e:browser])
// opens a fixture page and reads it back: server → router → desktop host →
// native host (the Stem binary as Node) → extension → page. This is the test
// that proves the platform glue (manifest folders or the registry, the
// parent-process lookup, the wrapper, the socket or pipe) on Linux and Windows
// as well as on a Mac. On Windows it writes the real HKCU key for Chromium and
// removes it again.
//
// Needs Playwright's Chromium (`npx playwright install chromium`), or the
// browser STEM_E2E_BROWSER names — the Linux container (scripts/linux-test.mjs)
// points it at Debian's own chromium, the package a user would have. Skipped
// when neither is there.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { closeApp, expect, launchApp, mainWindowOf, openSettings, test } from './electron';

const REGISTRY_KEY = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.stem.browser';

test('a real browser drives a page through the Stem extension', async () => {
  test.setTimeout(150_000);
  const executable = process.env.STEM_E2E_BROWSER || chromium.executablePath();
  test.skip(!existsSync(executable), `no browser at ${executable} (npx playwright install chromium)`);

  const home = mkdtempSync(join(tmpdir(), 'stem-home-'));
  // A folder Set up recognizes as a used Chromium, so it registers the host there.
  const profile =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Chromium')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'Chromium', 'User Data')
        : join(home, '.config', 'chromium');
  mkdirSync(profile, { recursive: true });

  const fixture: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Stem probe</title><h1>hello-from-fixture</h1><button>Press me</button>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;

  const launched = await launchApp({
    // Windows: LOCALAPPDATA is where Set up looks for browsers. USERPROFILE stays
    // real; an Electron started with another one never opens a window.
    env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LOCALAPPDATA: join(home, 'AppData', 'Local') },
    seedSettings: {
      onboarding: { completed: true },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
    }
  });
  let browser: ChildProcess | null = null;
  let browserLog = '';
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Features');
    await win.getByRole('switch', { name: /Let Stem control this (Mac|computer)’s browser/ }).click();
    await win.getByRole('button', { name: 'Set up…' }).click();
    await expect(win.getByText('Waiting for Load unpacked')).toBeVisible();

    const manifestFile =
      process.platform === 'win32'
        ? /REG_SZ\s+(.*)$/m.exec(execFileSync('reg', ['query', REGISTRY_KEY, '/ve'], { encoding: 'utf8' }))![1]!.trim()
        : join(profile, 'NativeMessagingHosts', 'com.stem.browser.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(manifest.name).toBe('com.stem.browser');
    const extensionPath = (await win.locator('.ext-path').first().textContent())!.trim();

    browser = spawn(
      executable,
      [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        `--load-extension=${extensionPath}`,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        // Without it Chrome on macOS reads the login keychain for its own
        // encryption key and hangs once a tab opens (a locked or CI keychain).
        // Playwright adds it to the browsers it launches; this one we spawn.
        ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
        'about:blank'
      ],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    browser.stderr?.on('data', (d: Buffer) => {
      browserLog = (browserLog + d.toString()).slice(-4000);
    });

    // The extension starts the native host, which says hello over Stem's socket.
    await expect(win.locator('.ext-status.ok'), browserLog).toContainText('connected', { timeout: 45_000 });

    await win.keyboard.press('Escape');
    const box = win.getByPlaceholder('Ask Stem…');
    await box.fill(`[e2e:browser] ${url}`);
    await box.press('Enter');
    const reply = win.locator('.message-assistant:not(.activity-row) .message-body').last();
    await expect(reply).toContainText('[browser ok]', { timeout: 60_000 });
    await expect(reply).toContainText('hello-from-fixture');
  } finally {
    browser?.kill();
    await closeApp(launched);
    if (process.platform === 'win32') {
      try {
        execFileSync('reg', ['delete', REGISTRY_KEY, '/f'], { stdio: 'ignore' });
      } catch {
        // quiet: Set up never got as far as the registry.
      }
    }
    fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});
