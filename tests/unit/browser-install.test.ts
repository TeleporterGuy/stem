// Set up for browser control (desktop/browser-host/install.ts): the extension
// copied out for Load unpacked, the wrapper the manifests point at, the
// manifests in each installed browser — Arc's twice — and a startup refresh
// that only touches an install this profile made.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserDirs,
  browserInstallPaths,
  extensionsPageUrl,
  installBrowserControl,
  installedHere,
  refreshBrowserControl,
  setupBrowsers,
  socketPathFor,
  wrapperScript
} from '../../src/desktop/browser-host/install';
import { FrameReader, encodeFrame, launchableOnLinux } from '../../src/shared/browser-native';
import { browserOf } from '../../src/desktop/browser-host/native-host-main';

let home: string;
let state: string;
let ext: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stem-home-'));
  state = mkdtempSync(join(tmpdir(), 'stem-state-'));
  ext = mkdtempSync(join(tmpdir(), 'stem-ext-'));
  writeFileSync(join(ext, 'manifest.json'), '{"manifest_version":3}');
  writeFileSync(join(ext, 'background.js'), '// v1');
});

afterEach(() => {
  for (const d of [home, state, ext]) rmSync(d, { recursive: true, force: true });
});

const support = (...p: string[]) => join(home, 'Library', 'Application Support', ...p);
const src = () => ({ extensionSource: ext, hostScript: '/App/dist/main/browser-native-host.js', nodeCommand: '/App/Stem' });

