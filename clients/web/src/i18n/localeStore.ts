import {
  createLocalePreferences, createLocaleService, loadMessageCatalog,
  resolveLocaleContext, type LocalePreference, type LocalePreferencePort,
  type LocaleContext, type MessageCatalog,
} from "@momo/core/i18n";

export const LOCALE_STORAGE_KEY = "oort.locale.preference";
export const availableLocales = ["ko-KR", "en-US"] as const;
export type AvailableLocale = typeof availableLocales[number];
const catalogLocale = (context: LocaleContext): AvailableLocale =>
  context.messageLocale === "ko-KR" ? "ko-KR" : "en-US";

export interface LocaleSnapshot {
  preference: LocalePreference;
  context: LocaleContext;
  status: "ready" | "loading" | "error";
  hasError: boolean;
}

/** This origin owns the web preference; never cleared by account/session teardown. */
export function browserLocalePort(): LocalePreferencePort {
  return {
    readPreference() {
      try { return localStorage.getItem(LOCALE_STORAGE_KEY); }
      catch { return "system"; }
    },
    writePreference(preference) {
      // Propagate a failed write so core keeps the last persisted choice active.
      try { localStorage.setItem(LOCALE_STORAGE_KEY, preference); }
      catch { throw new Error("locale-storage-unavailable"); }
    },
    readDevice() {
      const options = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
      return { languages: navigator.languages, timeZone: options.timeZone, hourCycle: options.hourCycle };
    },
  };
}

/** Owns one installation, outside all account/workspace providers. */
export async function createAppLocale(
  port: LocalePreferencePort,
  options: {
    loadCatalog?: (locale: AvailableLocale) => Promise<MessageCatalog>;
    applyLang?: (locale: string) => void;
    syncMenu?: (locale: ReturnType<typeof createLocaleService>) => Promise<void>;
  } = {},
) {
  const preferences = await createLocalePreferences(port);
  const initial = preferences.getSnapshot();
  const readDevice = () => {
    try { return port.readDevice(); }
    catch { return { languages: [] }; }
  };
  const fallback = resolveLocaleContext("en-US", readDevice());
  const service = createLocaleService(fallback);
  const applyLang = options.applyLang ?? (locale => { document.documentElement.lang = locale; });
  const load = options.loadCatalog ?? loadMessageCatalog;
  let snapshot: LocaleSnapshot = { preference: initial.preference, context: fallback, status: "loading", hasError: false };
  let retryPreference = initial.preference;
  const listeners = new Set<() => void>();
  const publish = (status: LocaleSnapshot["status"]) => {
    snapshot = {
      preference: preferences.getSnapshot().preference, context: service.context, status,
      hasError: status === "error" || (status === "loading" && snapshot.hasError),
    };
    listeners.forEach(listener => listener());
  };
  let queue: Promise<unknown> = Promise.resolve();
  const change = (preference: LocalePreference, persist: boolean): Promise<void> => {
    const work = queue.then(async () => {
      retryPreference = preference;
      publish("loading");
      try {
        if (!persist) await preferences.refresh();
        const context = persist
          ? resolveLocaleContext(preference, readDevice())
          : preferences.getSnapshot().context;
        const messageLocale = catalogLocale(context);
        // English already ships in core's service. Only Korean needs a network chunk.
        const catalog = messageLocale === "ko-KR" ? await load(messageLocale) : undefined;
        if (persist && !await preferences.setPreference(preference)) throw new Error("locale-write-failed");
        service.updateContext({ ...context, messageLocale, catalog });
        applyLang(messageLocale);
        await options.syncMenu?.(service);
        publish("ready");
      } catch {
        // Keep the last usable catalog and expose a retry, including on cold start.
        applyLang(service.context.messageLocale);
        publish("error");
      }
    });
    queue = work;
    return work;
  };
  await change(initial.preference, false);
  return {
    service,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPreference: (preference: LocalePreference) => change(preference, true),
    retry: () => change(retryPreference, true),
    refresh: () => change(preferences.getSnapshot().preference, false),
  };
}
export type AppLocale = Awaited<ReturnType<typeof createAppLocale>>;
