import { useSyncExternalStore } from "react";
import {
  createLocaleService,
  resolveLocaleContext,
  type LocaleService,
} from "@momo/core/i18n";
import { useAppLocale } from "./localeContext";

// The message formatter of the installed locale, re-rendering the caller when the language
// changes (the same subscription `LanguageRow` makes). Only an isolated fixture that skipped
// bootstrap reaches the fallback: `main.tsx` mounts the real locale before the first screen.
// The English dictionary ships inside core, so the fallback needs no network and carries no
// text of its own.
let fixtureService: LocaleService | undefined;
function fixtureLocale(): LocaleService {
  fixtureService ??= createLocaleService(
    resolveLocaleContext("en-US", { languages: [] })
  );
  return fixtureService;
}

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function useFormatMessage(): LocaleService["formatMessage"] {
  const locale = useAppLocale();
  useSyncExternalStore(
    locale ? locale.subscribe : noSubscription,
    locale ? locale.getSnapshot : noSnapshot,
    locale ? locale.getSnapshot : noSnapshot
  );
  return (locale ? locale.service : fixtureLocale()).formatMessage;
}
