/** ADR-0213 message IDs; catalog availability is a separate, staged rollout. */
export const supportedLocales = ['ko-KR', 'en-US', 'ja-JP', 'zh-Hans', 'zh-Hant', 'es-419', 'fr-FR'] as const;
export type SupportedLocale = typeof supportedLocales[number];
export type LocalePreference = 'system' | SupportedLocale;
/** ISO weekday: Monday=1 through Sunday=7. */
export type WeekStartsOn = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type HourCycle = 'h11' | 'h12' | 'h23' | 'h24';

/** P0-3/4 pass this immutable snapshot after loading the selected catalog. */
export interface LocaleContext {
  readonly messageLocale: string;
  readonly formatLocale: string;
  readonly timeZone: string;
  readonly hourCycle: HourCycle;
  readonly weekStartsOn: WeekStartsOn;
}

export interface DeviceLocaleFacts {
  readonly languages: readonly string[];
  readonly timeZone?: string;
  /** Regional setting when the host exposes it independently of language. */
  readonly region?: string;
  readonly weekStartsOn?: number;
  readonly hourCycle?: HourCycle;
}

/** Canonicalize each entry separately so one malformed OS tag cannot hide later choices. */
function canonical(tag: string): string | undefined {
  try { return Intl.getCanonicalLocales(tag)[0]; } catch { return undefined; }
}

function regionOf(tag: string): string | undefined {
  // Ignore extensions/private use: en-u-rg-gbzzzz must not become region GB.
  return tag.split(/-[0-9A-Za-z]-/)[0].split('-').slice(1)
    .find(part => /^[A-Z]{2}$|^\d{3}$/.test(part));
}

function match(tag: string): SupportedLocale | undefined {
  const language = tag.split('-')[0];
  switch (language) {
    case 'ko': return 'ko-KR';
    case 'en': return 'en-US';
    case 'ja': return 'ja-JP';
    case 'es': return 'es-419';
    case 'fr': return 'fr-FR';
    case 'zh': {
      const script = tag.split('-')[1];
      if (script === 'Hans') return 'zh-Hans';
      if (script === 'Hant') return 'zh-Hant';
      return ['TW', 'HK', 'MO'].includes(regionOf(tag) ?? '') ? 'zh-Hant' : 'zh-Hans';
    }
    default: return undefined;
  }
}

/** P0-3/4 use this for OS-order matching, independent of catalog rollout. */
export function matchDeviceLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const tag = canonical(language);
    const locale = tag && match(tag);
    if (locale) return locale;
  }
  return 'en-US';
}

/** Stored choices are closed IDs, never arbitrary OS tags or account preferences. */
export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || supportedLocales.some(locale => locale === value);
}

// CLDR release-49 supplementalData.xml/weekData, excluding alt="variant".
// https://github.com/unicode-org/cldr/blob/release-49/common/supplemental/supplementalData.xml
const SUNDAY = new Set('AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN IS JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(' '));
const SATURDAY = new Set('AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));

/** Pinned regional defaults, without Intl.Locale/weekInfo (absent on Hermes). */
export function weekStartForRegion(region: string): WeekStartsOn {
  const code = region.toUpperCase();
  if (code === 'MV') return 5;
  if (SATURDAY.has(code)) return 6;
  return SUNDAY.has(code) ? 7 : 1;
}

/** Valid named IANA zone only; numeric offsets are not this preference contract. */
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

const DEFAULT_REGION: Record<SupportedLocale, string> = {
  'ko-KR': 'KR', 'en-US': 'US', 'ja-JP': 'JP', 'zh-Hans': 'CN', 'zh-Hant': 'TW', 'es-419': '419', 'fr-FR': 'FR',
};

/** P0-3/4 resolve boot/resume facts; explicitTimeZone must represent an actual user choice. */
export function resolveLocaleContext(
  preference: LocalePreference, device: DeviceLocaleFacts, explicitTimeZone?: string,
): LocaleContext {
  const tags = device.languages.map(canonical).filter((tag): tag is string => Boolean(tag));
  const messageLocale = preference === 'system' ? matchDeviceLocale(tags) : preference;
  const selectedTag = tags.find(tag => match(tag) === messageLocale);
  const deviceRegion = device.region && /^[A-Za-z]{2}$|^\d{3}$/.test(device.region)
    ? device.region.toUpperCase() : undefined;
  const region = deviceRegion ?? regionOf(selectedTag ?? tags[0] ?? '') ?? DEFAULT_REGION[messageLocale];
  const language = messageLocale.startsWith('zh-') ? messageLocale : messageLocale.split('-')[0];
  const formatLocale = `${language}-${region}`;
  const timeZone = validTimeZone(explicitTimeZone) ? explicitTimeZone
    : validTimeZone(device.timeZone) ? device.timeZone : 'UTC';
  let hourCycle = device.hourCycle;
  if (!['h11', 'h12', 'h23', 'h24'].includes(hourCycle ?? '')) {
    try { hourCycle = new Intl.DateTimeFormat(formatLocale, { hour: 'numeric', timeZone }).resolvedOptions().hourCycle; }
    catch { /* P0-4 initializes missing Intl APIs before boot. */ }
  }
  const weekStartsOn = Number.isInteger(device.weekStartsOn) && device.weekStartsOn! >= 1 && device.weekStartsOn! <= 7
    ? device.weekStartsOn as WeekStartsOn : weekStartForRegion(deviceRegion ?? region);
  return Object.freeze({ messageLocale, formatLocale, timeZone, hourCycle: hourCycle ?? 'h23', weekStartsOn });
}
