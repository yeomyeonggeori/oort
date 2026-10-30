/* eslint-env es2021 */
/**
 * #4833 / ADR-0213 §3. Dedicated Metro entry; run in the locked Hermes (see ../src/i18n/README.md).
 * Node/Jest output is never Hermes runtime evidence.
 * NumberFormat.formatToParts is only inspected with typeof, never called: Apple Hermes registers
 * none (Intl.cpp `#ifndef __APPLE__`), and `numberFormat` below records what this engine really has.
 */
const {initializeMobileIntl} = require('../src/i18n/intl');
const {supportedLocales} = require('@momo/core/i18n');

const hermes = globalThis.HermesInternal;
const report = {
  expectedEngine: 'hermes-v250829098.0.16',
  runtime: hermes ? hermes.getRuntimeProperties?.() ?? {} : 'runtime-unverified',
  nativeSupport: {},
  numberFormat: {
    prototypeNames: Object.getOwnPropertyNames(Intl.NumberFormat.prototype),
    formatToParts: typeof Intl.NumberFormat.prototype.formatToParts,
  },
  output: {},
};
for (const api of ['PluralRules', 'Locale', 'RelativeTimeFormat', 'DateTimeFormat', 'NumberFormat', 'Collator']) {
  report.nativeSupport[api] = supportedLocales.map(locale => {
    try {
      const supported = api === 'Locale' ? new Intl.Locale(locale).baseName === locale
        : Intl[api].supportedLocalesOf([locale]).length === 1;
      return {locale, supported};
    } catch { return {locale, supported: false}; }
  });
}
try {
  initializeMobileIntl();
  report.numberFormat.formatToPartsAfterInit = typeof Intl.NumberFormat.prototype.formatToParts;
  const counts = [0, 1, 2, 1.5, 1_000_000];
  const boundaries = ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z'];
  for (const locale of ['ko-KR', 'en-US']) {
    const dates = {};
    for (const timeZone of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      dates[timeZone] = boundaries.map(utc => ({utc, local: new Intl.DateTimeFormat(locale, {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(Date.parse(utc))}));
    }
    const items = [{text: 'é', id: 'b'}, {text: 'e\u0301', id: 'a'}, {text: 'item10', id: '10'}, {text: 'item2', id: '2'}, {text: '가', id: 'ko'}, {text: '日', id: 'ja'}, {text: '中', id: 'zh'}];
    const collator = new Intl.Collator(locale, {numeric: true, sensitivity: 'base'});
    report.output[locale] = {
      plural: counts.map(value => ({value, cardinal: new Intl.PluralRules(locale).select(value), ordinal: new Intl.PluralRules(locale, {type: 'ordinal'}).select(value)})),
      dates,
      number: new Intl.NumberFormat(locale).format(12345.67),
      currencies: ['USD', 'JPY', 'KRW'].map(currency => {
        const formatter = new Intl.NumberFormat(locale, {style: 'currency', currency});
        return {currency, formatted: formatter.format(12345.67), resolved: formatter.resolvedOptions()};
      }),
      relative: [-1, 0, 1, 2, 12345.67].map(value => new Intl.RelativeTimeFormat(locale, {numeric: 'auto'}).format(value, 'day')),
      displayOrder: items.sort((a, b) => collator.compare(a.text.normalize('NFC'), b.text.normalize('NFC')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }
} catch {
  report.diagnostic = 'mobile-intl-initialization-failed';
}
globalThis.__oortIntlProbe = report;
console.log(JSON.stringify(report, null, 2));
