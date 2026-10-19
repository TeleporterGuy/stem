// The working half of Stem's GNOME Shell extension: everything Stem asks
// the compositor for (see extension.js for the interface and the trust
// model). Kept apart from the loader so a newer copy can be imported in
// place — `Reload` — instead of waiting for the next login, which is the
// only time GNOME loads an extension's own file.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Bumped when the helper needs something this file did not have. */
export const PROTOCOL = 3;

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

/** A refusal the caller reads as is. */
export class Failure extends Error {}

const LISTED_TYPES = new Set([
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY
]);

function rect(r) {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export class Core {
  /**
   * @param {{ dir: string, emitHumanInput(kind: string): void }} host
   *   the private runtime folder (pictures, debug flag) and the loader's signal
   */
  constructor(host) {
    this._dir = host.dir;
    this._emitHumanInput = host.emitHumanInput;
    this._pointer = null;
    this._keyboard = null;
    this._filter = 0;
    this._fired = false;
    /** When this extension last sent pointer / key input, to tell its own events from the person's. */
    this._sent = { pointer: 0, key: 0 };
    this._callerPid = -1;
  }

  /** Is the kill switch armed (a run is driving the screen)? */
  get watching() {
    return this._filter !== 0 && !this._fired;
  }

  /** Arm the kill switch (the loader carries it across a reload). */
  watch() {
    this._watch();
  }

  /** Stop watching and let go of the virtual devices (disable, or a reload). */
  destroy() {
    this._unwatch();
    this._pointer = null;
    this._keyboard = null;
  }

  /** One request; `callerPid` is the process behind the D-Bus caller. */
  handle(req, callerPid) {
    this._callerPid = callerPid;
    return this._handle(req);
  }

  async _handle(req) {
    switch (req.op) {
      case 'info':
        return this._info();
      case 'windows':
        return { windows: this._windows() };
      case 'shot':
        return req.window !== undefined ? this._shotWindow(req.window) : this._shotArea(req.area);
      case 'motion':
        this._sent.pointer = Date.now();
        (await this._ensurePointer()).notify_absolute_motion(GLib.get_monotonic_time(), req.x, req.y);
        return {};
      case 'button':
        this._sent.pointer = Date.now();
        (await this._ensurePointer()).notify_button(
          GLib.get_monotonic_time(),
          req.button,
          req.press ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED
        );
        return {};
      case 'scroll': {
        const dir = {
          up: Clutter.ScrollDirection.UP,
          down: Clutter.ScrollDirection.DOWN,
          left: Clutter.ScrollDirection.LEFT,
          right: Clutter.ScrollDirection.RIGHT
        }[req.dir];
        if (dir === undefined) throw new Failure('scroll direction must be up, down, left or right.');
        const p = await this._ensurePointer();
        this._sent.pointer = Date.now();
        for (let i = 0; i < Math.max(1, Math.min(req.steps ?? 1, 50)); i++)
          p.notify_discrete_scroll(GLib.get_monotonic_time(), dir, Clutter.ScrollSource.WHEEL);
        return {};
      }
      case 'keyval':
        this._sent.key = Date.now();
        (await this._ensureKeyboard()).notify_keyval(
          GLib.get_monotonic_time(),
          req.keyval,
          req.press ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED
        );
        return {};
      case 'commit':
        // Text for the focused field through the input method, the way the
        // on-screen keyboard types: any character, whatever the layout. Only
        // a client that takes input-method text (text-input-v3) has a focus.
        if (!Main.inputMethod?.currentFocus) return { committed: false };
        this._sent.key = Date.now();
        Main.inputMethod.commit(req.text);
        return { committed: true };
      case 'place': {
        // Wayland lets no app place its own window: the run's banner asks
        // here to sit at the top of the screen, above everything, on every
        // workspace. Only a window of the app that asked moves: the helper
        // that calls is a child of Stem, whose window it places.
        const w = this._find(req.window);
        const pid = w.get_pid();
        if (pid !== this._callerPid && pid !== this._parentOf(this._callerPid)) throw new Failure('Only Stem\'s own windows can be placed.');
        if (!w.is_above()) w.make_above();
        if (!w.is_on_all_workspaces()) w.stick();
        w.move_frame(false, Math.round(req.x), Math.round(req.y));
        return {};
      }
      case 'pointer': {
        const [x, y] = global.get_pointer();
        return { x, y };
      }
      case 'watch':
        if (req.on) this._watch();
        else this._unwatch();
        return {};
      default:
        throw new Failure(`unknown op "${req.op}"`);
    }
  }

  /** A process's parent, from /proc, or -1. */
  _parentOf(pid) {
    try {
      const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
      const stat = new TextDecoder().decode(bytes);
      // "pid (comm) state ppid …" — comm may hold spaces and parentheses.
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
      return -1;
    }
  }

  _info() {
    const display = global.display;
    const monitors = [];
    for (let i = 0; i < display.get_n_monitors(); i++) {
      monitors.push({ ...rect(display.get_monitor_geometry(i)), scale: display.get_monitor_scale(i) });
    }
    const [x, y] = global.get_pointer();
    return {
      protocol: PROTOCOL,
      shell: Config.PACKAGE_VERSION,
      primary: display.get_primary_monitor(),
      monitors,
      pointer: { x, y }
    };
  }

  /** Top-level windows a person would call a window, the top of the stack first. */
  _windows() {
    const display = global.display;
    const active = global.workspace_manager.get_active_workspace();
    const tracker = Shell.WindowTracker.get_default();
    const focus = display.focus_window;
    const all = global
      .get_window_actors()
      .map((a) => a.get_meta_window())
      .filter((w) => w && LISTED_TYPES.has(w.get_window_type()) && !w.is_override_redirect());
    return display
      .sort_windows_by_stacking(all)
      .reverse()
      .map((w) => {
        // An app GNOME cannot place gets a made-up "window:N" one; its class names it better.
        let app = tracker.get_window_app(w);
        if (app?.get_id()?.startsWith('window:')) app = null;
        return {
          id: w.get_id(),
          title: w.get_title() ?? '',
          app: app?.get_name() ?? w.get_wm_class() ?? '',
          appId: app?.get_id() ?? w.get_sandboxed_app_id() ?? w.get_gtk_application_id() ?? null,
          wmClass: w.get_wm_class() ?? null,
          pid: w.get_pid(),
          frame: rect(w.get_frame_rect()),
          buffer: rect(w.get_buffer_rect()),
          minimized: w.minimized,
          focused: w === focus,
          otherWorkspace: !(w.is_on_all_workspaces() || w.located_on_workspace(active)),
          monitor: w.get_monitor(),
          scale: display.get_monitor_scale(Math.max(0, w.get_monitor()))
        };
      });
  }

  _find(id) {
    const w = global
      .get_window_actors()
      .map((a) => a.get_meta_window())
      .find((x) => x && x.get_id() === id);
    if (!w) throw new Failure(`No window ${id} is open now.`);
    return w;
  }

  _shotFile() {
    const path = GLib.build_filenamev([this._dir, `shot-${GLib.uuid_string_random()}.png`]);
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    return { path, stream };
  }

  /** The screen, or a part of it, in stage coordinates. The picture is in physical pixels. */
  async _shotArea(area) {
    const display = global.display;
    const a = area ?? rect(display.get_monitor_geometry(display.get_primary_monitor()));
    const { path, stream } = this._shotFile();
    try {
      await new Shell.Screenshot().screenshot_area(a.x, a.y, a.width, a.height, stream);
    } finally {
      stream.close(null);
    }
    return { path, area: a };
  }

  /**
   * One window wherever it is in the stack, cropped to its visible frame (no
   * client-side shadow). A minimized window paints nothing.
   */
  async _shotWindow(id) {
    const w = this._find(id);
    if (w.minimized) throw new Failure('minimized');
    const actor = w.get_compositor_private();
    if (!actor) throw new Failure('The window has nothing to show yet.');
    const content = actor.paint_to_content(null);
    const texture = content?.get_texture();
    if (!texture) throw new Failure('The compositor would not paint that window.');
    const frame = w.get_frame_rect();
    const buffer = w.get_buffer_rect();
    const ratio = texture.get_width() / Math.max(1, buffer.width);
    const x = Math.max(0, Math.round((frame.x - buffer.x) * ratio));
    const y = Math.max(0, Math.round((frame.y - buffer.y) * ratio));
    const width = Math.min(texture.get_width() - x, Math.round(frame.width * ratio));
    const height = Math.min(texture.get_height() - y, Math.round(frame.height * ratio));
    const { path, stream } = this._shotFile();
    try {
      await Shell.Screenshot.composite_to_stream(texture, x, y, width, height, ratio, null, 0, 0, 1, stream);
    } finally {
      stream.close(null);
    }
    return { path, area: rect(frame) };
  }

  _seat() {
    return Clutter.get_default_backend().get_default_seat();
  }

  /**
   * A new virtual device is added to the seat asynchronously, and the event
   * sent before that lands is dropped (a lost first key, with a stray level
   * shift on the next): made on first use, then given a moment to settle.
   */
  async _settled(device) {
    await new Promise((resolve) =>
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
      })
    );
    return device;
  }

  _ensurePointer() {
    if (this._pointer) return this._pointer;
    this._pointer = this._settled(this._seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE));
    return this._pointer;
  }

  _ensureKeyboard() {
    if (this._keyboard) return this._keyboard;
    this._keyboard = this._settled(this._seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE));
    return this._keyboard;
  }

  /**
   * The kill switch: the person's first press, click, scroll or real pointer
   * move while armed. Our own virtual devices are told apart by their device,
   * which is not the person's hardware. Reported once per arming.
   */
  _watch() {
    this._fired = false;
    if (this._filter) return;
    this._filter = Clutter.Event.add_filter(null, (event) => {
      if (this._fired) return Clutter.EVENT_PROPAGATE;
      const kind = {
        [Clutter.EventType.KEY_PRESS]: 'key',
        [Clutter.EventType.BUTTON_PRESS]: 'mouse',
        [Clutter.EventType.SCROLL]: 'mouse',
        [Clutter.EventType.MOTION]: 'mouse',
        [Clutter.EventType.TOUCH_BEGIN]: 'touch'
      }[event.type()];
      if (!kind) return Clutter.EVENT_PROPAGATE;
      const device = event.get_source_device();
      const ours = this._isOurs(device, kind);
      if (this._debug()) {
        console.log(`stem-computer: ${kind} from "${device?.get_device_name()}" node=${device?.get_device_node()} type=${device?.get_device_type()} ours=${ours}`);
      }
      if (ours) return Clutter.EVENT_PROPAGATE;
      this._fired = true;
      this._emitHumanInput(kind);
      return Clutter.EVENT_PROPAGATE;
    });
  }

  /**
   * Is this event the input this extension just sent? A device with a device
   * file is always the person's: a real mouse, or a streaming client's uinput
   * device (Sunshine's "libvirtualhid Mouse") — the person is just remote. The
   * compositor's own virtual devices (ours, a remote-desktop session's, a
   * libei client's) all look alike, so one of those counts as ours only right
   * after we sent that kind of input; anything else on them is someone else.
   */
  _isOurs(device, kind) {
    if (!device || device.get_device_node()) return false;
    const last = kind === 'key' ? this._sent.key : this._sent.pointer;
    return Date.now() - last < 300;
  }

  /** `touch $XDG_RUNTIME_DIR/stem-computer/debug` logs every watched event to the journal. */
  _debug() {
    return GLib.file_test(GLib.build_filenamev([this._dir, 'debug']), GLib.FileTest.EXISTS);
  }

  _unwatch() {
    if (this._filter) Clutter.Event.remove_filter(this._filter);
    this._filter = 0;
  }
}