describe('installBrowserControl', () => {
  it('registers every installed browser, and Arc in Chrome’s folder too', async () => {
    mkdirSync(support('Arc', 'User Data'), { recursive: true });
    mkdirSync(support('BraveSoftware', 'Brave-Browser'), { recursive: true });
    expect(browserDirs(home, 'darwin').map((d) => d.name).sort()).toEqual(['Arc', 'Brave', 'Google Chrome']);

    const paths = browserInstallPaths(state);
    const res = await installBrowserControl(src(), paths, home, 'darwin');
    expect(res.registered.sort()).toEqual(['Arc', 'Brave', 'Google Chrome']);
    const manifest = JSON.parse(
      readFileSync(support('Google', 'Chrome', 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8')
    );
    expect(manifest).toMatchObject({ name: 'com.stem.browser', type: 'stdio', path: paths.wrapperPath });
    expect(manifest.allowed_origins).toEqual([expect.stringMatching(/^chrome-extension:\/\/[a-p]{32}\/$/)]);
    expect(existsSync(join(paths.extensionDir, 'background.js'))).toBe(true);
    expect(statSync(paths.wrapperPath).mode & 0o777).toBe(0o700);
    expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
    expect(installedHere(paths, home, 'darwin')).toBe(true);
  });

  it('copies the extension again only when its files changed', async () => {
    mkdirSync(support('Google', 'Chrome'), { recursive: true });
    const paths = browserInstallPaths(state);
    expect((await installBrowserControl(src(), paths, home, 'darwin')).extensionChanged).toBe(true);
    expect((await refreshBrowserControl(src(), paths, home, 'darwin'))?.extensionChanged).toBe(false);
    writeFileSync(join(ext, 'background.js'), '// v2');
    expect((await refreshBrowserControl(src(), paths, home, 'darwin'))?.extensionChanged).toBe(true);
    expect(readFileSync(join(paths.extensionDir, 'background.js'), 'utf8')).toBe('// v2');
  });

  it('never refreshes an install another profile owns', async () => {
    mkdirSync(support('Google', 'Chrome'), { recursive: true });
    const other = mkdtempSync(join(tmpdir(), 'stem-other-'));
    await installBrowserControl(src(), browserInstallPaths(other), home, 'darwin');
    const mine = browserInstallPaths(state);
    expect(installedHere(mine, home, 'darwin')).toBe(false);
    expect(await refreshBrowserControl(src(), mine, home, 'darwin')).toBeNull();
    expect(existsSync(mine.wrapperPath)).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });
});

describe('Linux', () => {
  const config = (...p: string[]) => join(home, '.config', ...p);

  it('registers the browsers under ~/.config', async () => {
    mkdirSync(config('google-chrome'), { recursive: true });
    mkdirSync(config('BraveSoftware', 'Brave-Browser'), { recursive: true });
    const paths = browserInstallPaths(state);
    const res = await installBrowserControl(src(), paths, home, 'linux');
    expect(res.registered.sort()).toEqual(['Brave', 'Google Chrome']);
    const manifest = JSON.parse(readFileSync(config('google-chrome', 'NativeMessagingHosts', 'com.stem.browser.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'com.stem.browser', path: paths.wrapperPath });
    expect(existsSync(config('BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', 'com.stem.browser.json'))).toBe(true);
    expect(installedHere(paths, home, 'linux')).toBe(true);
    // A Mac layout in the same home is not this platform's.
    expect(installedHere(paths, home, 'darwin')).toBe(false);
  });

  it('offers browsers with a command on PATH, the default first, by the command that exists', () => {
    mkdirSync(config('google-chrome'), { recursive: true });
    mkdirSync(config('chromium'), { recursive: true });
    mkdirSync(config('microsoft-edge'), { recursive: true });
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'google-chrome-stable'), '');
    writeFileSync(join(bin, 'chromium-browser'), '');
    // Edge was used but is gone.
    expect(setupBrowsers(home, 'linux', [bin], null)).toEqual([
      { name: 'Google Chrome', app: 'google-chrome-stable', extensionsUrl: 'chrome://extensions' },
      { name: 'Chromium', app: 'chromium-browser', extensionsUrl: 'chrome://extensions' }
    ]);
    expect(setupBrowsers(home, 'linux', [bin], 'chromium-browser.desktop').map((b) => b.name)).toEqual([
      'Chromium',
      'Google Chrome'
    ]);
    expect(extensionsPageUrl('/opt/microsoft/msedge/msedge')).toBe('edge://extensions');
    expect(extensionsPageUrl('microsoft-edge')).toBe('edge://extensions');
  });

  it('names the browser from its executable', () => {
    expect(browserOf('/opt/google/chrome/chrome')).toEqual({ appPath: '/opt/google/chrome/chrome', appName: 'Google Chrome' });
    expect(browserOf('/opt/brave.com/brave/brave').appName).toBe('Brave');
    expect(browserOf('/usr/lib/chromium/chromium').appName).toBe('Chromium');
    expect(browserOf('/opt/microsoft/msedge/msedge').appName).toBe('Microsoft Edge');
    expect(browserOf('/usr/bin/vivaldi-bin').appName).toBe('vivaldi-bin');
  });

  it('starts only known browsers from system folders', () => {
    for (const ok of ['/opt/google/chrome/chrome', '/opt/brave.com/brave/brave', '/usr/lib64/chromium-browser/chromium-browser', 'google-chrome-stable']) {
      expect(launchableOnLinux(ok)).toBe(true);
    }
    for (const bad of ['/home/u/bin/chrome', '/tmp/brave-evil.sh', '/opt/google/chrome/../../../tmp/x', '/usr/bin/vivaldi-bin', 'sh', '']) {
      expect(launchableOnLinux(bad)).toBe(false);
    }
  });
});

describe('pieces', () => {
  it('quotes paths with spaces and quotes in the wrapper', () => {
    const script = wrapperScript('/Applications/Stem.app/Contents/MacOS/Stem', "/x/it's here.js", '/a b/config.json');
    expect(script).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '/Applications/Stem.app/Contents/MacOS/Stem' '/x/it'\\''s here.js' '/a b/config.json' "$@"`
    );
  });

  it('offers Set up’s steps only for browsers used here and still installed', () => {
    mkdirSync(support('Arc', 'User Data'), { recursive: true });
    mkdirSync(support('BraveSoftware', 'Brave-Browser'), { recursive: true });
    mkdirSync(support('Microsoft Edge'), { recursive: true });
    const apps = join(home, 'Apps');
    mkdirSync(join(apps, 'Arc.app'), { recursive: true });
    mkdirSync(join(apps, 'Brave Browser.app'), { recursive: true });
    // Chrome's folder gets Arc's manifest but Chrome was never used; Edge was
    // used but is gone.
    expect(setupBrowsers(home, 'darwin', [apps], null)).toEqual([
      { name: 'Arc', app: 'Arc', extensionsUrl: 'arc://extensions' },
      { name: 'Brave', app: 'Brave Browser', extensionsUrl: 'chrome://extensions' }
    ]);
    // The default browser leads; LaunchServices stores its id lowercased.
    expect(setupBrowsers(home, 'darwin', [apps], 'com.brave.browser').map((b) => b.name)).toEqual(['Brave', 'Arc']);
    expect(extensionsPageUrl('/Applications/Arc.app')).toBe('arc://extensions');
    expect(extensionsPageUrl('/Applications/Google Chrome.app')).toBe('chrome://extensions');
    expect(extensionsPageUrl('Microsoft Edge')).toBe('edge://extensions');
  });

  it('keeps socket paths under the unix limit', () => {
    expect(socketPathFor('/short')).toBe('/short/host.sock');
    const long = socketPathFor(`/${'x'.repeat(120)}`);
    expect(Buffer.byteLength(long)).toBeLessThan(104);
  });

  it('reads the browser app off the parent command', () => {
    expect(browserOf('/Applications/Arc.app/Contents/MacOS/Arc')).toEqual({ appPath: '/Applications/Arc.app', appName: 'Arc' });
    expect(browserOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toEqual({
      appPath: '/Applications/Google Chrome.app',
      appName: 'Google Chrome'
    });
  });

  it('frames survive arbitrary chunking and oversize frames are refused', () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'two' })]);
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      for (const body of reader.push(bytes.subarray(i, i + 3))) out.push(JSON.parse(body.toString('utf8')));
    }
    expect(out).toEqual([{ a: 1 }, { b: 'two' }]);
    const small = new FrameReader(4);
    expect(() => small.push(encodeFrame({ long: 'xxxxxxxx' }))).toThrow(/cap/);
  });
});
