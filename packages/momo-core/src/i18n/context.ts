import { createMessageService, SAFE_MESSAGE } from './service';
import type { LocaleContext } from './locale';
import type { MessageService, MessageServiceOptions } from './types';

/** Basic options only: no formatRange, parts, compact or engineering on the public path. */
export type DateFormatOptions = Pick<Intl.DateTimeFormatOptions,
  'weekday' | 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'timeZoneName'>;
export type NumberFormatOptions = Pick<Intl.NumberFormatOptions,
  'useGrouping' | 'minimumIntegerDigits' | 'minimumFractionDigits' | 'maximumFractionDigits' | 'minimumSignificantDigits' | 'maximumSignificantDigits'>
  & { style?: 'decimal' | 'percent' };
export type CurrencyFormatOptions = Omit<NumberFormatOptions, 'style'> & { currencyDisplay?: 'symbol' | 'code' | 'name' };
export type DisplaySortOptions = Pick<Intl.CollatorOptions, 'sensitivity' | 'numeric' | 'ignorePunctuation' | 'caseFirst'>;
export interface LocaleFormatDiagnostic { code: 'locale-format-failed'; }

/** P0-3/4 load a catalog before updateContext; pseudo catalogs can use their own messageLocale. */
export type LocaleServiceContext = LocaleContext & Omit<MessageServiceOptions, 'messageLocale' | 'timeZone'> & {
  onFormatDiagnostic?: (diagnostic: LocaleFormatDiagnostic) => void;
};

export interface LocaleService extends MessageService {
  readonly context: LocaleContext;
  /** Atomically replace messages and every formatter cache, then notify subscribers. */
  updateContext(context: LocaleServiceContext): void;
  subscribe(listener: (context: LocaleContext) => void): () => void;
  formatDate(value: number | Date, options?: DateFormatOptions): string;
  formatTime(value: number | Date, options?: DateFormatOptions): string;
  formatNumber(value: number, options?: NumberFormatOptions): string;
  /** Currency is the API's ISO 4217 code, never inferred from language. */
  formatCurrency(value: number, currency: string, options?: CurrencyFormatOptions): string;
  selectPlural(value: number, type?: 'cardinal' | 'ordinal'): Intl.LDMLPluralRule;
  /** Both timestamps are epoch milliseconds; day differences use context-zone calendar days. */
  formatRelativeTime(value: number, now: number, unit?: 'second' | 'minute' | 'hour' | 'day'): string;
  /** Display order only; normalize NFC, then break locale-equivalent ties by stable ID. */
  compareDisplay(a: { text: string; id: string }, b: { text: string; id: string }, options: DisplaySortOptions): number;
}

