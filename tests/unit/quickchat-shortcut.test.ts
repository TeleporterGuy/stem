import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// platform.ts decides isLinux/isMac at import time, so each case sets the platform
// and env it wants, then imports a fresh copy. The electron stub is re-imported with
// it: vi.resetModules() gives platform.ts a new stub instance, so the switches this
// asserts on have to come from that same fresh instance.
const realPlatform = process.platform;
const savedEnv = { ...process.env };

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

async function load() {
  vi.resetModules();
  const [platform, electron] = await Promise.all([
    import('../../src/server/platform'),
    import('../electron-stub')
  ]);
  return { ...platform, switches: electron.app.commandLine.switches, appPath: electron.app.getAppPath() };
}

beforeEach(() => {
  for (const key of [
    'XDG_SESSION_TYPE',
    'WAYLAND_DISPLAY',
    'ELECTRON_OZONE_PLATFORM_HINT',
    'STEM_E2E_SESSION',
    'APPIMAGE'
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  process.env = { ...savedEnv };
});

describe('Quick Chat summon on Linux', () => {
  it('recognizes a Wayland session from any of the signals the DE sets', async () => {
    setPlatform('linux');
    expect((await load()).isWaylandSession()).toBe(false); // X11: nothing set

    process.env.XDG_SESSION_TYPE = 'Wayland'; // capitalized, as some DEs write it
    expect((await load()).isWaylandSession()).toBe(true);

    delete process.env.XDG_SESSION_TYPE;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    expect((await load()).isWaylandSession()).toBe(true);

    delete process.env.WAYLAND_DISPLAY;
    process.env.ELECTRON_OZONE_PLATFORM_HINT = 'wayland';
    expect((await load()).isWaylandSession()).toBe(true);
  });

  it('lets STEM_E2E_SESSION override the detected session both ways', async () => {
    setPlatform('linux');
    // Tests need the Wayland *answer* without the Wayland *backend*: the signals
    // above double as Chromium's ozone selector, so faking them starts an Electron
    // that tries to reach a compositor that isn't running.
    process.env.STEM_E2E_SESSION = 'wayland';
    expect((await load()).isWaylandSession()).toBe(true);

    // And it must pin X11 on a real Wayland desktop, or every E2E spec that
    // expects the non-Wayland UI fails on the contributor's machine only.
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    process.env.STEM_E2E_SESSION = 'x11';
    expect((await load()).isWaylandSession()).toBe(false);
  });

  it('never reports Wayland off Linux, however the env looks', async () => {
    setPlatform('darwin');
    process.env.XDG_SESSION_TYPE = 'wayland';
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    expect((await load()).isWaylandSession()).toBe(false);
  });

  it('enables the global-shortcuts portal on Linux only', async () => {
    setPlatform('linux');
    const linux = await load();
    linux.enableGlobalShortcutPortal();
    expect(linux.switches).toEqual([['enable-features', 'GlobalShortcutsPortal']]);

    setPlatform('darwin');
    const mac = await load();
    mac.enableGlobalShortcutPortal();
    expect(mac.switches).toEqual([]);
  });

  it('points the DE keybinding at the AppImage rather than its temporary mount', async () => {
    setPlatform('linux');
    // execPath inside an AppImage lives in a /tmp/.mount_* dir that is gone by the
    // time a keybinding fires; $APPIMAGE is the file the user can actually re-run.
    process.env.APPIMAGE = '/home/u/Apps/Stem 0.1.0.AppImage';
    const command = (await load()).quickChatSummonCommand();
    expect(command).toContain('"/home/u/Apps/Stem 0.1.0.AppImage"'); // quoted: the path has spaces
    expect(command.endsWith('--quick-chat')).toBe(true);
  });

  it('includes the app directory when running unpackaged, so Electron opens Stem', async () => {
    setPlatform('linux');
    const { quickChatSummonCommand, appPath } = await load();
    const command = quickChatSummonCommand();
    expect(command).toContain(process.execPath);
    expect(command).toContain(appPath);
    expect(command.endsWith('--quick-chat')).toBe(true);
  });
});
