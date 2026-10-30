import type { ReactNode } from "react";
import type { AppLocale } from "./localeStore";
import { LocaleContext } from "./localeContext";

export function LocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
