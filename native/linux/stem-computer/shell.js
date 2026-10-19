// The GNOME Shell extension (native/linux/gnome-extension), as the helper
// reaches it: one D-Bus method on the shell's bus name, JSON in and out, the
// token read from the private folder the extension wrote it to.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { HelperError } from './errors.js';

export const UUID = 'stem-computer@awantech.sk';
/** The extension protocol this helper speaks; an older running extension means "log out and back in". */
export const PROTOCOL = 3;
const DEST = 'org.gnome.Shell';
const PATH = '/sk/awantech/StemComputer';
const IFACE = 'sk.awantech.StemComputer';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const bus = Gio.DBus.session;
let token = null;

function tokenPath() {
  return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'stem-computer', 'token']);
}

function readToken() {
  try {
    const [, bytes] = GLib.file_get_contents(tokenPath());
    return new TextDecoder().decode(bytes).trim();
  } catch {
    return null;
  }
}

/** One request to the extension. Throws HelperError with the extension's own message. */
export async function call(op, fields = {}, retried = false) {
  token ??= readToken();
  if (!token) throw new HelperError(notReady());
  let reply;
  try {
    const result = await bus.call(
      DEST, PATH, IFACE, 'Call',
      new GLib.Variant('(ss)', [token, JSON.stringify({ ...fields, op })]),
      new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 15000, null
    );
    reply = JSON.parse(result.deepUnpack()[0]);
  } catch (e) {
    // The extension was re-enabled (new token), or is gone.
    if (!retried && /Denied/.test(String(e?.message))) {
      token = null;
      return call(op, fields, true);
    }
    if (/UnknownMethod|ServiceUnknown|Object does not exist/.test(String(e?.message))) throw new HelperError(notReady());
    throw e;
  }
  if (!reply.ok) throw new HelperError(reply.error ?? `${op} failed`);
  return reply;
}

function notReady() {
  return 'The Stem GNOME Shell extension is not running. Turn computer control on in Stem (Settings → Features → Computer control); after a first install, log out and back in.';
}

/** A `(u)` answer from the running extension, or 0 when it does not answer (or has no such method). */
async function askNumber(method) {
  try {
    const r = await bus.call(DEST, PATH, IFACE, method, null, new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 3000, null);
    return r.deepUnpack()[0];
  } catch {
    return 0;
  }
}

const runningProtocol = () => askNumber('Version');

/**
 * Have the running extension import its core.js again — the copy Stem just
 * put on disk — instead of waiting for the next login. Needs the loader
 * (LoaderVersion ≥ 1); an older extension has no Reload. Returns the protocol
 * it now speaks.
 */
export async function reload() {
  token ??= readToken();
  if (!token) throw new HelperError(notReady());
  try {
    const r = await bus.call(DEST, PATH, IFACE, 'Reload', new GLib.Variant('(s)', [token]), new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 15000, null);
    return r.deepUnpack()[0];
  } catch (e) {
    throw new HelperError(`The GNOME extension could not reload: ${e?.message ?? e}`);
  }
}

/**
 * Where the extension stands, in the words the desktop app shows: `ready`,
 * `not-gnome`, `extensions-off` (the person turned user extensions off),
 * `not-loaded` (installed or not, the shell has not loaded it: a fresh
 * install loads at the next login), `disabled`, `error`, `outdated` (the shell
 * runs an older copy than the helper needs, also cured by logging in again).
 */
export async function extensionState() {
  const desktop = (GLib.getenv('XDG_CURRENT_DESKTOP') ?? '').split(':').map((s) => s.toLowerCase());
  if (!desktop.includes('gnome') && GLib.getenv('STEM_COMPUTER_ANY_DESKTOP') !== '1') return { state: 'not-gnome' };
  if (GLib.getenv('WAYLAND_DISPLAY') === null && GLib.getenv('XDG_SESSION_TYPE') !== 'wayland') return { state: 'not-wayland' };
  let info;
  try {
    const r = await bus.call(
      DEST, '/org/gnome/Shell', 'org.gnome.Shell.Extensions', 'GetExtensionInfo',
      new GLib.Variant('(s)', [UUID]), new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, null
    );
    info = r.recursiveUnpack()[0];
  } catch {
    return { state: 'not-gnome' };
  }
  try {
    const s = new Gio.Settings({ schema_id: 'org.gnome.shell' });
    if (s.get_boolean('disable-user-extensions')) return { state: 'extensions-off' };
  } catch {
    // No shell schema: not a GNOME session after all.
  }
  if (!info || info.state === undefined) return { state: 'not-loaded' };
  // ExtensionState: 1 active, 2 inactive, 3 error, 4 out of date, 6 initialized (never enabled), 99 uninstalled.
  switch (info.state) {
    case 1: {
      const protocol = await runningProtocol();
      // `loader`: whether an update can be reloaded in place (no login).
      const loader = await askNumber('LoaderVersion');
      if (protocol < PROTOCOL) return { state: 'outdated', protocol, loader };
      return { state: 'ready', protocol, loader };
    }
    case 3:
      return { state: 'error', error: info.error ?? null };
    case 4:
      return { state: 'error', error: 'This GNOME Shell version is newer than the extension knows.' };
    case 99:
      return { state: 'not-loaded' };
    default:
      return { state: 'disabled' };
  }
}

/** Listen for the person's own input while a run is armed. Returns the unsubscribe. */
export function onHumanInput(listener) {
  const id = bus.signal_subscribe(DEST, IFACE, 'HumanInput', PATH, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) =>
    listener(params.deepUnpack()[0])
  );
  return () => bus.signal_unsubscribe(id);
}
