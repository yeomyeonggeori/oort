// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMessageCatalog, type LocalePreferencePort } from "@momo/core/i18n";
import { chooseListbox, listboxChoices } from "@/design/ui/listboxTestKit";
import { LanguageRow } from "@/features/settings/LanguageRow";
import { LocaleProvider } from "./LocaleProvider";
import { browserLocalePort, createAppLocale, LOCALE_STORAGE_KEY, type AppLocale } from "./localeStore";
import { desktopMenuLabels } from "./desktopMenu";
import { observeLocaleEnvironment } from "./localeEnvironment";

let root: Root | undefined;
let host: HTMLDivElement;
const originalLanguages = navigator.languages;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "en-US";
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["ko-KR"] });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "languages", { configurable: true, value: originalLanguages });
});

function mount(locale: AppLocale) {
  root = createRoot(host);
  act(() => root!.render(<LocaleProvider locale={locale}><LanguageRow /></LocaleProvider>));
}
const trigger = () => host.querySelector<HTMLElement>('[role="combobox"]')!;
const memoryPort = (preference = "system", languages = ["ko-KR"]): LocalePreferencePort => ({
  readPreference: () => preference,
  writePreference: vi.fn(),
  readDevice: () => ({ languages, timeZone: "Asia/Seoul" }),
});

