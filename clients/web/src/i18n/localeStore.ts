import {
  createLocalePreferences, createLocaleService, loadMessageCatalog,
  resolveLocaleContext, type LocalePreference, type LocalePreferencePort,
  type LocaleContext, type MessageCatalog,
} from "@momo/core/i18n";
import { LOCALE_CATALOG_BUDGET_MS } from "@/app/boot";

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
  /**
   * The error is a chunk import the browser rejected (#4915). A browser keeps a
   * failed `import()` for the life of the document, so asking again for the same
   * URL cannot reach the network; `retry()` therefore reloads the page.
   */
  needsReload: boolean;
}

/** Thrown into `change()` when the dictionary chunk is still pending at the budget. */
const CATALOG_PENDING = new Error("locale-catalog-pending");

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

/**
 * Owns one installation, outside all account/workspace providers.
 *
 * The Korean chunk is the only network input, and two browser facts shape how it
 * is loaded (#4915):
 *
 * 1. A load that has not answered holds the first screen, so every chunk wait is
 *    bounded by `catalogBudgetMs` (app/boot.ts says why that number). The request
 *    is never cancelled: a chunk that lands after the budget is applied when it
 *    arrives, unless the person chose something else in the meantime.
 * 2. A browser remembers a *failed* `import()` per URL for the life of the
 *    document, and the hashed chunk URL is not known at run time (it is a literal
 *    inside the entry chunk), so a second `import()` of it never reaches the
 *    network. An unanswered request is different: it is still the pending map
 *    entry, and asking again joins it. So an over-budget wait is retried in
 *    place, and a rejected import is retried by reloading the page.
 */
export async function createAppLocale(
  port: LocalePreferencePort,
  options: {
    loadCatalog?: (locale: AvailableLocale) => Promise<MessageCatalog>;
    applyLang?: (locale: string) => void;
    syncMenu?: (locale: ReturnType<typeof createLocaleService>) => Promise<void>;
    /** How long one chunk wait may hold `change()`. Defaults to the boot budget. */
    catalogBudgetMs?: number;
    /** Starts a new document. Only `retry()` after a rejected import calls it. */
    reload?: () => void;
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
  const budgetMs = options.catalogBudgetMs ?? LOCALE_CATALOG_BUDGET_MS;
  const reload = options.reload ?? (() => { window.location.reload(); });
  let snapshot: LocaleSnapshot = {
    preference: initial.preference, context: fallback, status: "loading", hasError: false, needsReload: false,
  };
  let retryPreference = initial.preference;
  let needsReload = false;
  // Counts `change()` calls. A chunk that lands late is applied only if nobody asked for anything since.
  let latest = 0;
  const listeners = new Set<() => void>();
  const publish = (status: LocaleSnapshot["status"]) => {
    const hasError = status === "error" || (status === "loading" && snapshot.hasError);
    snapshot = {
      preference: preferences.getSnapshot().preference, context: service.context, status,
      hasError, needsReload: hasError && needsReload,
    };
    listeners.forEach(listener => listener());
  };
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const work = queue.then(run);
    queue = work;
    return work;
  };
  /** Waits for the chunk at most `budgetMs`; the request itself keeps running. */
  const loadWithinBudget = (
    locale: AvailableLocale, ticket: number, preference: LocalePreference, persist: boolean,
  ) => {
    let pending: Promise<MessageCatalog>;
    try { pending = load(locale); }
    catch (error) { pending = Promise.reject(error); }
    return new Promise<MessageCatalog>((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => { late = true; reject(CATALOG_PENDING); }, budgetMs);
      pending.then(
        catalog => {
          clearTimeout(timer);
          if (!late) resolve(catalog);
          else if (ticket === latest) void change(preference, persist);
        },
        error => {
          clearTimeout(timer);
          if (!late) { reject(error); return; }
          // It failed after the screen moved on: from here on only a new document can ask again.
          if (ticket === latest) { needsReload = true; publish(snapshot.status); }
        },
      );
    });
  };
  /**
   * `restart`: a rejected import cannot be asked again in this document, so the
   * retry is a new document. The choice is stored first, because the next boot
   * reads it and loads the chunk again, which is what "try again" meant.
   * Everywhere else the catalog arrives before the choice is stored; this is the
   * one exception, and a boot that fails again lands in the ordinary cold-start
   * fallback. It runs inside the same queue and error path as any other change.
   */
  const change = (preference: LocalePreference, persist: boolean, restart = false): Promise<void> => {
    const ticket = ++latest;
    return enqueue(async () => {
      retryPreference = preference;
      publish("loading");
      let rejected = false;
      try {
        if (restart) {
          const kept = preferences.getSnapshot().preference === preference || await preferences.setPreference(preference);
          if (!kept) throw new Error("locale-write-failed");
          reload();
          return;
        }
        if (!persist) await preferences.refresh();
        const context = persist
          ? resolveLocaleContext(preference, readDevice())
          : preferences.getSnapshot().context;
        const messageLocale = catalogLocale(context);
        // English already ships in core's service. Only Korean needs a network chunk.
        const catalog = messageLocale === "ko-KR"
          ? await loadWithinBudget(messageLocale, ticket, preference, persist).catch((error: unknown) => {
            rejected = error !== CATALOG_PENDING;
            throw error;
          })
          : undefined;
        if (persist && !await preferences.setPreference(preference)) throw new Error("locale-write-failed");
        service.updateContext({ ...context, messageLocale, catalog });
        applyLang(messageLocale);
        await options.syncMenu?.(service);
        needsReload = false;
        publish("ready");
      } catch {
        // Keep the last usable catalog and expose a retry, including on cold start.
        // A restart that could not store the choice leaves the chunk as dead as it was: still "Reload".
        needsReload = rejected || restart;
        applyLang(service.context.messageLocale);
        publish("error");
      }
    });
  };
  await change(initial.preference, false);
  return {
    service,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPreference: (preference: LocalePreference) => change(preference, true),
    retry: () => change(retryPreference, true, needsReload),
    refresh: () => change(preferences.getSnapshot().preference, false),
  };
}
export type AppLocale = Awaited<ReturnType<typeof createAppLocale>>;
