// Screen-mode input: the extension's virtual pointer and keyboard, which the
// compositor treats like real devices (the window under the pointer gets the
// click, the focused one the keys).

import GLib from 'gi://GLib';
import * as shell from './shell.js';
import { HelperError } from './errors.js';
import { KEY, charKeysym, parseCombo } from './keys.js';

const BUTTONS = { left: 1, middle: 2, right: 3 };

export const pause = (ms) =>
  new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, ms), () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    })
  );

export class Input {
  constructor(capture) {
    this.capture = capture;
  }

  async pointer() {
    const p = await shell.call('pointer');
    return { x: p.x, y: p.y };
  }

  async cursorInScreenshot() {
    return this.capture.toPixel(await this.pointer());
  }

  async at(x, y) {
    if (x !== undefined && x !== null && y !== undefined && y !== null) return this.capture.toPoint(x, y);
    if ((x === undefined || x === null) && (y === undefined || y === null)) return this.pointer();
    throw new HelperError('Give both x and y.');
  }

  moveTo(p) {
    return shell.call('motion', { x: p.x, y: p.y });
  }

  async move(x, y) {
    await this.moveTo(await this.at(x, y));
  }

  async click(x, y, button = 'left', count = 1) {
    const b = BUTTONS[button];
    if (!b) throw new HelperError('button must be left, right or middle.');
    await this.moveTo(await this.at(x, y));
    await pause(30);
    const clicks = Math.max(1, Math.min(count, 3));
    for (let n = 1; n <= clicks; n++) {
      await shell.call('button', { button: b, press: true });
      await pause(20);
      await shell.call('button', { button: b, press: false });
      if (n < clicks) await pause(60);
    }
  }

  async drag(from, to) {
    if (!from || !to || [from.x, from.y, to.x, to.y].some((n) => typeof n !== 'number')) throw new HelperError('A drag needs from {x,y} and to {x,y}.');
    const a = this.capture.toPoint(from.x, from.y);
    const b = this.capture.toPoint(to.x, to.y);
    await this.moveTo(a);
    await pause(40);
    await shell.call('button', { button: 1, press: true });
    await pause(80);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.moveTo({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      await pause(20);
    }
    await pause(60);
    await shell.call('button', { button: 1, press: false });
  }

  async scroll(x, y, dir, amount) {
    if (!['up', 'down', 'left', 'right'].includes(dir)) throw new HelperError('scroll direction must be up, down, left or right.');
    await this.moveTo(await this.at(x, y));
    await pause(30);
    await shell.call('scroll', { dir, steps: Math.max(1, Math.min(amount, 50)) });
  }

  async key(keysym, press) {
    await shell.call('keyval', { keyval: keysym, press });
  }

  /**
   * Plain ASCII goes as key presses, like a person typing. Anything else (č,
   * emoji) may have no key on the layout, and the compositor drops a keysym it
   * cannot place, so it goes through the input method instead, which takes
   * any character. A field without input-method support (an X11 app) gets the
   * key presses anyway. Returns a note when some characters may not have
   * arrived.
   */
  async type(text) {
    if (!text) throw new HelperError('Nothing to type.');
    const runs = text.match(/[\x20-\x7e\n\r\t]+|[^\x20-\x7e\n\r\t]+/g) ?? [];
    let unsure = '';
    for (const run of runs) {
      if (/^[^\x20-\x7e\n\r\t]/.test(run)) {
        const r = await shell.call('commit', { text: run });
        if (r.committed) {
          await pause(30);
          continue;
        }
        unsure += run;
      }
      for (const ch of run) {
        const k = charKeysym(ch);
        await this.key(k, true);
        await this.key(k, false);
        await pause(8);
      }
    }
    return unsure
      ? `The focused app takes no input-method text, so "${unsure}" went as key presses; characters missing from the keyboard layout are dropped. Check the screenshot.`
      : null;
  }

  async hold(combo, ms) {
    const parsed = parseCombo(combo);
    ms = Math.max(30, Math.min(ms || 0, 5000));
    try {
      for (const m of parsed.modifiers) await this.key(m, true);
      await this.key(parsed.keysym, true);
      await pause(ms);
      await this.key(parsed.keysym, false);
    } finally {
      for (const m of [...parsed.modifiers].reverse()) await this.key(m, false).catch(() => undefined);
    }
  }

  pressKey(combo) {
    return this.hold(combo, 30);
  }
}

export { KEY };
