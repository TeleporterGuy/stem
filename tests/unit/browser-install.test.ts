// Set up for browser control (desktop/browser-host/install.ts): the extension
// copied out for Load unpacked, the wrapper the manifests point at, the
// manifests in each installed browser — Arc's twice — and a startup refresh
// that only touches an install this profile made.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserDirs,
  browserInstallPaths,
  extensionsPageUrl,
  installBrowserControl,
  installedHere,
  refreshBrowserControl,
  setupBrowsers,
  socketPathFor,
  windowsRegistry,
  wrapperBatch,
  wrapperScript
} from '../../src/desktop/browser-host/install';
import { FrameReader, encodeFrame, launchableBrowser, launchableOnLinux, windowsBrowserName } from '../../src/shared/browser-native';
import { browserOf } from '../../src/desktop/browser-host/native-host-main';
import { expectPosixMode } from './posix-mode';

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
    expectPosixMode(paths.wrapperPath, 0o700);
    expectPosixMode(paths.configPath, 0o600);
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

describe('Windows', () => {
  const local = (...p: string[]) => join(home, 'AppData', 'Local', ...p);
  let registry: Map<string, string>;

  beforeEach(() => {
    registry = new Map();
    vi.spyOn(windowsRegistry, 'read').mockImplementation((key, value) => registry.get(value ? `${key}|${value}` : key) ?? null);
    vi.spyOn(windowsRegistry, 'write').mockImplementation((key, data) => void registry.set(key, data));
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers each browser in the registry, pointing at one manifest beside a batch-file wrapper', async () => {
    mkdirSync(local('Google', 'Chrome', 'User Data'), { recursive: true });
    mkdirSync(local('Microsoft', 'Edge', 'User Data'), { recursive: true });
    const paths = browserInstallPaths(state, 'win32');
    expect(paths.wrapperPath.endsWith('stem-browser-host.cmd')).toBe(true);
    const res = await installBrowserControl(src(), paths, home, 'win32');
    expect(res.registered.sort()).toEqual(['Google Chrome', 'Microsoft Edge']);
    expect(registry.get('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.stem.browser')).toBe(paths.manifestPath);
    expect(registry.get('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.stem.browser')).toBe(paths.manifestPath);
    expect(JSON.parse(readFileSync(paths.manifestPath, 'utf8'))).toMatchObject({ name: 'com.stem.browser', path: paths.wrapperPath });
    expect(readFileSync(paths.wrapperPath, 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1\r\n');
    expect(installedHere(paths, home, 'win32')).toBe(true);
    expect(installedHere(browserInstallPaths(mkdtempSync(join(tmpdir(), 'stem-other-')), 'win32'), home, 'win32')).toBe(false);
  });

  it('offers browsers whose executable exists, the default first', () => {
    mkdirSync(local('Google', 'Chrome', 'User Data'), { recursive: true });
    mkdirSync(local('Google', 'Chrome', 'Application'), { recursive: true });
    writeFileSync(local('Google', 'Chrome', 'Application', 'chrome.exe'), '');
    mkdirSync(local('Chromium', 'User Data'), { recursive: true });
    mkdirSync(local('Chromium', 'Application'), { recursive: true });
    writeFileSync(local('Chromium', 'Application', 'chrome.exe'), '');
    // Brave was used but is gone.
    mkdirSync(local('BraveSoftware', 'Brave-Browser', 'User Data'), { recursive: true });
    expect(setupBrowsers(home, 'win32', [''], 'ChromiumHTM').map((b) => [b.name, b.app])).toEqual([
      ['Chromium', local('Chromium', 'Application', 'chrome.exe')],
      ['Google Chrome', local('Google', 'Chrome', 'Application', 'chrome.exe')]
    ]);
  });

  it('listens on a named pipe nobody can guess', () => {
    const dir = 'C:\\Users\\a\\AppData\\Roaming\\Stem\\browser';
    expect(socketPathFor(dir, 'win32')).toMatch(/^\\\\\.\\pipe\\stem-browser-[0-9a-f]{32}$/);
    expect(socketPathFor(dir, 'win32')).not.toBe(socketPathFor(dir, 'win32'));
  });

  it('quotes the paths in the batch wrapper', () => {
    expect(wrapperBatch('C:\\Program Files\\Stem\\Stem.exe', 'C:\\x\\host.js', 'C:\\s\\config.json')).toContain(
      '"C:\\Program Files\\Stem\\Stem.exe" "C:\\x\\host.js" "C:\\s\\config.json" %*'
    );
  });

  it('names the browser from its executable', () => {
    expect(browserOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe').appName).toBe('Google Chrome');
    expect(browserOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe').appName).toBe('Microsoft Edge');
    expect(browserOf('C:\\Users\\me\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe').appName).toBe('vivaldi');
  });

  it('starts only known browsers from where their installers put them', () => {
    for (const ok of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe',
      'C:\\Users\\john.doe\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]) {
      expect(windowsBrowserName(ok)).not.toBeNull();
      expect(launchableBrowser(ok, 'win32')).toBe(true);
    }
    for (const bad of [
      'C:\\Users\\me\\Downloads\\chrome.exe',
      'C:\\Users\\..\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me/../..\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe.bat',
      'chrome.exe',
      ''
    ]) {
      expect(launchableBrowser(bad, 'win32')).toBe(false);
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

  it.skipIf(process.platform === 'win32')('keeps socket paths under the unix limit', () => {
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