describe("installation locale (#4832)", () => {
  it("persists an explicit selection and restores it after a fresh adapter on a Korean device", async () => {
    const locale = await createAppLocale(browserLocalePort());
    expect(locale.service.context.messageLocale).toBe("ko-KR");
    await locale.setPreference("en-US");
    const restarted = await createAppLocale(browserLocalePort());
    expect(restarted.getSnapshot().preference).toBe("en-US");
    expect(restarted.service.formatMessage("settings.profile.languageLabel")).toBe("Language");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
  });

  it("sets html lang before the first screen and updates it immediately on selection", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "ko-KR");
    const locale = await createAppLocale(browserLocalePort());
    expect(document.documentElement.lang).toBe("ko-KR");
    mount(locale);
    expect(host.textContent).toContain("언어");
    await act(async () => { await locale.setPreference("en-US"); });
    expect(document.documentElement.lang).toBe("en-US");
    expect(host.textContent).toContain("Language");
    const html = readFileSync("index.html", "utf8");
    expect(html.indexOf('/src/i18n/boot.ts')).toBeLessThan(html.indexOf('<div id="root"'));
    const main = readFileSync("src/main.tsx", "utf8");
    expect(main).toContain('appLocaleReady,');
    expect(main).toContain('.then(([locale]) => render(locale))');
  });

  it("uses system for an absent, invalid, or unreadable preference and English for an unavailable catalog", async () => {
    const port = browserLocalePort();
    expect((await createAppLocale(port)).getSnapshot().preference).toBe("system");
    localStorage.setItem(LOCALE_STORAGE_KEY, "garbage");
    expect((await createAppLocale(port)).getSnapshot().preference).toBe("system");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect((await createAppLocale(port)).service.context.messageLocale).toBe("ko-KR");
    const unavailable = await createAppLocale(memoryPort("system", ["ja-JP", "ko-KR"]));
    expect(unavailable.service.context.messageLocale).toBe("en-US");
    const brokenDevice = memoryPort();
    brokenDevice.readDevice = () => { throw new Error("unavailable"); };
    expect((await createAppLocale(brokenDevice)).service.context.messageLocale).toBe("en-US");
  });

  it("keeps the last selection after failed storage and retries the write", async () => {
    const locale = await createAppLocale(browserLocalePort());
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await locale.setPreference("en-US");
    expect(locale.getSnapshot().status).toBe("error");
    expect(locale.service.context.messageLocale).toBe("ko-KR");
    write.mockRestore();
    await locale.retry();
    expect(locale.getSnapshot().status).toBe("ready");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
  });

  it("waits for the Korean chunk, reports failure, retries from the row and restores keyboard focus", async () => {
    const load = vi.fn(loadMessageCatalog);
    const locale = await createAppLocale(memoryPort("en-US"), { loadCatalog: load });
    expect(load).not.toHaveBeenCalled();
    mount(locale);
    let reject!: (error: Error) => void;
    load.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    let pending!: Promise<void>;
    await act(async () => { pending = locale.setPreference("ko-KR"); });
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(locale.service.context.messageLocale).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    await act(async () => { reject(new Error("offline")); await pending; });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load the language");
    const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Try again")!;
    let resolve!: (catalog: Awaited<ReturnType<typeof loadMessageCatalog>>) => void;
    load.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    retry.focus();
    await act(async () => { retry.click(); });
    expect(document.activeElement).toBe(retry);
    expect(retry.isConnected).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    await act(async () => { resolve(await loadMessageCatalog("ko-KR")); });
    expect(locale.getSnapshot().status).toBe("ready");
    expect(document.documentElement.lang).toBe("ko-KR");
    expect(document.activeElement).toBe(trigger());
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("recovers a failed Korean cold start using bundled English and an explicit retry", async () => {
    const load = vi.fn(loadMessageCatalog).mockRejectedValueOnce(new Error("offline"));
    const locale = await createAppLocale(memoryPort(), { loadCatalog: load });
    expect(locale.getSnapshot().status).toBe("error");
    expect(locale.service.context.messageLocale).toBe("en-US");
    mount(locale);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { await locale.retry(); });
    expect(locale.service.context.messageLocale).toBe("ko-KR");
  });

  it("offers only available autonyms with system first, no beta tag, and one partial-support line only in English", async () => {
    const locale = await createAppLocale(memoryPort("en-US"));
    mount(locale);
    expect(listboxChoices(trigger()).map(choice => [choice.value, choice.label])).toEqual([
      ["system", "Use device language"], ["ko-KR", "한국어"], ["en-US", "English"],
    ]);
    // Owner 10-31 (#4936): the beta tag is gone on the web too; the one line that is left says some screens are still Korean.
    expect(host.querySelector('[data-testid="language-partial-notice"]')?.textContent).toBe("Some screens are still in Korean.");
    expect(host.textContent).not.toMatch(/Beta|베타/);
    chooseListbox(trigger(), "ko-KR");
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="language-partial-notice"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Beta|베타/);
    expect(trigger().getAttribute("aria-labelledby")).toBe("profile-language-label");
  });

  it("reevaluates system on resume, retains explicit language and timezone, and serializes rapid changes", async () => {
    const port = memoryPort();
    const locale = await createAppLocale(port);
    port.readDevice = () => ({ languages: ["en-GB"], timeZone: "Asia/Seoul" });
    await locale.refresh();
    expect(locale.service.context.messageLocale).toBe("en-US");
    await Promise.all([locale.setPreference("ko-KR"), locale.setPreference("en-US")]);
    expect(locale.getSnapshot().preference).toBe("en-US");
    port.readDevice = () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" });
    await locale.refresh();
    expect(locale.service.context.messageLocale).toBe("en-US");
    expect(locale.service.context.timeZone).toBe("Asia/Seoul");
    const refresh = vi.spyOn(locale, "refresh");
    const stop = observeLocaleEnvironment(locale);
    window.dispatchEvent(new Event("languagechange"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(3);
    await locale.refresh();
  });

  it("uses the native port across restarts and sends ko/en catalog strings for the menu", async () => {
    let nativeStored = "system";
    const native = memoryPort();
    native.readPreference = async () => nativeStored;
    native.writePreference = async preference => { nativeStored = preference; };
    const menus: string[] = [];
    const syncMenu = vi.fn(async (service: AppLocale["service"]) => { menus.push(desktopMenuLabels(service).edit); });
    const locale = await createAppLocale(native, { syncMenu });
    await locale.setPreference("en-US");
    const restarted = await createAppLocale(native, { syncMenu });
    expect(restarted.getSnapshot().preference).toBe("en-US");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(menus).toEqual(["편집", "Edit", "Edit"]);
  });

  it("boots the Tauri shell from native settings and connects native writes and menus", async () => {
    const readLocalePreference = vi.fn().mockResolvedValue("ko-KR");
    const writeLocalePreference = vi.fn().mockResolvedValue(undefined);
    const setLocaleMenu = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/env", () => ({ IS_TAURI: true }));
    vi.doMock("@/lib/tauri", () => ({ readLocalePreference, writeLocalePreference, setLocaleMenu }));
    vi.doMock("./localeEnvironment", () => ({ observeLocaleEnvironment: vi.fn() }));
    try {
      const { appLocaleReady } = await import("./boot");
      const locale = await appLocaleReady;
      expect(readLocalePreference).toHaveBeenCalledOnce();
      expect(setLocaleMenu).toHaveBeenLastCalledWith(expect.objectContaining({ edit: "편집" }));
      await locale.setPreference("en-US");
      expect(writeLocalePreference).toHaveBeenCalledWith("en-US");
      expect(setLocaleMenu).toHaveBeenLastCalledWith(expect.objectContaining({ edit: "Edit" }));
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    } finally {
      vi.doUnmock("@/lib/env");
      vi.doUnmock("@/lib/tauri");
      vi.doUnmock("./localeEnvironment");
    }
  });
});
