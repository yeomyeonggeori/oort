import {SAFE_MESSAGE, localeAutonyms, type DeviceLocaleFacts, type LocalePreferencePort} from '@momo/core/i18n';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React, {useEffect} from 'react';
import {AppState, DeviceEventEmitter, Settings, Text} from 'react-native';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {ThemeProvider} from '../src/design/theme';
import {createMobileLocaleController, type MobileLocaleController} from '../src/i18n/controller';
import {subscribeMobileLocaleChanges} from '../src/i18n/device';
import {initializeMobileIntl, type IntlPolyfill} from '../src/i18n/intl';
import {LanguageSettingRow, LanguageSettingsPage} from '../src/i18n/LanguageSettings';
import {MobileLocaleProvider, useMobileLocale} from '../src/i18n/LocaleProvider';
import {createMobileLocalePort, MOBILE_LOCALE_KEY} from '../src/i18n/preferencePort';
import {clearSession} from '../src/storage/secureSession';

const nativeIntl = {
  locale: Intl.Locale, pluralRules: Intl.PluralRules, relativeTimeFormat: Intl.RelativeTimeFormat,
};
const names = {locale: 'Locale', pluralRules: 'PluralRules', relativeTimeFormat: 'RelativeTimeFormat'} as const;
const descriptors = Object.fromEntries(Object.values(names).map(name => [name, Object.getOwnPropertyDescriptor(Intl, name)!]));
const hermesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HermesInternal');
const canonicalDescriptor = Object.getOwnPropertyDescriptor(Intl, 'getCanonicalLocales')!;
const numberFormatParts = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'formatToParts')!;
const controllers: MobileLocaleController[] = [];
const store = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

function install(polyfill: IntlPolyfill, value: unknown) {
  Object.defineProperty(Intl, names[polyfill], {...descriptors[names[polyfill]], value});
}
function restore(polyfill: IntlPolyfill) {
  install(polyfill, nativeIntl[polyfill]);
}
function remove(polyfill: IntlPolyfill) {
  install(polyfill, undefined);
}
/** The shipping loader requires the official packages; a fresh registry makes them install again. */
function initializeWithOfficialPolyfills() {
  jest.isolateModules(() => {
    (require('../src/i18n/intl') as typeof import('../src/i18n/intl')).initializeMobileIntl();
  });
}
function port(facts: DeviceLocaleFacts = {languages: ['ko-KR'], timeZone: 'Asia/Seoul'}): LocalePreferencePort {
  let choice: unknown = 'system';
  return {readPreference: () => choice, writePreference: next => { choice = next; }, readDevice: () => facts};
}
async function controller(preferencePort = port(), observeDevice?: (onChange: () => void) => () => void) {
  const next = await createMobileLocaleController({port: preferencePort, observeDevice});
  controllers.push(next);
  return next;
}

beforeEach(() => {
  store.clear();
  DeviceEventEmitter.emit('settingsUpdated', {AppleLanguages: ['ko-KR'], AppleLocale: 'ko_KR', AppleICUForce24HourTime: false, AppleICUForce12HourTime: false});
});
afterEach(() => {
  cleanup();
  controllers.splice(0).forEach(current => current.dispose());
  (Object.keys(names) as IntlPolyfill[]).forEach(restore);
  Object.defineProperty(Intl.NumberFormat.prototype, 'formatToParts', numberFormatParts);
  Object.defineProperty(Intl, 'getCanonicalLocales', canonicalDescriptor);
  if (hermesDescriptor) Object.defineProperty(globalThis, 'HermesInternal', hermesDescriptor);
  else delete (globalThis as {HermesInternal?: unknown}).HermesInternal;
  jest.restoreAllMocks();
});

it('loads no polyfill when all required native capabilities work', () => {
  const load = jest.fn();
  initializeMobileIntl(load);
  expect(load).not.toHaveBeenCalled();
});

it('conditionally loads missing prerequisites in order before accepting Intl', () => {
  (Object.keys(names) as IntlPolyfill[]).forEach(remove);
  const load = jest.fn(restore);
  initializeMobileIntl(load);
  expect(load.mock.calls.map(([name]) => name)).toEqual(['locale', 'pluralRules', 'relativeTimeFormat']);
  remove('relativeTimeFormat');
  load.mockClear();
  initializeMobileIntl(load);
  expect(load.mock.calls.map(([name]) => name)).toEqual(['relativeTimeFormat']);
  remove('pluralRules');
  expect(() => initializeMobileIntl(() => {})).toThrow('intl-polyfill-initialization-failed');
});

