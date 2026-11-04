import { createAppLocale, type AppLocale } from "./localeStore";

/**
 * A Korean `AppLocale` for tests of screens that read the dictionary: the real catalog, no
 * storage, and no write to `<html lang>` (so it also works in the node environment).
 * Without a provider such a screen falls back to the English dictionary.
 */
export function koreanLocaleForTest(): Promise<AppLocale> {
  return createAppLocale(
    {
      readPreference: () => "ko-KR",
      writePreference: () => {},
      readDevice: () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" }),
    },
    { applyLang: () => {} }
  );
}
