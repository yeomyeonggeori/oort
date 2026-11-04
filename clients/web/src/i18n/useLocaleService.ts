import { useSyncExternalStore } from "react";
import {
  createLocaleService,
  resolveLocaleContext,
  type LocaleService,
} from "@momo/core/i18n";
import { useAppLocale } from "./localeContext";

// The whole language service of the installed locale (messages plus the context's date, time, number and
// currency formats), re-rendering the caller when the language changes. `useFormatMessage` returns only
// `formatMessage`; a screen that builds a sentence from a time in the viewer's own zone needs the rest, and
// takes it from the same installed service so both always agree. An isolated fixture that skipped bootstrap
// gets the bundled English service, like `useFormatMessage`.
let fixtureService: LocaleService | undefined;
function fixtureLocale(): LocaleService {
  fixtureService ??= createLocaleService(
    resolveLocaleContext("en-US", { languages: [] })
  );
  return fixtureService;
}

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function useLocaleService(): LocaleService {
  const locale = useAppLocale();
  useSyncExternalStore(
    locale ? locale.subscribe : noSubscription,
    locale ? locale.getSnapshot : noSnapshot,
    locale ? locale.getSnapshot : noSnapshot
  );
  return locale ? locale.service : fixtureLocale();
}
