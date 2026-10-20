import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GNOME_EXTENSION_UUID,
  gnomeExtensionCurrent,
  installGnomeExtension,
  linuxSetupFrom,
  parseStrv
} from '../../src/desktop/computer-host/gnome-extension';
import { helperCommand } from '../../src/desktop/computer-host/helper';

// The Linux setup: Stem's GNOME Shell extension is copied into the person's
// own extensions folder and put on GNOME's enabled list (never their other
// extensions touched), and the settings row is told whether a login is all
// that is left.

describe('GNOME extension install', () => {
  let dir: string;
  let bundled: string;
  let dataHome: string;
  let settings: Record<string, string>;
  const gsettings = (args: string[]): Promise<string> => {
    const [verb, , key, value] = args;
    if (verb === 'get') return Promise.resolve(settings[key!] ?? '@as []');
    settings[key!] = value!;
    return Promise.resolve('');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stem-gnome-ext-'));
    bundled = join(dir, 'bundled', GNOME_EXTENSION_UUID);
    dataHome = join(dir, 'share');
    mkdirSync(bundled, { recursive: true });
    writeFileSync(join(bundled, 'metadata.json'), JSON.stringify({ uuid: GNOME_EXTENSION_UUID, version: 3 }));
    writeFileSync(join(bundled, 'extension.js'), '// v3');
    settings = { 'enabled-extensions': "['blur-my-shell@aunetx', 'gsconnect@andyholmes.github.io']", 'disabled-extensions': `['${GNOME_EXTENSION_UUID}']` };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = () => ({ bundledDir: bundled, dataHome, gsettings, reload: () => Promise.resolve(false) });
  const installed = () => join(dataHome, 'gnome-shell', 'extensions', GNOME_EXTENSION_UUID);

  it('parses gsettings string lists, empty ones included', () => {
    expect(parseStrv("['a@b', 'c@d']")).toEqual(['a@b', 'c@d']);
    expect(parseStrv('@as []')).toEqual([]);
  });

  it('copies the extension in and adds it to the enabled list, keeping the others', async () => {
    expect(await gnomeExtensionCurrent(deps())).toBe(false);
    await installGnomeExtension(deps());
    expect(readFileSync(join(installed(), 'extension.js'), 'utf8')).toBe('// v3');
    expect(parseStrv(settings['enabled-extensions']!)).toEqual(['blur-my-shell@aunetx', 'gsconnect@andyholmes.github.io', GNOME_EXTENSION_UUID]);
    expect(parseStrv(settings['disabled-extensions']!)).toEqual([]);
    expect(await gnomeExtensionCurrent(deps())).toBe(true);
  });

  it('replaces an older copy, and leaves the enabled list alone when it is already on it', async () => {
    mkdirSync(installed(), { recursive: true });
    writeFileSync(join(installed(), 'metadata.json'), JSON.stringify({ version: 2 }));
    writeFileSync(join(installed(), 'stale.js'), 'old');
    settings['enabled-extensions'] = `['${GNOME_EXTENSION_UUID}']`;
    await installGnomeExtension(deps());
    expect(JSON.parse(readFileSync(join(installed(), 'metadata.json'), 'utf8')).version).toBe(3);
    expect(() => readFileSync(join(installed(), 'stale.js'))).toThrow();
    expect(settings['enabled-extensions']).toBe(`['${GNOME_EXTENSION_UUID}']`);
  });

  it('says log in again when the shell has not loaded a current copy, install when there is none', async () => {
    expect(await linuxSetupFrom({ state: 'not-loaded' }, deps())).toEqual({ state: 'not-installed' });
    await installGnomeExtension(deps());
    expect(await linuxSetupFrom({ state: 'not-loaded' }, deps())).toEqual({ state: 'relogin' });
    expect(await linuxSetupFrom({ state: 'outdated' }, deps())).toEqual({ state: 'relogin' });
    expect(await linuxSetupFrom({ state: 'ready' }, deps())).toEqual({ state: 'ready' });
    expect(await linuxSetupFrom({ state: 'error', error: 'SyntaxError' }, deps())).toEqual({ state: 'error', error: 'SyntaxError' });
  });

  it('runs the Linux helper under gjs, and a native helper as itself', () => {
    expect(helperCommand('/opt/Stem/resources/linux/stem-computer/main.js')).toMatchObject({ args: ['-m', '/opt/Stem/resources/linux/stem-computer/main.js'] });
    expect(helperCommand('/Applications/Stem.app/Contents/Resources/bin/stem-computer')).toEqual({
      command: '/Applications/Stem.app/Contents/Resources/bin/stem-computer',
      args: []
    });
  });
});
