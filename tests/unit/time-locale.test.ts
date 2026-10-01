import { describe, expect, it } from 'vitest';
import { parseTimeLocaleArgs, resolveTimeLocale, timeLocaleArgs } from '../../src/shared/time-locale';

const at2150 = new Date(2026, 9, 1, 21, 50);
const clock = (t: ReturnType<typeof resolveTimeLocale>): string =>
  new Intl.DateTimeFormat(t.locale, { hour: '2-digit', minute: '2-digit', ...(t.hourCycle ? { hourCycle: t.hourCycle } : {}) }).format(at2150);

describe('resolveTimeLocale', () => {
  it('folds the macOS region into the tag so English on a Slovak region gets 24-hour time', () => {
    const t = resolveTimeLocale('en-US@rg=skzzzz');
    expect(t).toEqual({ locale: 'en-SK' });
    expect(clock(t)).toBe('21:50');
  });

  it('keeps a plain locale as it is', () => {
    expect(resolveTimeLocale('en_GB')).toEqual({ locale: 'en-GB' });
    expect(clock(resolveTimeLocale('en-US'))).toMatch(/pm/i);
  });

  it('lets the macOS 12/24-hour switch override the region', () => {
    expect(clock(resolveTimeLocale('en-US', true))).toBe('21:50');
    expect(clock(resolveTimeLocale('en-US@rg=skzzzz', false, true))).toMatch(/pm/i);
  });

  it('drops a locale Intl rejects', () => {
    expect(resolveTimeLocale('')).toEqual({});
  });

  it('round-trips through the preload arguments', () => {
    const t = { locale: 'en-SK', hourCycle: 'h23' as const };
    expect(parseTimeLocaleArgs(['electron', ...timeLocaleArgs(t), '--other'])).toEqual(t);
    expect(parseTimeLocaleArgs(['--stem-hour-cycle=bogus'])).toEqual({});
  });
});