it('replaces a native RelativeTimeFormat whose text is not the CLDR text', () => {
  class HalfWorking {
    static supportedLocalesOf(locales: string[]) { return locales; }
    format() { return 'x'; }
  }
  Object.defineProperty(Intl, 'RelativeTimeFormat', {...descriptors.RelativeTimeFormat, value: HalfWorking});
  const load = jest.fn(restore);
  initializeMobileIntl(load);
  expect(load.mock.calls.map(([name]) => name)).toEqual(['relativeTimeFormat']);
});

it('initializes the official polyfills on an Apple-Hermes-shaped engine that registers no NumberFormat.formatToParts', () => {
  (Object.keys(names) as IntlPolyfill[]).forEach(remove);
  Object.defineProperty(globalThis, 'HermesInternal', {value: {}, configurable: true});
  delete (Intl.NumberFormat.prototype as {formatToParts?: unknown}).formatToParts;
  expect('formatToParts' in Intl.NumberFormat.prototype).toBe(false);
  expect(() => initializeWithOfficialPolyfills()).not.toThrow();
  expect(new Intl.RelativeTimeFormat('en').format(2, 'day')).toBe('in 2 days');
  expect(new Intl.RelativeTimeFormat('en').format(-3, 'week')).toBe('3 weeks ago');
  expect(new Intl.RelativeTimeFormat('ko', {numeric: 'auto'}).format(1, 'day')).toBe('내일');
  expect(new Intl.RelativeTimeFormat('ko').format(12345.67, 'day')).toBe('12,345.67일 후');
  expect('formatToParts' in Intl.NumberFormat.prototype).toBe(false);
});

it('fails closed when an engine registers a NumberFormat.formatToParts that does not work', () => {
  (Object.keys(names) as IntlPolyfill[]).forEach(remove);
  const registered = jest.spyOn(Intl.NumberFormat.prototype, 'formatToParts').mockImplementation(() => { throw new Error('registered but unimplemented'); });
  expect(() => initializeWithOfficialPolyfills()).toThrow('intl-polyfill-initialization-failed');
  expect(registered).toHaveBeenCalled();
});

it('executes the official ko/en polyfills and their real ICU plural/relative data', () => {
  (Object.keys(names) as IntlPolyfill[]).forEach(remove);
  initializeMobileIntl();
  expect(new Intl.Locale('en-US').region).toBe('US');
  expect([0, 1, 2, 1.5, 1_000_000].map(value => new Intl.PluralRules('en').select(value)))
    .toEqual(['other', 'one', 'other', 'other', 'other']);
  expect(new Intl.PluralRules('ko').select(1)).toBe('other');
  expect(new Intl.RelativeTimeFormat('en', {numeric: 'auto'}).format(-1, 'day')).toBe('yesterday');
  expect(new Intl.RelativeTimeFormat('ko', {numeric: 'auto'}).format(1, 'day')).toBe('내일');
});

/**
 * Each Intl check below measures a value. A fake that is registered, is a function and even answers
 * `supportedLocalesOf` — and is still wrong — must be replaced (or, after loading, rejected).
 */
function pluralRulesAnswering(answer: (locale: string, count: number) => string) {
  return class {
    constructor(private readonly locale: string) {}
    static supportedLocalesOf(locales: string[]) { return locales; }
    select(count: number) { return answer(this.locale, count); }
  };
}
const registeredButWrong: ReadonlyArray<readonly [string, IntlPolyfill, unknown]> = [
  ['a Locale whose baseName is not the tag', 'locale', class {
    get baseName() { return 'xx'; }
    maximize() { return this; }
    toString() { return 'en-Latn-US'; }
  }],
  ['a Locale that does not maximize', 'locale', class {
    constructor(private readonly tag: string) {}
    get baseName() { return this.tag; }
    maximize() { return this; }
    toString() { return this.tag; }
  }],
  ['a PluralRules that answers "other" for English 1', 'pluralRules', pluralRulesAnswering(() => 'other')],
  ['a PluralRules that answers "one" for Korean counts', 'pluralRules',
    pluralRulesAnswering((locale, count) => (locale === 'ko-KR' || count === 1 ? 'one' : 'other'))],
  ['a RelativeTimeFormat that answers with other text', 'relativeTimeFormat', class {
    static supportedLocalesOf(locales: string[]) { return locales; }
    format() { return 'x'; }
  }],
];

