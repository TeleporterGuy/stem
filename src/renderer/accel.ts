// Accelerator / keycap formatting shared by the shortcut hints (shortcuts.tsx),
// the settings recorder (SettingsTab), and the HUD pill (StatusHud).
//
// macOS renders compact glyph runs in canonical ⌃⌥⇧⌘ order, collapsing the
// four-modifier hyperkey to a single ✦. Everywhere else renders plus-joined
// text ('Ctrl+Alt+J', Command → 'Super') — glyphs and the hyper idiom are
// mac-specific. The formatting functions take `mac` explicitly so both
// branches are unit-testable; IS_MAC is the renderer's ambient value.

/** Whether this renderer runs on macOS (guarded for test environments without the bridge). */
export const IS_MAC = typeof window !== 'undefined' && window.stem?.platform === 'darwin';

/** Canonical macOS modifier order (⌃⌥⇧⌘), also used to sort the text form. */
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command'];
const MAC_GLYPH: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
const TEXT_LABEL: Record<string, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Super' };

export interface AcceleratorParts {
  /** Modifier tokens present, in canonical order. */
  mods: string[];
  /** Non-modifier key tokens. */
  keys: string[];
  /** All four modifiers held — the (mac) hyperkey. */
  isHyper: boolean;
}

/** Split an Electron accelerator ('Control+Alt+J') into ordered modifiers + keys. */
export function splitAccelerator(accel: string): AcceleratorParts {
  const parts = accel.split('+');
  const mods = parts
    .filter((p) => MOD_ORDER.includes(p))
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const keys = parts.filter((p) => !MOD_ORDER.includes(p));
  return { mods, keys, isHyper: MOD_ORDER.every((m) => mods.includes(m)) };
}

/**
 * Render an Electron accelerator for display: mac → compact glyphs ('⌥Space',
 * hyper '✦J'); elsewhere → plus-joined text ('Alt+Space', 'Ctrl+Shift+X').
 */
export function formatAccelerator(accel: string, mac: boolean = IS_MAC): string {
  const { mods, keys, isHyper } = splitAccelerator(accel);
  if (mac) {
    const modStr = isHyper ? '✦' : mods.map((m) => MAC_GLYPH[m]).join('');
    return modStr + keys.join('');
  }
  return [...mods.map((m) => TEXT_LABEL[m]), ...keys].join('+');
}
