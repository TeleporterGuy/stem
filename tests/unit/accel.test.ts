import { describe, expect, it } from 'vitest';
import { formatAccelerator, splitAccelerator } from '../../src/renderer/accel';

describe('splitAccelerator', () => {
  it('orders modifiers canonically and separates keys', () => {
    expect(splitAccelerator('Alt+Control+J')).toEqual({
      mods: ['Control', 'Alt'],
      keys: ['J'],
      isHyper: false
    });
  });

  it('detects the four-modifier hyperkey', () => {
    expect(splitAccelerator('Command+Control+Alt+Shift+K').isHyper).toBe(true);
    expect(splitAccelerator('Control+Alt+Shift+K').isHyper).toBe(false);
  });
});

describe('formatAccelerator (mac)', () => {
  it('renders compact glyphs in ⌃⌥⇧⌘ order', () => {
    expect(formatAccelerator('Alt+Space', true)).toBe('⌥Space');
    expect(formatAccelerator('Shift+Command+F', true)).toBe('⇧⌘F');
    expect(formatAccelerator('Control+Alt+J', true)).toBe('⌃⌥J');
  });

  it('collapses the hyperkey to ✦', () => {
    expect(formatAccelerator('Command+Control+Alt+Shift+K', true)).toBe('✦K');
  });
});

describe('formatAccelerator (non-mac)', () => {
  it('renders plus-joined text with Ctrl/Super labels', () => {
    expect(formatAccelerator('Alt+Space', false)).toBe('Alt+Space');
    expect(formatAccelerator('Shift+Command+F', false)).toBe('Shift+Super+F');
    expect(formatAccelerator('Control+Alt+J', false)).toBe('Ctrl+Alt+J');
  });

  it('does not collapse the hyperkey (a mac idiom)', () => {
    expect(formatAccelerator('Command+Control+Alt+Shift+K', false)).toBe('Ctrl+Alt+Shift+Super+K');
  });
});