it.each(registeredButWrong)('replaces %s instead of trusting that it is registered', (_label, polyfill, wrong) => {
  install(polyfill, wrong);
  const load = jest.fn(restore);
  initializeMobileIntl(load);
  expect(load.mock.calls.map(([name]) => name)).toEqual([polyfill]);
});

it.each(registeredButWrong)('fails closed when the loader leaves %s behind', (_label, polyfill, wrong) => {
  remove(polyfill);
  const load = jest.fn((name: IntlPolyfill) => install(name, wrong));
  expect(() => initializeMobileIntl(load)).toThrow('intl-polyfill-initialization-failed');
  expect(load.mock.calls.map(([name]) => name)).toEqual([polyfill]);
});

it.each([
  ['missing', undefined],
  ['not canonicalizing', () => ['ko-kr']],
])('refuses to start, loading nothing, when Intl.getCanonicalLocales is %s', (_label, replacement) => {
  Object.defineProperty(Intl, 'getCanonicalLocales', {...canonicalDescriptor, value: replacement});
  const load = jest.fn();
  expect(() => initializeMobileIntl(load)).toThrow('intl-canonical-locales-unavailable');
  expect(load).not.toHaveBeenCalled();
});

const withoutLocale = (missing: string) => (locales: Intl.LocalesArgument) =>
  [locales ?? []].flat().map(String).filter(locale => locale !== missing);
/** `format` and `compare` are accessors on the prototypes; the lib types them as plain methods. */
const prototypeOf = (constructor: {prototype: object}) => constructor.prototype as Record<string, unknown>;
const brokenNatives: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ...(['ko-KR', 'en-US'] as const).flatMap(missing => [
    [`DateTimeFormat does not list ${missing}`, () => jest.spyOn(Intl.DateTimeFormat, 'supportedLocalesOf').mockImplementation(withoutLocale(missing)), 'intl-native-locale-unavailable'],
    [`NumberFormat does not list ${missing}`, () => jest.spyOn(Intl.NumberFormat, 'supportedLocalesOf').mockImplementation(withoutLocale(missing)), 'intl-native-locale-unavailable'],
    [`Collator does not list ${missing}`, () => jest.spyOn(Intl.Collator, 'supportedLocalesOf').mockImplementation(withoutLocale(missing)), 'intl-native-locale-unavailable'],
  ] as const),
  ['DateTimeFormat has no year part', () => jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([]), 'intl-native-format-unavailable'],
  ['NumberFormat formats to nothing', () => jest.spyOn(prototypeOf(Intl.NumberFormat), 'format', 'get').mockReturnValue(() => ''), 'intl-native-format-unavailable'],
  ['Collator does not put a before b', () => jest.spyOn(prototypeOf(Intl.Collator), 'compare', 'get').mockReturnValue(() => 1), 'intl-native-format-unavailable'],
];
it.each(brokenNatives)('refuses to start, loading nothing, when the native %s', (_label, breakNative, code) => {
  breakNative();
  const load = jest.fn();
  expect(() => initializeMobileIntl(load)).toThrow(code);
  expect(load).not.toHaveBeenCalled();
});

it('persists/restores MMKV preference across logout and applies a fresh service atomically', async () => {
  jest.spyOn(Settings, 'get').mockImplementation(key => key === 'AppleLanguages' ? ['ko-KR'] : key === 'AppleLocale' ? 'ko_KR' : undefined);
  const current = await controller(createMobileLocalePort());
  const firstService = current.getSnapshot().locale;
  const observe = jest.fn();
  current.subscribe(observe);
  expect(await current.setPreference('en-US')).toBe(true);
  expect(store.get(MOBILE_LOCALE_KEY)).toBe('en-US');
  expect(current.getSnapshot().locale).not.toBe(firstService);
  expect(current.getSnapshot().locale.formatMessage('settings.profile.languageLabel')).toBe('Language');
  expect(observe).toHaveBeenCalledTimes(1);
  clearSession();
  const restarted = await controller(createMobileLocalePort());
  expect(restarted.getSnapshot().preference).toBe('en-US');
  expect(store.get(MOBILE_LOCALE_KEY)).toBe('en-US');
  await restarted.setPreference('system');
  expect((await controller(createMobileLocalePort())).getSnapshot().preference).toBe('system');
});

