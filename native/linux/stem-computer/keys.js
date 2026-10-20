// xdotool-style key names → X keysyms, which is what the compositor's virtual
// keyboard takes (it finds, or reserves, a key for each). Modifiers: ctrl,
// alt, shift, super. cmd/command mean Ctrl here: a model used to a Mac says
// cmd+c for copy, and Ctrl is what does that on Linux.

import { HelperError } from './errors.js';

export const KEY = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  alt: 0xffe9,
  super: 0xffeb,
  return: 0xff0d,
  tab: 0xff09
};

const NAMED = {
  return: 0xff0d, enter: 0xff0d, kp_enter: 0xff8d, tab: 0xff09, space: 0x20,
  delete: 0xffff, backspace: 0xff08, escape: 0xff1b, esc: 0xff1b,
  up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53,
  home: 0xff50, end: 0xff57, page_up: 0xff55, pageup: 0xff55, page_down: 0xff56, pagedown: 0xff56,
  insert: 0xff63, caps_lock: 0xffe5, menu: 0xff67, print: 0xff61,
  minus: 0x2d, equal: 0x3d, plus: 0x2b, bracketleft: 0x5b, bracketright: 0x5d,
  semicolon: 0x3b, apostrophe: 0x27, quote: 0x27, grave: 0x60, backslash: 0x5c,
  comma: 0x2c, period: 0x2e, slash: 0x2f
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbd + i;

export function modifier(name) {
  switch (name.toLowerCase()) {
    case 'ctrl': case 'control': case 'cmd': case 'command': return KEY.ctrl;
    case 'alt': case 'option': case 'opt': return KEY.alt;
    case 'shift': return KEY.shift;
    case 'super': case 'win': case 'meta': case 'windows': return KEY.super;
    default: return null;
  }
}

/** The keysym for one character, as X numbers them (Latin-1 as is, the rest at 0x1000000 + code point). */
export function charKeysym(ch) {
  const cp = ch.codePointAt(0);
  if (ch === '\n' || ch === '\r') return KEY.return;
  if (ch === '\t') return KEY.tab;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x1000000 + cp;
}

/** "ctrl+shift+t" → { keysym, modifiers }. */
export function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim());
  const last = parts[parts.length - 1];
  if (!last) throw new HelperError('Name a key, e.g. "Return" or "ctrl+shift+t".');
  const modifiers = parts.slice(0, -1).map((p) => {
    const m = modifier(p);
    if (m === null) throw new HelperError(`Unknown modifier "${p}" (use ctrl, alt, shift, super).`);
    return m;
  });
  const named = NAMED[last.toLowerCase()];
  if (named !== undefined) return { keysym: named, modifiers };
  const lone = modifier(last);
  if (lone !== null && modifiers.length === 0) return { keysym: lone, modifiers };
  if ([...last].length === 1) {
    // A shortcut names the key, not the character: ctrl+C is ctrl+c.
    const ch = modifiers.length > 0 ? last.toLowerCase() : last;
    return { keysym: charKeysym(ch), modifiers };
  }
  throw new HelperError(`Unknown key "${last}".`);
}
