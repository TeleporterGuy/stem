/**
 * Clock format the OS asks for, handed to every renderer window. Chromium's
 * Intl formats with the app locale ("en-US") and ignores the macOS region, so
 * English on a Slovak region renders "09:50 PM" where the menu bar says 21:50.
 * The system locale keeps the region as `@rg=skzzzz`; folding it into the tag
 * ("en-SK") gives Intl the region's 24-hour clock.
 */
export interface TimeLocale {
  locale?: string;
  hourCycle?: 'h12' | 'h23';
}

export const TIME_LOCALE_ARG = '--stem-time-locale=';
export const HOUR_CYCLE_ARG = '--stem-hour-cycle=';

export function resolveTimeLocale(systemLocale: string, force24 = false, force12 = false): TimeLocale {
  const [base, ext = ''] = systemLocale.replace(/_/g, '-').split('@');
  const region = /(?:^|;)rg=([a-z]{2})/i.exec(ext)?.[1]?.toUpperCase();
  const tag = region ? `${base.split('-')[0]}-${region}` : base;
  let locale: string | undefined;
  try {
    locale = Intl.getCanonicalLocales(tag)[0];
  } catch {
    locale = undefined;
  }
  const hourCycle = force24 ? 'h23' : force12 ? 'h12' : undefined;
  return { ...(locale ? { locale } : {}), ...(hourCycle ? { hourCycle } : {}) };
}

export function timeLocaleArgs(t: TimeLocale): string[] {
  return [
    ...(t.locale ? [TIME_LOCALE_ARG + t.locale] : []),
    ...(t.hourCycle ? [HOUR_CYCLE_ARG + t.hourCycle] : [])
  ];
}

export function parseTimeLocaleArgs(argv: readonly string[]): TimeLocale {
  const locale = argv.find((a) => a.startsWith(TIME_LOCALE_ARG))?.slice(TIME_LOCALE_ARG.length);
  const cycle = argv.find((a) => a.startsWith(HOUR_CYCLE_ARG))?.slice(HOUR_CYCLE_ARG.length);
  const hourCycle = cycle === 'h12' || cycle === 'h23' ? cycle : undefined;
  return { ...(locale ? { locale } : {}), ...(hourCycle ? { hourCycle } : {}) };
}
