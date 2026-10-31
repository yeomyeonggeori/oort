import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppLocale } from "./localeStore";

export const LocaleContext = createContext<AppLocale | null>(null);

export function useAppLocale() {
  // Isolated surface fixtures can render without application bootstrap.
  return useContext(LocaleContext);
}

export function useLocaleSnapshot(locale: AppLocale) {
  return useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot);
}
