import type { AppLocale } from "./localeStore";

/** One set of installation listeners; never owned by a signed-in account. */
export function observeLocaleEnvironment(locale: AppLocale) {
  const refresh = () => { void locale.refresh(); };
  const resume = () => { if (document.visibilityState === "visible") refresh(); };
  window.addEventListener("languagechange", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", resume);
  return () => {
    window.removeEventListener("languagechange", refresh);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", resume);
  };
}
