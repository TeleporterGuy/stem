// AT-SPI: how a run reaches a window that is not in front, the Linux twin of
// the Mac helper's AX.swift and the Windows helper's Uia.cs. Wayland gives an
// app no way to send input to a window behind others, so window mode asks the
// window's accessibility tree instead: press this button, set that field's
// text. Coverage follows the app's own tree: GTK, Qt, Chromium and Firefox
// answer; canvases and games are blank.
//
// Positions: on Wayland an app does not know where its window sits, so every
// extent is read relative to the window (ATSPI_COORD_TYPE_WINDOW) and placed
// on the stage through the window's frame, which the compositor does know.

import Atspi from 'gi://Atspi';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { HelperError } from './errors.js';

const MAX_NODES = 400;
let initialized = false;
let enabledBefore = null;

function init() {
  if (initialized) return;
  Atspi.init();
  // A hung app must not hang the helper: 2s per call, then the call fails.
  Atspi.set_timeout(2000, 5000);
  initialized = true;
}

/**
 * Chromium and Electron build their trees only once an assistive technology
 * is said to be listening; GTK always does. Set for the run, put back after.
 */
export function enableToolkits() {
  try {
    const bus = Gio.DBus.session;
    const get = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Get',
      new GLib.Variant('(ss)', ['org.a11y.Status', 'IsEnabled']), null, Gio.DBusCallFlags.NONE, 2000, null);
    const on = get.recursiveUnpack()[0];
    if (enabledBefore === null) enabledBefore = on;
    if (!on) setEnabled(true);
  } catch {
    // No accessibility bus: the trees stay as they are.
  }
}

function setEnabled(on) {
  Gio.DBus.session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
    new GLib.Variant('(ssv)', ['org.a11y.Status', 'IsEnabled', new GLib.Variant('b', on)]), null, Gio.DBusCallFlags.NONE, 2000, null);
}

export function restoreToolkits() {
  if (enabledBefore === false) {
    try {
      setEnabled(false);
    } catch {
      // Gone with the session.
    }
  }
  enabledBefore = null;
}

function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function children(el) {
  const n = safe(() => el.get_child_count(), 0);
  const out = [];
  for (let i = 0; i < n && i < 2000; i++) {
    const c = safe(() => el.get_child_at_index(i));
    if (c) out.push(c);
  }
  return out;
}

const roleName = (el) => safe(() => el.get_role_name(), '') ?? '';
const nameOf = (el) => safe(() => el.get_name(), '') ?? '';
const has = (el, state) => safe(() => el.get_state_set().contains(state), false);

/**
 * The text an element holds, up to `max` characters. Called through the Text
 * interface by name: Accessible has a get_text() of its own that shadows it.
 */
function textOf(el, max) {
  if (!safe(() => el.get_text_iface())) return null;
  return safe(() => Atspi.Text.prototype.get_text.call(el, 0, Math.min(max, Atspi.Text.prototype.get_character_count.call(el))));
}

