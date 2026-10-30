import {
  createLocalePreferences,
  createLocaleService,
  loadMessageCatalog,
  resolveLocaleContext,
  type CatalogLocale,
  type LocalePreference,
  type LocalePreferenceDiagnostic,
  type LocalePreferencePort,
  type LocalePreferenceSnapshot,
  type LocaleService,
} from '@momo/core/i18n';
import {initializeMobileIntl} from './intl';

export type MobileLocaleDiagnosticCode = LocalePreferenceDiagnostic['code']
  | 'mobile-intl-initialization-failed' | 'mobile-locale-initialization-failed';
export interface MobileLocaleSnapshot {
  readonly preference: LocalePreference;
  readonly effectiveLocale: CatalogLocale;
  readonly locale: LocaleService;
}
export interface MobileLocaleController {
  getSnapshot(): MobileLocaleSnapshot;
  subscribe(listener: () => void): () => void;
  setPreference(preference: LocalePreference): Promise<boolean>;
  refresh(): Promise<void>;
  dispose(): void;
}

/** Intl → both offline catalogs → stored preference → service → render, in that order. */
export async function createMobileLocaleController(options: {
  port: LocalePreferencePort;
  initializeIntl?: () => void | Promise<void>;
  observeDevice?: (onChange: () => void) => () => void;
  onDiagnostic?: (diagnostic: {code: MobileLocaleDiagnosticCode}) => void;
}): Promise<MobileLocaleController> {
  const diagnostic = (code: MobileLocaleDiagnosticCode) => {
    try { options.onDiagnostic?.({code}); } catch { /* Redacted observers cannot interrupt boot. */ }
  };
  try { await (options.initializeIntl ?? initializeMobileIntl)(); }
  catch {
    diagnostic('mobile-intl-initialization-failed');
    throw new Error('mobile-intl-initialization-failed');
  }
  try {
    const [ko, en] = await Promise.all([loadMessageCatalog('ko-KR'), loadMessageCatalog('en-US')]);
    let bootFailed = false;
    const preferences = await createLocalePreferences(options.port, {onDiagnostic: entry => {
      diagnostic(entry.code);
      // An unreadable stored choice continues as `system` (the device language), exactly as the core does,
      // and is only reported: it must not shut the whole app behind the English safe screen. With no device
      // language there is nothing to start from, so that alone stops boot.
      if (entry.code === 'device-read-failed') bootFailed = true;
    }});
    if (bootFailed) throw new Error('mobile-locale-initialization-failed');
    const resolve = (value: LocalePreferenceSnapshot): MobileLocaleSnapshot => {
      const effectiveLocale = value.context.messageLocale === 'ko-KR' ? 'ko-KR' : 'en-US';
      // Unshipped OS languages use English; preserve their region/timezone/hour/week facts.
      const context = value.context.messageLocale === effectiveLocale ? value.context
        : resolveLocaleContext(effectiveLocale, {
          languages: [value.context.formatLocale], timeZone: value.context.timeZone,
          hourCycle: value.context.hourCycle, weekStartsOn: value.context.weekStartsOn,
        });
      return Object.freeze({
        preference: value.preference, effectiveLocale,
        locale: createLocaleService({...context, catalog: effectiveLocale === 'ko-KR' ? ko : en}),
      });
    };
    let snapshot = resolve(preferences.getSnapshot());
    const listeners = new Set<() => void>();
    const unsubscribe = preferences.subscribe(value => {
      snapshot = resolve(value);
      for (const listener of listeners) listener();
    });
    const stopDevice = options.observeDevice?.(() => { void preferences.refresh(); });
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      setPreference: preference => preferences.setPreference(preference),
      refresh: () => preferences.refresh(),
      dispose() { stopDevice?.(); unsubscribe(); listeners.clear(); },
    };
  } catch {
    diagnostic('mobile-locale-initialization-failed');
    throw new Error('mobile-locale-initialization-failed');
  }
}
