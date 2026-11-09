// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { languageChoices, type LocalePreferencePort } from "@momo/core/i18n";
import { availableLocales, createAppLocale } from "./localeStore";
import { loadPseudoCatalog, PSEUDO_LOCALE_BUILD, pseudoLocaleRequested } from "./pseudoLocale";

const port = (): LocalePreferencePort => ({
  readPreference: () => "ko-KR",
  writePreference: vi.fn(),
  readDevice: () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" }),
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("pseudo locale en-XA (#5589)", () => {
  it("is never a language a person can pick: the list stays ko/en until P2 review", () => {
    expect([...availableLocales]).toEqual(["ko-KR", "en-US"]);
    const offered = languageChoices(availableLocales).map(choice => choice.preference);
    expect(offered).toEqual(["system", "ko-KR", "en-US"]);
  });

  it("turns on with ?pseudo=1 for the tab, stays on across navigation, and ?pseudo=0 turns it off", () => {
    expect(PSEUDO_LOCALE_BUILD).toBe(true); // vitest runs as a development build
    const storage = memoryStorage();
    expect(pseudoLocaleRequested("", storage)).toBe(false);
    expect(pseudoLocaleRequested("?channel=1&pseudo=1", storage)).toBe(true);
    expect(pseudoLocaleRequested("", storage)).toBe(true);
    expect(pseudoLocaleRequested("?pseudo=0", storage)).toBe(false);
    expect(pseudoLocaleRequested("?pseudos=1", storage)).toBe(false);
  });

  it("renders dictionary text bracketed and ~35% longer, with html lang en-XA", async () => {
    let lang = "";
    const locale = await createAppLocale(port(), { pseudo: loadPseudoCatalog, applyLang: value => { lang = value; } });
    const label = locale.service.formatMessage("settings.profile.languageLabel");
    expect(label).toMatch(/^\[Ľáñğúáğé~+\]$/);
    expect(locale.service.formatMessage("common.members.count", { count: 3 })).toMatch(/^\[3 .*\]$/);
    expect(lang).toBe("en-XA");
    expect(locale.getSnapshot().status).toBe("ready");
  });
});
