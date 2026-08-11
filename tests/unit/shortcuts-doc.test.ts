import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DOC_PATH, GEN_SCRIPT, renderShortcutsDoc } from '../../scripts/gen-shortcuts-doc.mjs';
import { SHORTCUTS, keycapFor } from '../../src/shared/shortcut-defs';

// docs/user/shortcuts.md is generated, and generated files rot silently: someone
// rebinds a key, ships it, and the page keeps promising the old one to every reader
// — including the in-app assistant, which answers shortcut questions from this file.
// So the check is not "does the page look right" but "is it exactly what the
// generator produces today".

const onDisk = () => readFileSync(DOC_PATH, 'utf8');

describe('docs/user/shortcuts.md', () => {
  it('matches what the generator produces', () => {
    expect(
      onDisk(),
      `docs/user/shortcuts.md is stale — regenerate it with \`${GEN_SCRIPT}\``
    ).toBe(renderShortcutsDoc());
  });

  it('regenerates byte-for-byte, so the check above can never flap', () => {
    expect(renderShortcutsDoc()).toBe(renderShortcutsDoc());
  });

  it('lists every shortcut with both platform keycaps', () => {
    const page = onDisk();
    for (const def of SHORTCUTS) {
      // The generator escapes backslashes for the Markdown table (⌘\ → ⌘\\), so
      // compare against the escaped form rather than the raw keycap.
      const escaped = (s: string) => s.replace(/\\/g, '\\\\');
      expect(page).toContain(def.label);
      expect(page).toContain(escaped(keycapFor(def, true)));
      expect(page).toContain(escaped(keycapFor(def, false)));
    }
  });

  it('keeps the heading and back-link its sibling pages use', () => {
    const page = onDisk();
    expect(page.startsWith('# Shortcuts & tricks\n')).toBe(true);
    expect(page).toContain('← [Stem guide](../README.md)');
  });
});
