import { describe, expect, it } from 'vitest';
import { TIPS, eligibleTips, tipAt, type TipContext } from '../../src/renderer/chat/tips';

const ctx = (over: Partial<TipContext> = {}): TipContext => ({
  format: 'mdx',
  bound: true,
  ...over
});

const ids = (c: TipContext) => eligibleTips(c).map((t) => t.id);

describe('eligibleTips', () => {
  it('offers the whole deck when every capability is present', () => {
    expect(ids(ctx())).toEqual(TIPS.map((t) => t.id));
  });

  it('drops the tips that need a bound shortcut (Quick Chat)', () => {
    const kept = ids(ctx({ bound: false }));
    expect(kept).toEqual(expect.not.arrayContaining(['hint-mode', 'learn', 'context-meter']));
    // Feature tips hold on their own, so Quick Chat isn't left tipless.
    expect(kept).toContain('note');
    expect(kept).toContain('memory-facts');
    expect(kept.length).toBeGreaterThan(TIPS.length / 2);
  });

  it('hides the rich-reply tip in Markdown mode, where it cannot happen', () => {
    expect(ids(ctx({ format: 'md' }))).not.toContain('rich-replies');
    expect(ids(ctx({ format: 'mdx' }))).toContain('rich-replies');
  });
});

describe('tipAt', () => {
  it('walks the whole deck before repeating any tip', () => {
    const c = ctx();
    const n = eligibleTips(c).length;
    const seen = Array.from({ length: n }, (_, i) => tipAt(i, c)?.id);
    expect(new Set(seen).size).toBe(n);
    expect(tipAt(n, c)?.id).toBe(seen[0]);
  });

  it('steps within the filtered deck, never onto a hidden tip', () => {
    const c = ctx({ bound: false, format: 'md' });
    const shown = new Set(
      Array.from({ length: TIPS.length * 2 }, (_, i) => tipAt(i, c)?.id)
    );
    expect([...shown]).toEqual(expect.arrayContaining(ids(c)));
    expect(shown.size).toBe(eligibleTips(c).length);
  });

  it('survives a junk stored counter instead of blanking the screen', () => {
    const c = ctx();
    expect(tipAt(-3, c)?.id).toBe(tipAt(eligibleTips(c).length - 3, c)?.id);
    expect(tipAt(1.7, c)?.id).toBe(tipAt(1, c)?.id);
    expect(tipAt(Number.NaN, c)?.id).toBe(tipAt(0, c)?.id);
  });

  it('returns null only when nothing is eligible', () => {
    expect(tipAt(0, ctx())).not.toBeNull();
  });
});

describe('the deck', () => {
  it('is a feature deck: only hint-mode talks about keys', () => {
    const keyish = /⌘|⌥|⇧|⏎|\bCtrl\b|\bAlt\b|\bShift\b|\bEnter\b|\bpress\b/i;
    for (const tip of TIPS) {
      if (tip.id === 'hint-mode') continue;
      expect(tip.text, `tip "${tip.id}" names a key`).not.toMatch(keyish);
      expect(tip.keys, `tip "${tip.id}" carries a keycap`).toBeUndefined();
    }
  });

  it('has unique ids and one crisp sentence each', () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
    for (const tip of TIPS) {
      expect(tip.text.length, tip.id).toBeLessThan(130);
      expect(tip.text, tip.id).not.toMatch(/!/);
    }
  });
});