function pick<T extends object>(input: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(input).filter(([key]) => keys.includes(key))) as T;
}
const DATE_KEYS = ['weekday', 'year', 'month', 'day', 'hour', 'minute', 'second', 'timeZoneName'];
const NUMBER_KEYS = ['useGrouping', 'minimumIntegerDigits', 'minimumFractionDigits', 'maximumFractionDigits', 'minimumSignificantDigits', 'maximumSignificantDigits'];
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** One platform-free context for messages and regional formats; initialize Intl prerequisites first. */
export function createLocaleService(initial: LocaleServiceContext): LocaleService {
  let config: LocaleServiceContext;
  let context: LocaleContext;
  let messages: MessageService;
  let dates: Map<string, Intl.DateTimeFormat>;
  let numbers: Map<string, Intl.NumberFormat>;
  let plurals: Map<string, Intl.PluralRules>;
  let relatives: Map<string, Intl.RelativeTimeFormat>;
  let collators: Map<string, Intl.Collator>;
  const listeners = new Set<(context: LocaleContext) => void>();
  const replace = (next: LocaleServiceContext) => {
    config = { ...next };
    context = Object.freeze({
      messageLocale: next.messageLocale, formatLocale: next.formatLocale, timeZone: next.timeZone,
      hourCycle: next.hourCycle, weekStartsOn: next.weekStartsOn,
    });
    messages = createMessageService(config);
    dates = new Map(); numbers = new Map(); plurals = new Map(); relatives = new Map(); collators = new Map();
  };
  replace(initial);
  const diagnostic = () => {
    try { config.onFormatDiagnostic?.({ code: 'locale-format-failed' }); }
    catch { /* Never expose native errors or caller values through diagnostics. */ }
  };
  const cached = <T>(cache: Map<string, T>, locale: string, options: object, make: () => T): T => {
    const key = JSON.stringify([locale, context.timeZone, Object.entries(options).sort(([a], [b]) => compareId(a, b))]);
    if (cache.has(key)) return cache.get(key)!;
    const formatter = make();
    if (cache.size >= 64) cache.clear();
    cache.set(key, formatter);
    return formatter;
  };
  // Selected regional formatter -> English/UTC -> catalog-independent safe text.
  const format = (work: (locale: string, timeZone: string) => string): string => {
    try { return work(context.formatLocale, context.timeZone); }
    catch { diagnostic(); }
    try { return work('en-US', 'UTC'); }
    catch { diagnostic(); return SAFE_MESSAGE; }
  };
  const date = (value: number | Date, options: DateFormatOptions) => format((locale, timeZone) => {
    const epoch = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(epoch)) throw new Error('invalid-date');
    const opts = { ...pick(options, DATE_KEYS), timeZone, hourCycle: context.hourCycle };
    return cached(dates, locale, opts, () => new Intl.DateTimeFormat(locale, opts)).format(epoch);
  });
  const number = (value: number, options: Intl.NumberFormatOptions) => format(locale => {
    if (!Number.isFinite(value)) throw new Error('invalid-number');
    return cached(numbers, locale, options, () => new Intl.NumberFormat(locale, options)).format(value);
  });
  const calendarDay = (value: number, timeZone: string): number => {
    const opts = { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' } as const;
    const parts = cached(dates, 'en-US', opts, () => new Intl.DateTimeFormat('en-US', opts)).formatToParts(value);
    const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
  };
  return {
    get context() { return context; },
    get messageLocale() { return context.messageLocale; },
    formatMessage: (key, ...args) => messages.formatMessage(key, ...args),
    updateContext(next) {
      replace(next);
      for (const listener of listeners) {
        try { listener(context); } catch { /* Host observers cannot interrupt a switch. */ }
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    formatDate: (value, options = { year: 'numeric', month: 'numeric', day: 'numeric' }) => date(value, options),
    formatTime: (value, options = { hour: 'numeric', minute: '2-digit' }) => date(value, options),
    formatNumber(value, options = {}) {
      return number(value, { ...pick(options, NUMBER_KEYS), style: options.style ?? 'decimal' });
    },
    formatCurrency(value, currency, options = {}) {
      if (!/^[A-Z]{3}$/.test(currency)) { diagnostic(); return SAFE_MESSAGE; }
      return number(value, { ...pick(options, [...NUMBER_KEYS, 'currencyDisplay']), style: 'currency', currency });
    },
    selectPlural(value, type = 'cardinal') {
      if (!Number.isFinite(value)) { diagnostic(); return 'other'; }
      for (const locale of [context.formatLocale, 'en-US']) {
        try { return cached(plurals, locale, { type }, () => new Intl.PluralRules(locale, { type })).select(value); }
        catch { diagnostic(); }
      }
      return 'other';
    },
    formatRelativeTime(value, now, unit = 'second') {
      return format((locale, timeZone) => {
        if (!Number.isFinite(value) || !Number.isFinite(now)) throw new Error('invalid-time');
        const difference = unit === 'day' ? calendarDay(value, timeZone) - calendarDay(now, timeZone)
          : Math.round((value - now) / ({ second: 1000, minute: 60_000, hour: 3_600_000 }[unit]));
        const opts = { numeric: 'auto' } as const;
        return cached(relatives, locale, opts, () => new Intl.RelativeTimeFormat(locale, opts)).format(difference, unit);
      });
    },
    compareDisplay(a, b, options) {
      const opts = pick(options, ['sensitivity', 'numeric', 'ignorePunctuation', 'caseFirst']);
      for (const locale of [context.formatLocale, 'en-US']) {
        try {
          const collator = cached(collators, locale, opts, () => new Intl.Collator(locale, opts));
          return collator.compare(a.text.normalize('NFC'), b.text.normalize('NFC')) || compareId(a.id, b.id);
        } catch { diagnostic(); }
      }
      return compareId(a.text.normalize('NFC'), b.text.normalize('NFC')) || compareId(a.id, b.id);
    },
  };
}