it('reevaluates system language on app resume and tears down its listener', async () => {
  let resume: ((state: 'active' | 'background') => void) | undefined;
  const removeListener = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    resume = listener;
    return {remove: removeListener};
  });
  jest.spyOn(Settings, 'watchKeys').mockReturnValue(7);
  const clearWatch = jest.spyOn(Settings, 'clearWatch').mockImplementation(() => {});
  let facts: DeviceLocaleFacts = {languages: ['ko-KR']};
  const current = await controller({...port(), readDevice: () => facts}, subscribeMobileLocaleChanges);
  facts = {languages: ['en-US'], timeZone: 'America/New_York'};
  resume?.('background');
  await Promise.resolve();
  expect(current.getSnapshot().effectiveLocale).toBe('ko-KR');
  resume?.('active');
  await Promise.resolve();
  await Promise.resolve();
  expect(current.getSnapshot().effectiveLocale).toBe('en-US');
  expect(current.getSnapshot().locale.context.timeZone).toBe('America/New_York');
  current.dispose();
  expect(removeListener).toHaveBeenCalledTimes(1);
  expect(clearWatch).toHaveBeenCalledWith(7);
  controllers.splice(controllers.indexOf(current), 1);
});

it('observes OS language changes immediately and preserves explicit choice plus new region', async () => {
  const current = await controller(createMobileLocalePort(), subscribeMobileLocaleChanges);
  const watch = jest.spyOn(Settings, 'watchKeys');
  DeviceEventEmitter.emit('settingsUpdated', {AppleLanguages: ['en-GB'], AppleLocale: 'en_GB'});
  await Promise.resolve();
  await Promise.resolve();
  expect(current.getSnapshot().effectiveLocale).toBe('en-US');
  expect(current.getSnapshot().locale.context.formatLocale).toBe('en-GB');
  await current.setPreference('en-US');
  DeviceEventEmitter.emit('settingsUpdated', {AppleLanguages: ['ko-KR'], AppleLocale: 'ko_KR', AppleICUForce24HourTime: true});
  await Promise.resolve();
  await Promise.resolve();
  expect(current.getSnapshot().effectiveLocale).toBe('en-US');
  expect(current.getSnapshot().locale.context.formatLocale).toBe('en-KR');
  expect(current.getSnapshot().locale.context.hourCycle).toBe('h23');
  expect(watch).not.toHaveBeenCalled(); // No duplicate watchers on refresh/selection.
});

it('falls back to offline English for unshipped device languages without overwriting the preference', async () => {
  const current = await controller(port({languages: ['ja-JP'], timeZone: 'Asia/Tokyo'}));
  expect(current.getSnapshot().preference).toBe('system');
  expect(current.getSnapshot().effectiveLocale).toBe('en-US');
  expect(current.getSnapshot().locale.context).toMatchObject({formatLocale: 'en-JP', timeZone: 'Asia/Tokyo'});
  expect(current.getSnapshot().locale.formatMessage('settings.profile.languageLabel')).toBe('Language');
  await current.setPreference('ko-KR');
  expect(current.getSnapshot().locale.formatMessage('settings.profile.languageLabel')).toBe('언어');
});

it('continues with the device language when the stored preference cannot be read, reporting only the code', async () => {
  const diagnostics: string[] = [];
  const unreadable: LocalePreferencePort = {
    ...port({languages: ['en-US'], timeZone: 'America/New_York'}),
    readPreference: () => { throw new Error('disk detail'); },
  };
  const created = createMobileLocaleController({port: unreadable, onDiagnostic: ({code}) => diagnostics.push(code)});
  await expect(created).resolves.toMatchObject({getSnapshot: expect.any(Function)});
  const current = await created;
  controllers.push(current);
  expect(current.getSnapshot()).toMatchObject({preference: 'system', effectiveLocale: 'en-US'});
  expect(current.getSnapshot().locale.formatMessage('settings.profile.languageLabel')).toBe('Language');
  expect(diagnostics).toEqual(['preference-read-failed']);
  expect(JSON.stringify(diagnostics)).not.toContain('disk detail');
  // Writing is a separate path: the user can still choose a language afterwards.
  expect(await current.setPreference('ko-KR')).toBe(true);
  expect(current.getSnapshot()).toMatchObject({preference: 'ko-KR', effectiveLocale: 'ko-KR'});
});

it('does not put the app behind the safe screen when only the stored preference is unreadable', async () => {
  const createController = () => createMobileLocaleController({
    port: {...port(), readPreference: () => { throw new Error('disk detail'); }},
  });
  render(<ThemeProvider><MobileLocaleProvider createController={createController}><Text>private product tree</Text></MobileLocaleProvider></ThemeProvider>);
  expect(await screen.findByText('private product tree')).toBeTruthy();
  expect(screen.queryByTestId('locale-boot-code')).toBeNull();
});

