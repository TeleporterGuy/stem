// Stem computer control, the GNOME Shell half. On Wayland an app cannot see
// other windows or move the pointer, so the Linux helper
// (native/linux/stem-computer, a gjs child of the Stem desktop app) asks the
// compositor through this extension instead: the window list, a picture of the
// screen or of one window, and a virtual pointer and keyboard. Everything it
// reads about a window's controls (AT-SPI) the helper does itself, out here,
// so a hung app can never stall the shell.
//
// The interface is one method on the shell's own bus name, `Call(token,
// request)` with JSON in and out. The token is made fresh each time the
// extension is enabled and kept in $XDG_RUNTIME_DIR/stem-computer/token
// (0600): a sandboxed app sees neither the file nor, past its bus filter, the
// shell — only a program running unsandboxed as this user gets in, and that
// one could already rewrite the user's files. Pictures go back as PNG files in
// the same private folder, named by the extension, never by the caller.
//
// This file is only the loader: GNOME reads an extension's own file once per
// login, so the work lives in core.js, which `Reload(token)` imports again
// from this extension's own folder — a Stem update takes effect at once
// instead of at the next login. Keep this file small and stable: a change
// here still needs a login.
//
// Nothing here acts on its own. `watch` reports the person's own input while a
// run drives the screen (the kill switch); it reports, it never blocks input.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/** What this loader can do; the helper looks for `Reload` from 1 on. */
const LOADER = 1;
const OBJECT_PATH = '/sk/awantech/StemComputer';
const IFACE = `<node>
  <interface name="sk.awantech.StemComputer">
    <method name="Version"><arg type="u" direction="out" name="protocol"/></method>
    <method name="LoaderVersion"><arg type="u" direction="out" name="loader"/></method>
    <method name="Call">
      <arg type="s" direction="in" name="token"/>
      <arg type="s" direction="in" name="request"/>
      <arg type="s" direction="out" name="reply"/>
    </method>
    <method name="Reload">
      <arg type="s" direction="in" name="token"/>
      <arg type="u" direction="out" name="protocol"/>
    </method>
    <signal name="HumanInput"><arg type="s" name="kind"/></signal>
  </interface>
</node>`;

export default class StemComputerExtension extends Extension {
  enable() {
    this._runtime = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'stem-computer']);
    GLib.mkdir_with_parents(this._runtime, 0o700);
    this._token = GLib.uuid_string_random() + GLib.uuid_string_random();
    const file = Gio.File.new_for_path(GLib.build_filenamev([this._runtime, 'token']));
    const out = file.replace(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    out.write_all(new TextEncoder().encode(this._token), null);
    out.close(null);
    this._sweepShots();
    this._core = null;
    this._protocol = 0;
    this._loads = 0;
    this._ready = this._load();
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._dbus.export(Gio.DBus.session, OBJECT_PATH);
  }

  disable() {
    this._core?.destroy();
    this._core = null;
    this._dbus?.unexport();
    this._dbus = null;
    this._token = null;
    try {
      Gio.File.new_for_path(GLib.build_filenamev([this._runtime, 'token'])).delete(null);
    } catch {
      // Already gone.
    }
  }

  /**
   * core.js from this extension's own folder, imported under a fresh URL so a
   * copy Stem replaced on disk is read again (the module cache keys by URL).
   */
  async _load() {
    const url = `${this.dir.get_child('core.js').get_uri()}?load=${++this._loads}-${Date.now()}`;
    const mod = await import(url);
    const core = new mod.Core({
      dir: this._runtime,
      emitHumanInput: (kind) => this._dbus?.emit_signal('HumanInput', new GLib.Variant('(s)', [kind]))
    });
    // A reload mid-run must not leave the screen driven with the kill switch
    // off: an armed watch moves to the new core before the old one goes.
    if (this._core?.watching) core.watch?.();
    this._core?.destroy();
    this._core = core;
    this._protocol = mod.PROTOCOL;
    this._Failure = mod.Failure;
  }

  Version() {
    return this._protocol;
  }

  LoaderVersion() {
    return LOADER;
  }

  ReloadAsync([token], invocation) {
    if (!this._token || token !== this._token) {
      invocation.return_dbus_error('sk.awantech.StemComputer.Denied', 'Wrong token.');
      return;
    }
    this._ready = this._load();
    this._ready.then(
      () => invocation.return_value(new GLib.Variant('(u)', [this._protocol])),
      (e) => {
        console.warn(`stem-computer: reload failed: ${e?.message ?? e}`);
        invocation.return_dbus_error('sk.awantech.StemComputer.ReloadFailed', String(e?.message ?? e));
      }
    );
  }

  CallAsync([token, request], invocation) {
    if (!this._token || token !== this._token) {
      invocation.return_dbus_error('sk.awantech.StemComputer.Denied', 'Wrong token.');
      return;
    }
    let req;
    try {
      req = JSON.parse(request);
    } catch {
      invocation.return_dbus_error('sk.awantech.StemComputer.Invalid', 'Unreadable request.');
      return;
    }
    const callerPid = this._pidOf(invocation.get_sender());
    this._ready
      .then(() => this._core.handle(req, callerPid))
      .then(
        (reply) => invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ ok: true, ...reply })])),
        (e) => {
          const failure = this._Failure && e instanceof this._Failure;
          const error = failure ? e.message : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
          if (!failure) console.warn(`stem-computer: ${req.op}: ${error}`);
          invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ ok: false, error })]));
        }
      );
  }

  /** The process behind a bus name, or -1. */
  _pidOf(sender) {
    try {
      const r = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]), new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 1000, null);
      return r.deepUnpack()[0];
    } catch {
      return -1;
    }
  }

  /** Leftover pictures from a helper that died before reading them. */
  _sweepShots() {
    try {
      const dir = Gio.File.new_for_path(this._runtime);
      const files = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
      let info;
      while ((info = files.next_file(null))) {
        if (info.get_name().startsWith('shot-')) dir.get_child(info.get_name()).delete(null);
      }
    } catch {
      // Nothing to sweep.
    }
  }
}
