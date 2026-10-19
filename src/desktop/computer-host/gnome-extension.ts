import { execFile } from 'node:child_process';
import { cp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LinuxComputerSetup } from '../../shared/types';
import { linuxNativeRoot, oneShot } from './helper';

// Stem's GNOME Shell extension (native/linux/gnome-extension), which the Linux
// helper asks for the screen, the window list and a virtual pointer and
// keyboard: Wayland gives an app none of those. Installing is a copy into the
// person's own extensions folder plus adding it to GNOME's enabled list; the
// shell only discovers a new extension when it starts, so a first install (and
// an update to a newer copy) takes effect at the next login — the settings row
// says so. Nothing here needs root.

export const GNOME_EXTENSION_UUID = 'stem-computer@awantech.sk';

const run = promisify(execFile);

export interface GnomeExtensionDeps {
  /** The bundled copy; defaults to resources/linux (packaged) or native/linux. */
  bundledDir?: string;
  /** $XDG_DATA_HOME, else ~/.local/share. */
  dataHome?: string;
  gsettings?(args: string[]): Promise<string>;
  /** Ask the running extension to import the new files; defaults to the helper's reload-extension. */
  reload?(): Promise<boolean>;
}

/** The running extension re-imports core.js (needs its loader); false when it cannot. */
async function reloadRunning(): Promise<boolean> {
  const reply = await oneShot('reload-extension');
  return reply.ok;
}

function paths(deps: GnomeExtensionDeps) {
  const dataHome = deps.dataHome ?? (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return {
    bundled: deps.bundledDir ?? join(linuxNativeRoot(), 'gnome-extension', GNOME_EXTENSION_UUID),
    installed: join(dataHome, 'gnome-shell', 'extensions', GNOME_EXTENSION_UUID)
  };
}

async function gsettingsCli(args: string[]): Promise<string> {
  const { stdout } = await run('gsettings', args, { timeout: 5000 });
  return stdout.trim();
}

/** The `version` in a copy's metadata.json, or null when there is no readable copy. */
async function versionAt(dir: string): Promise<number | null> {
  try {
    const meta = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as { version?: unknown };
    return typeof meta.version === 'number' ? meta.version : null;
  } catch {
    return null;
  }
}

/** Is the copy in the person's extensions folder the one this Stem ships? */
export async function gnomeExtensionCurrent(deps: GnomeExtensionDeps = {}): Promise<boolean> {
  const p = paths(deps);
  const [have, ship] = await Promise.all([versionAt(p.installed), versionAt(p.bundled)]);
  return have !== null && have === ship;
}

/** A GVariant string list as gsettings prints it: `['a', 'b']` or `@as []`. */
export function parseStrv(text: string): string[] {
  return [...text.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

function formatStrv(list: string[]): string {
  return `[${list.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;
}

/**
 * Copies the bundled extension in (replacing an older copy) and puts it on
 * GNOME's enabled list. A running shell that already knows it enables it at
 * once; otherwise it loads at the next login.
 */
export async function installGnomeExtension(deps: GnomeExtensionDeps = {}): Promise<void> {
  const p = paths(deps);
  const gsettings = deps.gsettings ?? gsettingsCli;
  if (!(await gnomeExtensionCurrent(deps))) {
    if ((await versionAt(p.bundled)) === null) throw new Error(`The GNOME extension is missing from this Stem (looked in ${p.bundled}).`);
    await rm(p.installed, { recursive: true, force: true });
    await cp(p.bundled, p.installed, { recursive: true });
    // A running copy with the loader takes the new core.js at once.
    await (deps.reload ?? reloadRunning)().catch(() => false);
  }
  const enabled = parseStrv(await gsettings(['get', 'org.gnome.shell', 'enabled-extensions']));
  if (!enabled.includes(GNOME_EXTENSION_UUID)) {
    await gsettings(['set', 'org.gnome.shell', 'enabled-extensions', formatStrv([...enabled, GNOME_EXTENSION_UUID])]);
  }
  const disabled = parseStrv(await gsettings(['get', 'org.gnome.shell', 'disabled-extensions']).catch(() => '[]'));
  if (disabled.includes(GNOME_EXTENSION_UUID)) {
    await gsettings(['set', 'org.gnome.shell', 'disabled-extensions', formatStrv(disabled.filter((u) => u !== GNOME_EXTENSION_UUID))]);
  }
}

/**
 * A running extension that still speaks the helper's protocol, but older
 * files than this Stem ships: the newer copy goes in quietly and takes over at
 * the next login. Never touches the enabled list.
 */
export async function refreshGnomeExtensionFiles(deps: GnomeExtensionDeps = {}): Promise<boolean> {
  if (await gnomeExtensionCurrent(deps)) return false;
  const p = paths(deps);
  if ((await versionAt(p.bundled)) === null) return false;
  await rm(p.installed, { recursive: true, force: true });
  await cp(p.bundled, p.installed, { recursive: true });
  await (deps.reload ?? reloadRunning)().catch(() => false);
  return true;
}

/**
 * The setup as the settings row shows it, from what the helper saw running
 * (`state`) and what is on disk. A shell that has not loaded the extension
 * needs an install when the copy on disk is missing or older, and only a new
 * login when the current copy is already there.
 */
export async function linuxSetupFrom(
  helper: { state: string; error?: string | null } | undefined,
  deps: GnomeExtensionDeps = {}
): Promise<LinuxComputerSetup> {
  const state = helper?.state ?? 'not-loaded';
  switch (state) {
    case 'ready':
    case 'disabled':
    case 'extensions-off':
    case 'not-gnome':
    case 'not-wayland':
      return { state };
    case 'error':
      return { state: 'error', ...(helper?.error ? { error: helper.error } : {}) };
    default:
      // 'not-loaded' or 'outdated': the shell runs no current copy.
      return { state: (await gnomeExtensionCurrent(deps)) ? 'relogin' : 'not-installed' };
  }
}
