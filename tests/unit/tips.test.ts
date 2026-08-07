import { describe, expect, it } from 'vitest';
import type { ModelSummary } from '../../src/shared/types';
import { TIPS, eligibleTips, tipAt, tipGlyphs, type TipContext } from '../../src/renderer/chat/tips';

const model = (over: Partial<ModelSummary> = {}): ModelSummary =>
  ({
    id: 'anthropic/opus',
    displayName: 'Opus',
    description: '',
    provider: 'anthropic',
    providerName: 'Claude',
    supportedEfforts: ['low', 'high'],
    defaultEffort: 'high',
    serviceTiers: [{ id: 'priority' }],
    ...over
  }) as ModelSummary;

const ctx = (over: Partial<TipContext> = {}): TipContext => ({
  format: 'mdx',
  model: model(),
  bound: true,
  ...over
});

const ids = (c: TipContext) => eligibleTips(c).map((t) => t.id);

describe('eligibleTips', () => {
  it('offers the whole deck when every capability is present', () => {
    expect(ids(ctx())).toEqual(TIPS.map((t) => t.id));
  });

  it('drops every key-related tip where no shortcut is bound (Quick Chat)', () => {
    const kept = ids(ctx({ bound: false }));
    expect(kept).not.toContain('hint-mode');
    expect(kept).not.toContain('attach');
    expect(kept).not.toContain('learn');
    // Tips that hold on their own still show — the surface isn't left tipless.
    expect(kept).toContain('note');
    expect(kept.length).toBeGreaterThan(0);
  });

  it('hides tips for controls this model does not have', () => {
    expect(ids(ctx({ model: model({ serviceTiers: [] }) }))).not.toContain('speed');
    expect(ids(ctx({ model: model({ supportedEfforts: [] }) }))).not.toContain('effort');
    expect(ids(ctx({ model: null }))).toEqual(expect.not.arrayContaining(['speed', 'effort']));
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

describe('tipGlyphs', () => {
  it('resolves a bound shortcut to its platform keycap', () => {
    const attach = TIPS.find((t) => t.id === 'attach')!;
    // Tests run outside Electron, so accel's IS_MAC is false → the Ctrl form.
    expect(tipGlyphs(attach)).toBe('Ctrl+U');
  });

  it('passes literal keys through and yields null for prose-only tips', () => {
    expect(tipGlyphs(TIPS.find((t) => t.id === 'hint-mode')!)).toBe('Ctrl');
    expect(tipGlyphs(TIPS.find((t) => t.id === 'note')!)).toBeNull();
  });
});
