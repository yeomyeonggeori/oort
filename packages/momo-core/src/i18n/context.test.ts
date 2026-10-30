import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocaleService, loadMessageCatalog, resolveLocaleContext, SAFE_MESSAGE,
  type LocaleFormatDiagnostic, type LocaleServiceContext,
} from './index';

const en = (): LocaleServiceContext => resolveLocaleContext('en-US', { languages: [], timeZone: 'UTC', hourCycle: 'h23' });
afterEach(() => { vi.restoreAllMocks(); });

describe('ADR-0213 shared locale context', () => {
  it('shares generated messages, basic numbers, percentages and explicit API currency codes', async () => {
    const service = createLocaleService(en());
    expect(service.formatMessage('common.members.count', { count: 2 })).toBe('2 members');
    expect(service.formatNumber(12345.67)).toBe('12,345.67');
    expect(service.formatNumber(0.25, { style: 'percent' })).toBe('25%');
    expect(service.formatCurrency(12345.67, 'USD')).toBe('$12,345.67');
    expect(service.formatCurrency(12345.67, 'JPY')).toBe('¥12,346');
    expect(service.formatCurrency(12345.67, 'KRW')).toBe('₩12,346');
    service.updateContext({ ...resolveLocaleContext('ko-KR', { languages: ['ko-KR'], timeZone: 'UTC' }), catalog: await loadMessageCatalog('ko-KR') });
    expect(service.formatMessage('settings.profile.languageLabel')).toBe('언어');
    expect(service.formatCurrency(1, 'USD')).toContain('1.00');
    expect(service.formatCurrency(1, '')).toBe(SAFE_MESSAGE);
  });

  it('uses native plural rules for all languages including French zero and Spanish million', () => {
    const service = createLocaleService(en());
    const values = [0, 1, 2, 1.5, 1_000_000];
    for (const [locale, expected] of [
      ['ko-KR', ['other', 'other', 'other', 'other', 'other']],
      ['ja-JP', ['other', 'other', 'other', 'other', 'other']],
      ['zh-Hans', ['other', 'other', 'other', 'other', 'other']],
      ['zh-Hant', ['other', 'other', 'other', 'other', 'other']],
      ['en-US', ['other', 'one', 'other', 'other', 'other']],
      ['fr-FR', ['one', 'one', 'other', 'one', 'many']],
      ['es-419', ['other', 'one', 'other', 'other', 'many']],
    ] as const) {
      service.updateContext({ ...en(), messageLocale: locale, formatLocale: locale });
      expect(values.map(value => service.selectPlural(value))).toEqual(expected);
    }
    service.updateContext(en());
    expect(service.selectPlural(2, 'ordinal')).toBe('two');
  });

  it('formats explicit timezones, hour cycles and New York DST without changing epochs', () => {
    const service = createLocaleService(en());
    const before = Date.parse('2026-03-08T06:30:00Z');
    const after = Date.parse('2026-03-08T07:30:00Z');
    expect(service.formatTime(before)).toBe('06:30');
    service.updateContext({ ...en(), timeZone: 'America/New_York' });
    expect(service.formatTime(before)).toBe('01:30');
    expect(service.formatTime(after)).toBe('03:30');
    service.updateContext({ ...en(), timeZone: 'Asia/Seoul', hourCycle: 'h12' });
    expect(service.formatTime(before)).toBe('3:30 PM');
    expect(service.formatDate(new Date(before))).toBe('3/8/2026');
    expect(before).toBe(Date.parse('2026-03-08T06:30:00Z'));
  });

  it('uses a shared now and context-zone calendar day across midnight and 23-hour DST days', () => {
    const service = createLocaleService({ ...en(), timeZone: 'America/New_York' });
    expect(service.formatRelativeTime(Date.parse('2026-03-08T05:30Z'), Date.parse('2026-03-09T04:15Z'), 'day')).toBe('yesterday');
    expect(service.formatRelativeTime(10_000, 0, 'second')).toBe('in 10 seconds');
    service.updateContext({ ...en(), timeZone: 'Asia/Seoul' });
    expect(service.formatRelativeTime(Date.parse('2026-10-29T15:01Z'), Date.parse('2026-10-29T14:59Z'), 'day')).toBe('tomorrow');
  });

  it('reuses formatters per options then discards all constructors and message caches on switch', async () => {
    const base = en();
    const service = createLocaleService(base);
    const { DateTimeFormat, NumberFormat, PluralRules, RelativeTimeFormat, Collator } = Intl;
    const constructors = [
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args) => new DateTimeFormat(...args)),
      vi.spyOn(Intl, 'NumberFormat').mockImplementation((...args) => new NumberFormat(...args)),
      vi.spyOn(Intl, 'PluralRules').mockImplementation((...args) => new PluralRules(...args)),
      vi.spyOn(Intl, 'RelativeTimeFormat').mockImplementation((...args) => new RelativeTimeFormat(...args)),
      vi.spyOn(Intl, 'Collator').mockImplementation((...args) => new Collator(...args)),
    ];
    const exercise = () => {
      service.formatDate(0); service.formatNumber(12.3); service.selectPlural(1);
      service.formatRelativeTime(10_000, 0); service.compareDisplay({ text: 'a', id: 'a' }, { text: 'b', id: 'b' }, {});
    };
    exercise(); exercise();
    for (const constructor of constructors) expect(constructor).toHaveBeenCalledTimes(1);
    const observer = vi.fn();
    service.subscribe(() => { throw new Error('host observer'); });
    const unsubscribe = service.subscribe(observer);
    service.updateContext({ ...base, formatLocale: 'fr-FR' });
    exercise();
    for (const constructor of constructors) expect(constructor).toHaveBeenCalledTimes(2);
    expect(service.formatNumber(12.3)).toBe('12,3');
    service.updateContext(base);
    exercise();
    for (const constructor of constructors) expect(constructor).toHaveBeenCalledTimes(3);
    expect(observer).toHaveBeenCalledTimes(2);
    unsubscribe();
    for (const constructor of constructors) constructor.mockRestore();
    // The same locale with a different catalog also rebuilds message instances.
    service.updateContext({ ...base, catalog: await loadMessageCatalog('ko-KR') });
    expect(service.formatMessage('settings.profile.languageLabel')).toBe('언어');
    service.updateContext(base);
    expect(service.formatMessage('settings.profile.languageLabel')).toBe('Language');
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('provides NFC display sorting with explicit sensitivity/numeric and stable ID ties', () => {
    const service = createLocaleService(en());
    expect(service.compareDisplay({ text: 'é', id: 'b' }, { text: 'e\u0301', id: 'a' }, { sensitivity: 'base' })).toBe(1);
    expect(service.compareDisplay({ text: 'item2', id: 'b' }, { text: 'item10', id: 'a' }, { numeric: true })).toBeLessThan(0);
    expect(service.compareDisplay({ text: 'A', id: 'b' }, { text: 'a', id: 'a' }, { sensitivity: 'base' })).toBe(1);
  });

  it('falls back from broken regional Intl to English then safe output with code-only diagnostics', () => {
    const diagnostics: LocaleFormatDiagnostic[] = [];
    const service = createLocaleService({ ...en(), formatLocale: 'not_a_locale', onFormatDiagnostic: d => { diagnostics.push(d); throw new Error('private'); } });
    expect(service.formatNumber(1234)).toBe('1,234');
    expect(service.formatDate(0)).toBe('1/1/1970');
    expect(service.formatNumber(NaN)).toBe(SAFE_MESSAGE);
    expect(service.formatDate(new Date(NaN))).toBe(SAFE_MESSAGE);
    vi.spyOn(Intl, 'PluralRules').mockImplementation(() => { throw new Error('private native error'); });
    expect(service.selectPlural(1)).toBe('other');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every(d => JSON.stringify(d) === '{"code":"locale-format-failed"}')).toBe(true);
  });

  it('propagates the context timezone into compiled ICU date arguments', () => {
    // Generated key contract is retained; inject a compiled date node as a catalog fixture.
    const service = createLocaleService({
      ...en(), timeZone: 'Asia/Seoul',
      catalog: { 'common.members.count': [{ type: 3, value: 'count', style: 'short' }] },
    });
    const epoch = Date.parse('2026-10-29T23:30Z');
    expect(service.formatMessage('common.members.count', { count: epoch })).toBe('10/30/26');
  });
});