function clip(s, limit = 80) {
  if (s === null || s === undefined) return null;
  s = String(s).replace(/\r?\n/g, '⏎').replace(/￼/g, '').trim();
  if (!s) return null;
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** Extents relative to the window, or null. */
function extents(el) {
  const c = safe(() => el.get_component_iface());
  if (!c) return null;
  const r = safe(() => c.get_extents(Atspi.CoordType.WINDOW));
  return r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

const ROLES = {
  'push button': 'button', 'toggle button': 'button', 'push button menu': 'menubutton', 'check box': 'checkbox',
  'radio button': 'radio', entry: 'textfield', 'password text': 'password', 'spin button': 'stepper',
  label: 'text', static: 'text', paragraph: 'text', link: 'link', image: 'image', icon: 'image',
  'menu item': 'menuitem', 'check menu item': 'menuitem', 'radio menu item': 'menuitem', menu: 'menu',
  'menu bar': 'menubar', list: 'list', 'list box': 'list', 'list item': 'row', table: 'table',
  'tree table': 'table', tree: 'outline', 'table row': 'row', 'tree item': 'row', 'table cell': 'cell',
  'page tab list': 'tabs', 'page tab': 'tab', 'tool bar': 'toolbar', slider: 'slider', 'combo box': 'combobox',
  panel: 'group', filler: 'group', section: 'group', grouping: 'group', frame: 'window', window: 'window',
  dialog: 'window', 'scroll bar': 'scrollbar', heading: 'heading', 'document web': 'document',
  'document frame': 'document', 'document text': 'document', 'progress bar': 'progress',
  'status bar': 'statusbar', separator: 'separator', 'tool tip': 'tooltip', 'column header': 'column',
  'row header': 'header', text: 'textfield'
};

const STRUCTURAL = new Set([
  'panel', 'filler', 'section', 'unknown', 'redundant object', 'scroll pane', 'viewport', 'layered pane',
  'split pane', 'root pane', 'glass pane', 'internal frame', 'list', 'list box', 'table', 'tree table', 'tree',
  'tool bar', 'page tab list', 'document web', 'document frame', 'grouping', 'form', 'landmark', 'separator',
  'scroll bar', 'menu bar', 'block quote', 'article', 'application', 'frame', 'window', 'dialog'
]);

const FIELDS = new Set(['entry', 'password text', 'text', 'combo box', 'spin button', 'document text', 'terminal']);
const PRESS_ACTIONS = ['click', 'press', 'activate', 'toggle', 'jump', 'open', 'select', 'expand or contract', 'expand', 'collapse'];
const MENU_ACTIONS = ['showmenu', 'show menu', 'popup', 'menu', 'context menu'];

function actionNames(el) {
  const a = safe(() => el.get_action_iface());
  if (!a) return [];
  const n = safe(() => a.get_n_actions(), 0);
  const out = [];
  for (let i = 0; i < n; i++) out.push((safe(() => a.get_action_name(i), '') ?? '').toLowerCase());
  return out;
}

function doNamed(el, wanted) {
  const a = safe(() => el.get_action_iface());
  if (!a) return false;
  const names = actionNames(el);
  for (const w of wanted) {
    const i = names.indexOf(w);
    if (i >= 0) return safe(() => a.do_action(i), false) !== false;
  }
  return false;
}

/** The window's accessible: by process first, then by title (a sandboxed app's process is a proxy's). */
export function findWindow(win) {
  init();
  const desktop = Atspi.get_desktop(0);
  const apps = children(desktop);
  const tops = (apps) => apps.flatMap((app) => children(app));
  const byPid = apps.filter((app) => safe(() => app.get_process_id()) === win.pid);
  const title = win.title ?? '';
  const pick = (cands) => {
    if (cands.length === 0) return null;
    const named = cands.filter((c) => nameOf(c) === title);
    const pool = named.length > 0 ? named : cands;
    // The active one, else one whose size matches the frame.
    return (
      pool.find((c) => has(c, Atspi.StateType.ACTIVE)) ??
      pool.find((c) => {
        const e = extents(c);
        return e && Math.abs(e.width - win.frame.width) <= 2 && Math.abs(e.height - win.frame.height) <= 2;
      }) ??
      (named.length > 0 || cands.length === 1 ? pool[0] : null)
    );
  };
  const mine = tops(byPid);
  return pick(mine) ?? (title ? pick(tops(apps).filter((c) => nameOf(c) === title)) : null);
}

/** One selected window's tree, its element ids, and the actions on them. */
export class WindowTree {
  constructor(win) {
    this.win = win;
    this.root = null;
    this.nodes = new Map();
    this.snapshotTaken = false;
    /** The field last focused by id or click, for toolkits that refuse focus. */
    this.chosen = null;
  }

  update(win) {
    this.win = win;
  }

  ensureRoot() {
    if (this.root) {
      if (safe(() => this.root.get_role_name()) !== null) return this.root;
      this.root = null;
    }
    enableToolkits();
    const root = findWindow(this.win);
    if (!root) {
      throw new HelperError(`${this.win.app}'s window exposes no accessibility tree Stem can find; clear the window (select_window with no arguments) and use the screen.`);
    }
    this.root = root;
    return root;
  }

  /** Window-relative extents → stage rectangle. */
  toStage(e) {
    const rootExt = extents(this.root) ?? { x: 0, y: 0 };
    return { x: this.win.frame.x + (e.x - rootExt.x), y: this.win.frame.y + (e.y - rootExt.y), width: e.width, height: e.height };
  }

  /** The window's controls, one line each with a fresh id, positioned in pixels of the current picture. */
  snapshot(maxDepth, toPixel, unitsPerShotPixel) {
    const top = this.ensureRoot();
    const lines = [];
    let truncated = false;
    const started = Date.now();
    const frame = this.win.frame;
    const walk = (el, depth, indent) => {
      if (this.nodes.size >= MAX_NODES || Date.now() - started > 8000) {
        truncated = true;
        return;
      }
      const role = roleName(el);
      const e = extents(el);
      const stage = e ? this.toStage(e) : null;
      if (stage && (stage.x + stage.width < frame.x - 2 || stage.y + stage.height < frame.y - 2 || stage.x > frame.x + frame.width + 2 || stage.y > frame.y + frame.height + 2)) return;
      if (e && !has(el, Atspi.StateType.SHOWING) && role !== 'frame') return;
      const label = clip(nameOf(el)) ?? clip(safe(() => el.get_description()));
      const password = role === 'password text';
      const editable = has(el, Atspi.StateType.EDITABLE) && !!safe(() => el.get_editable_text_iface());
      const valueIface = safe(() => el.get_value_iface());
      let value = null;
      if (!password && (FIELDS.has(role) || editable)) {
        value = clip(textOf(el, 200));
      } else if (valueIface) {
        value = clip(String(safe(() => valueIface.get_current_value(), '')));
      }
      const focused = has(el, Atspi.StateType.FOCUSED);
      const enabled = has(el, Atspi.StateType.ENABLED) || has(el, Atspi.StateType.SENSITIVE);
      const actions = actionNames(el);
      // A row with no action of its own is chosen through its list (see pressElement).
      const pressable =
        actions.some((a) => PRESS_ACTIONS.includes(a)) ||
        (['list item', 'table row', 'tree item', 'table cell'].includes(role) && !!safe(() => el.get_parent()?.get_selection_iface()));
      const structure = STRUCTURAL.has(role) && !label && !focused;
      if (!structure && stage && depth > 0) {
        const id = this.nodes.size;
        this.nodes.set(id, el);
        const caps = [];
        if (pressable) caps.push('press');
        if (actions.some((a) => MENU_ACTIONS.includes(a))) caps.push('menu');
        if (editable || (valueIface && !password)) caps.push('setvalue');
        let shown = password ? 'password' : (ROLES[role] ?? role.replace(/\s+/g, ''));
        if (role === 'text' && !editable) shown = 'text';
        let line = `${' '.repeat(Math.min(indent, 12))}${id}  ${shown}`;
        if (label) line += ` "${label}"`;
        if (value && value !== label && shown !== 'text') line += ` = "${value}"`;
        if (focused) line += ' focused';
        if (!enabled) line += ' disabled';
        if (caps.length) line += `  [${caps.join(',')}]`;
        const xy = toPixel({ x: stage.x, y: stage.y });
        line += `  (${xy.x},${xy.y} ${Math.round(stage.width / unitsPerShotPixel)}x${Math.round(stage.height / unitsPerShotPixel)})`;
        lines.push(line);
      }
      if (depth >= maxDepth) return;
      for (const c of children(el)) walk(c, depth + 1, structure ? indent : indent + 1);
    };
    this.nodes.clear();
    this.snapshotTaken = true;
    walk(top, 0, 0);
    // A Chromium window builds its tree on the first question and fills it
    // over a second or two: look again before believing a bare one.
    for (let waited = 0; lines.length < 12 && !truncated && waited < 6; waited++) {
      GLib.usleep(500_000);
      this.nodes.clear();
      lines.length = 0;
      walk(top, 0, 0);
    }
    let head = 'Controls of this window (id  role "label" [what it can do]  (x,y wxh in window pixels)). Ids are valid until the next snapshot.';
    if (truncated) head += ` Only the first ${this.nodes.size} controls are listed; lower \`depth\` or scroll to see others.`;
    if (lines.length === 0) return `${head}\n(none exposed — this window may be a canvas; act on it in screen mode)`;
    return `${head}\n${lines.join('\n')}`;
  }

  node(id) {
    if (!this.snapshotTaken) throw new HelperError('Take a snapshot first; element ids come from it.');
    const el = this.nodes.get(id);
    if (!el) throw new HelperError(`No element ${id} in the last snapshot. Take a new snapshot and use one of its ids.`);
    return el;
  }

  /** The element's own action, or its nearest ancestor's. */
  pressElement(el) {
    let at = el;
    for (let i = 0; i < 4 && at; i++) {
      if (doNamed(at, PRESS_ACTIONS)) return true;
      if (at === this.root) break;
      at = safe(() => at.get_parent());
    }
    // A list or table row is chosen through its container.
    const parent = safe(() => el.get_parent());
    const selection = parent && safe(() => parent.get_selection_iface());
    const index = safe(() => el.get_index_in_parent(), -1);
    if (selection && index >= 0 && safe(() => selection.select_child(index), false)) return true;
    return false;
  }

  press(id) {
    const el = this.node(id);
    if (this.pressElement(el)) return;
    if (FIELDS.has(roleName(el)) && this.focusElement(el)) return;
    throw new HelperError(`press ${id}: this control offers no action. Focus it, or clear the window and click it in screen mode.`);
  }

  focusElement(el) {
    const c = safe(() => el.get_component_iface());
    return !!(c && safe(() => c.grab_focus(), false));
  }

  /**
   * GTK 4 takes no focus through AT-SPI, so a field focused by id is also
   * remembered: typing goes into it even where the toolkit said no.
   */
  focus(id) {
    const el = this.node(id);
    const took = this.focusElement(el);
    const editable = has(el, Atspi.StateType.EDITABLE) && !!safe(() => el.get_editable_text_iface());
    this.chosen = editable ? el : null;
    if (!took && !editable) throw new HelperError(`focus ${id}: the control would not take focus; take a new snapshot.`);
  }

  menu(id) {
    if (!doNamed(this.node(id), MENU_ACTIONS)) {
      throw new HelperError(`menu ${id}: this control has no context menu action. Clear the window and right-click it in screen mode.`);
    }
  }

  setValue(id, text) {
    const el = this.node(id);
    const editable = safe(() => el.get_editable_text_iface());
    if (editable && has(el, Atspi.StateType.EDITABLE)) {
      if (safe(() => editable.set_text_contents(text), false)) return;
    }
    const value = safe(() => el.get_value_iface());
    const n = Number(text);
    if (value && Number.isFinite(n) && safe(() => value.set_current_value(n), false)) return;
    throw new HelperError(`set_value ${id}: this control does not take a value directly. Focus it and use type instead.`);
  }

  /** The deepest control under a stage point, found through the tree (not the screen), so a covered window answers for itself. */
  elementAt(p) {
    let at = this.ensureRoot();
    for (let depth = 0; depth < 40; depth++) {
      let hit = null;
      let best = Infinity;
      for (const c of children(at)) {
        const e = extents(c);
        if (!e || !has(c, Atspi.StateType.SHOWING)) continue;
        const r = this.toStage(e);
        if (p.x < r.x || p.y < r.y || p.x >= r.x + r.width || p.y >= r.y + r.height) continue;
        const area = r.width * r.height;
        if (area < best) {
          best = area;
          hit = c;
        }
      }
      if (!hit) break;
      at = hit;
    }
    return at === this.root ? null : at;
  }

  /** A window-mode click: the control's own action; a field takes focus. */
  click(p, button, count) {
    const el = this.elementAt(p);
    if (!el) throw new HelperError('Nothing Stem can press is at that spot in the window. Take a snapshot, or clear the window and click in screen mode.');
    const role = roleName(el);
    if (button === 'right') {
      if (doNamed(el, MENU_ACTIONS)) return;
      throw new HelperError('That control has no context menu action; right-clicks in a background window need screen mode on Linux.');
    }
    if (FIELDS.has(role) || has(el, Atspi.StateType.EDITABLE)) {
      const took = this.focusElement(el);
      this.chosen = has(el, Atspi.StateType.EDITABLE) ? el : null;
      if (took || this.chosen) return;
    }
    if (this.pressElement(el)) {
      if (count >= 2) this.pressElement(el);
      return;
    }
    if (this.focusElement(el)) return;
    throw new HelperError(`The ${ROLES[role] ?? role} at that spot offers no action Stem can use in window mode. Take a snapshot, or clear the window and click in screen mode.`);
  }

  /** Scroll by the nearest scroll bar's value (page steps), found from the point upward. */
  scroll(p, dir, amount) {
    const vertical = dir === 'up' || dir === 'down';
    let at = this.elementAt(p) ?? this.ensureRoot();
    for (let i = 0; i < 10 && at; i++) {
      for (const c of children(at)) {
        if (roleName(c) !== 'scroll bar') continue;
        const horizontal = has(c, Atspi.StateType.HORIZONTAL);
        if (horizontal === vertical) continue;
        const v = safe(() => c.get_value_iface());
        if (!v) continue;
        const e = extents(c);
        const span = vertical ? (e?.height ?? 400) : (e?.width ?? 400);
        const min = safe(() => v.get_minimum_value(), 0);
        const max = safe(() => v.get_maximum_value(), 0);
        const step = Math.max(safe(() => v.get_minimum_increment(), 0) || 0, (span * 0.15 * Math.max(1, Math.min(amount, 50))));
        const now = safe(() => v.get_current_value(), 0);
        const next = Math.min(max, Math.max(min, now + (dir === 'up' || dir === 'left' ? -step : step)));
        if (safe(() => v.set_current_value(next), false)) return;
      }
      if (at === this.root) break;
      at = safe(() => at.get_parent());
    }
    throw new HelperError('No scrollable area Stem can move is at that spot in the window. Clear the window and scroll in screen mode.');
  }

  /** The control in this window with keyboard focus, or null. */
  focused() {
    const root = this.ensureRoot();
    let found = null;
    let visited = 0;
    const walk = (el, depth) => {
      if (found || depth > 40 || visited++ > 4000) return;
      if (has(el, Atspi.StateType.FOCUSED)) {
        found = el;
        return;
      }
      for (const c of children(el)) {
        if (has(c, Atspi.StateType.SHOWING) || has(c, Atspi.StateType.FOCUSED)) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return found;
  }

  /** Typing into a background window: inserted at the caret of its focused field. */
  type(text) {
    const focused = this.focused();
    const el = focused && has(focused, Atspi.StateType.EDITABLE) ? focused : (this.chosen ?? focused);
    const editable = el && safe(() => el.get_editable_text_iface());
    if (!editable || !has(el, Atspi.StateType.EDITABLE)) {
      throw new HelperError('Nothing in this window that takes text has keyboard focus. Click a field or `focus` its id first, then type.');
    }
    // At the caret when the field has focus; at the end of a remembered one.
    const end = safe(() => Atspi.Text.prototype.get_character_count.call(el), 0) ?? 0;
    const caret = el === focused ? safe(() => Atspi.Text.prototype.get_caret_offset.call(el), -1) ?? -1 : -1;
    const at = caret >= 0 && caret <= end ? caret : end;
    const bytes = new TextEncoder().encode(text).length;
    if (!safe(() => editable.insert_text(at, text, bytes), false)) throw new HelperError('The field would not take the text.');
  }

  /** Return in a background window: the focused control's own activate action. */
  activateFocused() {
    const el = this.focused();
    if (el && doNamed(el, ['activate', 'press', 'click'])) return true;
    return false;
  }
}

/** The window's readable text for "Ask about this window": static text, field values (never passwords), names of links and images. */
export function readableText(win, maxChars) {
  enableToolkits();
  const root = findWindow(win);
  if (!root) return null;
  const parts = [];
  let total = 0;
  let visited = 0;
  const started = Date.now();
  const takeText = (s) => {
    if (!s) return;
    s = String(s).replace(/￼/g, '').trim();
    if (!s || parts[parts.length - 1] === s) return;
    parts.push(s);
    total += s.length + 1;
  };
  const walk = (el, depth) => {
    if (total >= maxChars || depth > 60 || visited > 8000 || Date.now() - started > 6000) return;
    visited++;
    const role = roleName(el);
    if (role === 'password text') return;
    if (depth > 0 && !has(el, Atspi.StateType.SHOWING)) return;
    const kids = children(el);
    const text = kids.length === 0 ? textOf(el, 20000) : null;
    if (text) takeText(text);
    else if (kids.length === 0 && ['label', 'static', 'link', 'list item', 'table cell', 'heading'].includes(role)) takeText(nameOf(el));
    else if (role === 'image' && nameOf(el).trim()) takeText(`[image: ${nameOf(el).trim()}]`);
    for (const c of kids) walk(c, depth + 1);
  };
  walk(root, 0);
  if (parts.length === 0) return null;
  const all = parts.join('\n');
  return all.length > maxChars ? `${all.slice(0, maxChars)}\n…` : all;
}