it('still stops boot, with only a redacted code, when the device language cannot be read', async () => {
  const diagnostics: string[] = [];
  const unreadableDevice: LocalePreferencePort = {...port(), readDevice: () => { throw new Error('native detail'); }};
  await expect(createMobileLocaleController({port: unreadableDevice, onDiagnostic: ({code}) => diagnostics.push(code)}))
    .rejects.toThrow('mobile-locale-initialization-failed');
  expect(diagnostics).toEqual(['device-read-failed', 'mobile-locale-initialization-failed']);
});

it('blocks services on initialization failure and offers only English safe text plus a redacted code', async () => {
  const read = jest.fn();
  const diagnostic = jest.fn();
  const createController = () => createMobileLocaleController({
    port: {...port(), readPreference: read},
    initializeIntl: () => { throw new Error('sensitive native detail'); },
    onDiagnostic: diagnostic,
  });
  render(<ThemeProvider><MobileLocaleProvider createController={createController}><Text>private product tree</Text></MobileLocaleProvider></ThemeProvider>);
  const retry = await screen.findByRole('button', {name: SAFE_MESSAGE});
  expect(screen.getByTestId('locale-boot-code')).toHaveTextContent('mobile-intl-initialization-failed');
  expect(screen.queryByText('private product tree')).toBeNull();
  expect(screen.queryByText(/sensitive|한국어/)).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith({code: 'mobile-intl-initialization-failed'});
  fireEvent.press(retry);
  await waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(2));
});

it('switches the whole mounted context immediately with system first, ko/en autonyms, beta and partial notice', async () => {
  const current = await controller();
  const createController = async () => current;
  const mounted = jest.fn();
  function ExistingAccount() {
    const locale = useMobileLocale();
    useEffect(mounted, []);
    return <Text testID="another-account">{locale?.locale.formatMessage('settings.profile.languageLabel')}</Text>;
  }
  render(<ThemeProvider><MobileLocaleProvider createController={createController}>
    <ExistingAccount /><LanguageSettingRow onPress={() => {}} /><LanguageSettingsPage onBack={() => {}} />
  </MobileLocaleProvider></ThemeProvider>);
  // The spoken label carries what the screen shows next to each autonym: the beta tag.
  const en = await screen.findByRole('radio', {name: `${localeAutonyms['en-US']}, 베타`});
  expect(screen.getAllByRole('radio').map(row => row.props.accessibilityLabel)).toEqual(['기기 언어 따르기', '한국어, 베타', 'English, 베타']);
  expect(screen.getAllByText('베타')).toHaveLength(2);
  fireEvent.press(en);
  await waitFor(() => expect(screen.getByTestId('another-account')).toHaveTextContent('Language'));
  expect(en).toBeSelected();
  expect(screen.getAllByRole('radio').map(row => row.props.accessibilityLabel)).toEqual(['Use device language', '한국어, Beta', 'English, Beta']);
  expect(screen.getAllByText('Beta')).toHaveLength(2);
  expect(screen.getByText('Screens that are not yet translated appear in Korean.')).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
});

it('retains the old language on storage failure and retries the original selection inline', async () => {
  const write = jest.fn().mockImplementationOnce(() => { throw new Error('disk detail'); });
  const current = await controller({...port(), writePreference: write});
  const createController = async () => current;
  render(<ThemeProvider><MobileLocaleProvider createController={createController}><LanguageSettingsPage onBack={() => {}} /></MobileLocaleProvider></ThemeProvider>);
  fireEvent.press(await screen.findByRole('radio', {name: 'English, 베타'}));
  const retry = await screen.findByRole('button', {name: '다시 시도'});
  expect(current.getSnapshot().preference).toBe('system');
  expect(screen.queryByText('disk detail')).toBeNull();
  fireEvent.press(retry);
  await waitFor(() => expect(current.getSnapshot().preference).toBe('en-US'));
  expect(write).toHaveBeenNthCalledWith(2, 'en-US');
});

it('checks generated ko/en permission resources, Xcode registration and the complete Intl notices', () => {
  for (const script of ['generate-info-plist-strings.mjs', 'generate-intl-notices.mjs']) {
    expect(execFileSync(process.execPath, [path.join(__dirname, '../scripts', script), '--check'], {encoding: 'utf8'})).toContain('PASS');
  }
});
