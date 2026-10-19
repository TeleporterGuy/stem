// Pictures of the primary monitor, or of the selected window alone, taken by
// the extension and downscaled here, plus the geometry that turns screenshot
// pixels back into stage coordinates (GNOME's logical pixels, what the virtual
// pointer takes). The same contract as the Mac and Windows helpers.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as shell from './shell.js';
import { HelperError } from './errors.js';

/** Longest side of a frame handed to the model (Anthropic's computer-use guidance). */
const MAX_SIDE = 1568;

/** Loads the extension's PNG and deletes it. */
function take(path) {
  try {
    return GdkPixbuf.Pixbuf.new_from_file(path);
  } finally {
    try {
      Gio.File.new_for_path(path).delete(null);
    } catch {
      // Already gone.
    }
  }
}

/** Scaled into an opaque frame: the JPEG encoder takes no alpha channel. */
function jpeg(pixbuf, width, height) {
  const opaque = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
  opaque.fill(0xffffffff);
  pixbuf.composite(opaque, 0, 0, width, height, 0, 0, width / pixbuf.get_width(), height / pixbuf.get_height(), GdkPixbuf.InterpType.BILINEAR, 255);
  const [, bytes] = opaque.save_to_bufferv('jpeg', ['quality'], ['80']);
  return GLib.base64_encode(bytes);
}

export class Capture {
  constructor() {
    /** { id, app, title, pid } of the selected window, or null for the screen. */
    this._target = null;
    this.reset();
  }

  reset() {
    this.lastWidth = 0;
    this.lastHeight = 0;
    /** Stage units per screenshot pixel. */
    this.unitsPerShotPixel = 1;
    this.origin = { x: 0, y: 0 };
  }

  get target() {
    return this._target;
  }

  set target(value) {
    const changed = (this._target === null) !== (value === null) || (this._target && value && this._target.id !== value.id);
    this._target = value;
    if (changed) this.reset();
  }

  /** The full-resolution picture and the stage rectangle it covers. */
  async grab() {
    if (!this._target) {
      const r = await shell.call('shot');
      return { pixbuf: take(r.path), area: r.area };
    }
    let r;
    try {
      r = await shell.call('shot', { window: this._target.id });
    } catch (e) {
      if (e instanceof HelperError && e.message === 'minimized') {
        throw new HelperError(`${this._target.app}'s window is minimized, and GNOME draws nothing for a minimized window. Ask the user to restore it (it can stay behind other windows), or clear the window and use the screen.`);
      }
      if (e instanceof HelperError && /^No window/.test(e.message)) {
        throw new HelperError('The selected window has closed (an action that closed it went through). Run list_windows and select again.');
      }
      throw e;
    }
    return { pixbuf: take(r.path), area: r.area };
  }

  async screenshot() {
    const { pixbuf, area } = await this.grab();
    const longest = Math.max(pixbuf.get_width(), pixbuf.get_height());
    const factor = longest > MAX_SIDE ? MAX_SIDE / longest : 1;
    const width = Math.max(1, Math.round(pixbuf.get_width() * factor));
    const height = Math.max(1, Math.round(pixbuf.get_height() * factor));
    this.lastWidth = width;
    this.lastHeight = height;
    this.unitsPerShotPixel = area.width / width;
    this.origin = { x: area.x, y: area.y };
    this.area = area;
    // `scale`: screen pixels per screenshot pixel, as the other helpers report it.
    return { jpegBase64: jpeg(pixbuf, width, height), width, height, scale: pixbuf.get_width() / width };
  }

  async zoom(x, y, w, h) {
    if (this.lastWidth <= 0) throw new HelperError('Take a screenshot before zooming.');
    if (!(w >= 1 && h >= 1)) throw new HelperError('The zoom region needs a positive width and height.');
    const { pixbuf } = await this.grab();
    const toFull = pixbuf.get_width() / this.lastWidth;
    const left = Math.max(0, Math.floor(x * toFull));
    const top = Math.max(0, Math.floor(y * toFull));
    const right = Math.min(pixbuf.get_width(), Math.round((x + w) * toFull));
    const bottom = Math.min(pixbuf.get_height(), Math.round((y + h) * toFull));
    if (right - left < 1 || bottom - top < 1) throw new HelperError('The zoom region lies outside the screen.');
    const cropped = pixbuf.new_subpixbuf(left, top, right - left, bottom - top);
    const factor = MAX_SIDE / Math.max(cropped.get_width(), cropped.get_height());
    const width = Math.max(1, Math.round(cropped.get_width() * factor));
    const height = Math.max(1, Math.round(cropped.get_height() * factor));
    return { jpegBase64: jpeg(cropped, width, height), width, height, zoomed: true };
  }

  /** Screenshot pixels → stage coordinates. */
  toPoint(x, y) {
    if (this.lastWidth <= 0) throw new HelperError('Take a screenshot before pointing at it.');
    const px = Math.min(Math.max(x, 0), this.lastWidth - 1);
    const py = Math.min(Math.max(y, 0), this.lastHeight - 1);
    return { x: this.origin.x + px * this.unitsPerShotPixel, y: this.origin.y + py * this.unitsPerShotPixel };
  }

  /** Stage coordinates → screenshot pixels. */
  toPixel(p) {
    if (this.lastWidth <= 0) return { x: Math.round(p.x), y: Math.round(p.y) };
    return { x: Math.round((p.x - this.origin.x) / this.unitsPerShotPixel), y: Math.round((p.y - this.origin.y) / this.unitsPerShotPixel) };
  }
}
