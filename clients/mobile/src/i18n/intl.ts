/** ADR-0213: inspect before loading; no formatter/service may precede this boundary. */
export type IntlPolyfill = 'locale' | 'pluralRules' | 'relativeTimeFormat';
export type IntlPolyfillLoader = (polyfill: IntlPolyfill) => void;
const CATALOG_LOCALES = ['en-US', 'ko-KR'] as const;
const COUNTS = [0, 1, 2, 1.5, 1_000_000];

function supportsLocale(): boolean {
  try {
    return new Intl.Locale('ko-KR').baseName === 'ko-KR'
      && new Intl.Locale('en-US').maximize().toString() === 'en-Latn-US';
  }
  catch { return false; }
}
function supportsPluralRules(): boolean {
  try {
    return CATALOG_LOCALES.every(locale => Intl.PluralRules.supportedLocalesOf([locale]).length === 1
      && COUNTS.every(count => new Intl.PluralRules(locale).select(count) === (locale === 'en-US' && count === 1 ? 'one' : 'other')));
  } catch { return false; }
}
/**
 * Measured, not merely present: plural category, `numeric: 'auto'` data and the engine's NumberFormat
 * (for the polyfill: through NumberFormat.formatToParts when the engine registers it, through format()
 * otherwise) must all produce the CLDR text. Small integers only, so no grouping/OS number-format
 * detail can block boot.
 */
const RELATIVE_CASES: Record<(typeof CATALOG_LOCALES)[number], ReadonlyArray<readonly ['always' | 'auto', number, string]>> = {
  'en-US': [['always', 1, 'in 1 day'], ['always', 2, 'in 2 days'], ['auto', -1, 'yesterday']],
  'ko-KR': [['always', 1, '1일 후'], ['always', 2, '2일 후'], ['auto', -1, '어제']],
};
function supportsRelativeTimeFormat(): boolean {
  try {
    return CATALOG_LOCALES.every(locale => Intl.RelativeTimeFormat.supportedLocalesOf([locale]).length === 1
      && RELATIVE_CASES[locale].every(([numeric, value, text]) => new Intl.RelativeTimeFormat(locale, {numeric}).format(value, 'day') === text));
  } catch { return false; }
}

/** Static, bounded require paths let Metro bundle only ko/en locale-data packs. */
const loadPolyfill: IntlPolyfillLoader = polyfill => {
  switch (polyfill) {
    case 'locale':
      require('@formatjs/intl-locale/polyfill-force.js');
      break;
    case 'pluralRules':
      require('@formatjs/intl-pluralrules/polyfill-force.js');
      require('@formatjs/intl-pluralrules/locale-data/en.js');
      require('@formatjs/intl-pluralrules/locale-data/ko.js');
      break;
    case 'relativeTimeFormat':
      require('@formatjs/intl-relativetimeformat/polyfill-force.js');
      require('@formatjs/intl-relativetimeformat/locale-data/en.js');
      require('@formatjs/intl-relativetimeformat/locale-data/ko.js');
      break;
  }
};

export function initializeMobileIntl(load: IntlPolyfillLoader = loadPolyfill): void {
  // hermes-v250829098.0.16 natively has getCanonicalLocales, DateTimeFormat (+parts), Collator and
  // NumberFormat.format. It has no Locale/PluralRules/RelativeTimeFormat, and on Apple it registers no
  // NumberFormat.prototype.formatToParts either (Intl.cpp `#ifndef __APPLE__`; verified by executing the
  // locked engine, see README). The RTF polyfill then uses NumberFormat.format(); no NumberFormat polyfill
  // is needed. On an engine that registers formatToParts, the RTF polyfill calls it and the post-load RTF
  // check below measures that call, so a registered-but-broken method fails closed instead of being skipped.
  if (typeof Intl.getCanonicalLocales !== 'function'
    || Intl.getCanonicalLocales('ko-kr')[0] !== 'ko-KR') throw new Error('intl-canonical-locales-unavailable');
  for (const locale of CATALOG_LOCALES) {
    if (Intl.DateTimeFormat.supportedLocalesOf([locale]).length !== 1
      || Intl.NumberFormat.supportedLocalesOf([locale]).length !== 1
      || Intl.Collator.supportedLocalesOf([locale]).length !== 1) throw new Error('intl-native-locale-unavailable');
    if (!new Intl.DateTimeFormat(locale, {timeZone: 'UTC'}).formatToParts(0).some(part => part.type === 'year' && part.value === '1970')
      || !new Intl.NumberFormat(locale).format(12345.67).length
      || !(new Intl.Collator(locale).compare('a', 'b') < 0)) throw new Error('intl-native-format-unavailable');
  }
  // Order matters: PluralRules must exist before an RTF instance is constructed.
  if (!supportsLocale()) load('locale');
  if (!supportsPluralRules()) load('pluralRules');
  if (!supportsRelativeTimeFormat()) load('relativeTimeFormat');
  if (!supportsLocale() || !supportsPluralRules() || !supportsRelativeTimeFormat()) {
    throw new Error('intl-polyfill-initialization-failed');
  }
}
