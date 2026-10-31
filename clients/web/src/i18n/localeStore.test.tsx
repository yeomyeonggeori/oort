// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMessageCatalog, type LocalePreferencePort, type MessageCatalog } from "@momo/core/i18n";
import { chooseListbox, listboxChoices } from "@/design/ui/listboxTestKit";
import { LanguageRow } from "@/features/settings/LanguageRow";
import { LocaleProvider } from "./LocaleProvider";
import { browserLocalePort, createAppLocale, LOCALE_STORAGE_KEY, type AppLocale, type AvailableLocale } from "./localeStore";
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
  vi.useRealTimers();
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

/** A port that really keeps what was written, so "the next boot" can read it back. */
const storedPort = (initial = "system", languages = ["ko-KR"]) => {
  const state = { stored: initial as unknown, order: [] as string[] };
  const port: LocalePreferencePort = {
    readPreference: () => state.stored,
    writePreference: vi.fn(async preference => { state.order.push(`write:${preference}`); state.stored = preference; }),
    readDevice: () => ({ languages, timeZone: "Asia/Seoul" }),
  };
  return { port, state };
};

/**
 * What a browser does with `import()`, reduced to the one rule this ticket is about
 * (HTML "fetch a single module script"): the module map holds one entry per URL, a
 * failed entry stays failed until there is a new document, and a request that has not
 * answered yet is the pending entry that a second `import()` joins. `behavior` decides
 * how the next *new* request ends. The mocks the earlier tests used answered the second
 * call afresh, which no browser does, so they could not fail on this bug.
 */
function moduleMap(korean: MessageCatalog) {
  type Held = { answer(): void; fail(): void };
  const entries = new Map<AvailableLocale, Promise<MessageCatalog>>();
  const requests: AvailableLocale[] = [];
  let next: "answer" | "reject" | "hang" = "answer";
  let held: Held | undefined;
  return {
    requests,
    behavior(value: typeof next) { next = value; },
    held: () => held!,
    load(locale: AvailableLocale): Promise<MessageCatalog> {
      let entry = entries.get(locale);
      if (!entry) {
        requests.push(locale);
        if (next === "hang") {
          entry = new Promise<MessageCatalog>((resolve, reject) => {
            held = { answer: () => resolve(korean), fail: () => reject(new TypeError("Failed to fetch dynamically imported module")) };
          });
        } else if (next === "reject") {
          entry = Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
        } else {
          entry = Promise.resolve(korean);
        }
        entries.set(locale, entry);
      }
      return entry;
    },
    /** Reloading the page: the module map starts empty. */
    newDocument() { entries.clear(); },
  };
}

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

  it("keeps the last selection after failed storage and retries the write in place, never by reloading", async () => {
    const reload = vi.fn();
    const locale = await createAppLocale(browserLocalePort(), { reload });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await locale.setPreference("en-US");
    expect(locale.getSnapshot().status).toBe("error");
    expect(locale.getSnapshot().needsReload).toBe(false);
    expect(locale.service.context.messageLocale).toBe("ko-KR");
    write.mockRestore();
    await locale.retry();
    expect(locale.getSnapshot().status).toBe("ready");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for the Korean chunk within the budget, retries a wait that ran out in place and restores keyboard focus", async () => {
    const load = vi.fn(loadMessageCatalog);
    const reload = vi.fn();
    const locale = await createAppLocale(memoryPort("en-US"), { loadCatalog: load, catalogBudgetMs: 30, reload });
    expect(load).not.toHaveBeenCalled();
    mount(locale);
    load.mockImplementationOnce(() => new Promise(() => {}));
    let pending!: Promise<void>;
    await act(async () => { pending = locale.setPreference("ko-KR"); });
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(locale.service.context.messageLocale).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    // The request never answers; the budget ends the wait instead of the browser's own deadline.
    // (Raced against a real timer only so that a missing budget fails here, not by hanging.)
    await act(async () => { await Promise.race([pending, new Promise(done => setTimeout(done, 300))]); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load the language");
    const labels = Array.from(host.querySelectorAll("button")).map(button => button.textContent);
    expect(labels).toContain("Try again");
    expect(labels).not.toContain("Reload");
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
    expect(reload).not.toHaveBeenCalled();
  });

  it("after a chunk the browser rejected on a cold start the row says Reload, and the reload makes a new request that opens in Korean", async () => {
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("reject");
    const { port, state } = storedPort();
    const reload = vi.fn(() => { state.order.push("reload"); browser.newDocument(); });
    const locale = await createAppLocale(port, { loadCatalog: browser.load, reload });
    expect(locale.getSnapshot()).toMatchObject({ status: "error", hasError: true, needsReload: true });
    expect(locale.service.context.messageLocale).toBe("en-US");
    mount(locale);
    const labels = Array.from(host.querySelectorAll("button")).map(button => button.textContent);
    expect(labels).toContain("Reload");
    expect(labels).not.toContain("Try again");
    // The network is back, but this document still holds the failed entry: asking again cannot reach it.
    browser.behavior("answer");
    await act(async () => { await locale.refresh(); });
    expect(reload).not.toHaveBeenCalled();
    expect(locale.getSnapshot()).toMatchObject({ status: "error", needsReload: true });
    expect(browser.requests).toEqual(["ko-KR"]);
    await act(async () => { Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Reload")!.click(); });
    expect(reload).toHaveBeenCalledOnce();
    expect(browser.requests).toEqual(["ko-KR"]);
    // The next document is a new boot: a new request, and the app comes back in Korean.
    const next = await createAppLocale(port, { loadCatalog: browser.load, reload });
    expect(browser.requests).toEqual(["ko-KR", "ko-KR"]);
    expect(next.getSnapshot()).toMatchObject({ status: "ready", needsReload: false });
    expect(next.service.context.messageLocale).toBe("ko-KR");
    expect(next.service.formatMessage("settings.profile.languageLabel")).toBe("언어");
  });

  it("stores the language the person picked before reloading, so the next boot opens in it and the menu follows", async () => {
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("reject");
    const { port, state } = storedPort("en-US");
    const menus: string[] = [];
    const syncMenu = vi.fn(async (service: AppLocale["service"]) => { menus.push(desktopMenuLabels(service).edit); });
    const reload = vi.fn(() => { state.order.push("reload"); browser.newDocument(); });
    const locale = await createAppLocale(port, { loadCatalog: browser.load, reload, syncMenu });
    mount(locale);
    chooseListbox(trigger(), "ko-KR");
    await vi.waitFor(() => expect(locale.getSnapshot().status).toBe("error"));
    expect(locale.getSnapshot()).toMatchObject({ needsReload: true, preference: "en-US" });
    expect(state.stored).toBe("en-US");
    await act(async () => { await locale.retry(); });
    expect(state.order).toEqual(["write:ko-KR", "reload"]);
    browser.behavior("answer");
    const next = await createAppLocale(port, { loadCatalog: browser.load, syncMenu });
    expect(next.getSnapshot().preference).toBe("ko-KR");
    expect(next.service.context.messageLocale).toBe("ko-KR");
    expect(menus).toEqual(["Edit", "편집"]);
  });

  it("does not reload when the choice cannot be stored first", async () => {
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("reject");
    const { port } = storedPort("en-US");
    const reload = vi.fn();
    const locale = await createAppLocale(port, { loadCatalog: browser.load, reload });
    await locale.setPreference("ko-KR");
    expect(locale.getSnapshot().needsReload).toBe(true);
    vi.mocked(port.writePreference).mockRejectedValueOnce(new Error("disk full"));
    await locale.retry();
    expect(reload).not.toHaveBeenCalled();
    // The chunk is as dead as before, so the button stays "Reload" and the next click goes straight to the reload.
    expect(locale.getSnapshot()).toMatchObject({ status: "error", needsReload: true });
    await locale.retry();
    expect(reload).toHaveBeenCalledOnce();
    expect(browser.requests).toEqual(["ko-KR"]);
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

describe("dictionary chunk budget (#4915)", () => {
  const BUDGET = 2_500;
  const boot = (port: LocalePreferencePort, extra: Parameters<typeof createAppLocale>[1] = {}) => {
    let settled = false;
    const booting = createAppLocale(port, { catalogBudgetMs: BUDGET, ...extra }).then(locale => { settled = true; return locale; });
    return {
      settled: () => settled,
      /** The locale, asserting first that boot ended, so a missing budget fails here instead of hanging. */
      async locale() { expect(settled).toBe(true); return booting; },
    };
  };

  it("holds the first screen no longer than the budget, then opens in bundled English with the retry offered", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("hang");
    const { settled, locale: ready } = boot(memoryPort(), { loadCatalog: browser.load });
    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const locale = await ready();
    expect(locale.getSnapshot()).toMatchObject({ status: "error", hasError: true, needsReload: false });
    expect(locale.service.context.messageLocale).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(browser.requests).toEqual(["ko-KR"]);
    mount(locale);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load the language");
    expect(Array.from(host.querySelectorAll("button")).map(button => button.textContent)).toContain("Try again");
  });

  it("applies a chunk that lands after the budget by itself, with no second request", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("hang");
    const { port } = storedPort();
    const { locale: ready } = boot(port, { loadCatalog: browser.load });
    await vi.advanceTimersByTimeAsync(BUDGET);
    const locale = await ready();
    expect(locale.getSnapshot().status).toBe("error");
    browser.held().answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(locale.getSnapshot()).toMatchObject({ status: "ready", hasError: false, needsReload: false });
    expect(locale.service.context.messageLocale).toBe("ko-KR");
    expect(document.documentElement.lang).toBe("ko-KR");
    expect(browser.requests).toEqual(["ko-KR"]);
  });

  it("applies and then stores a language the person picked when its chunk lands after the budget", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    const { port, state } = storedPort("en-US");
    const locale = await createAppLocale(port, { loadCatalog: browser.load, catalogBudgetMs: BUDGET });
    browser.behavior("hang");
    let chose = false;
    const picking = locale.setPreference("ko-KR").then(() => { chose = true; });
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(chose).toBe(true);
    await picking;
    expect(locale.getSnapshot().status).toBe("error");
    expect(state.stored).toBe("en-US");
    browser.held().answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(locale.getSnapshot()).toMatchObject({ status: "ready", preference: "ko-KR", needsReload: false });
    expect(locale.service.context.messageLocale).toBe("ko-KR");
    expect(document.documentElement.lang).toBe("ko-KR");
    expect(state.stored).toBe("ko-KR");
    expect(browser.requests).toEqual(["ko-KR"]);
  });

  it("does not apply a late chunk over a language the person chose in the meantime", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    const { port, state } = storedPort("en-US");
    const locale = await createAppLocale(port, { loadCatalog: browser.load, catalogBudgetMs: BUDGET });
    browser.behavior("hang");
    let chose = false;
    const korean = locale.setPreference("ko-KR").then(() => { chose = true; });
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(chose).toBe(true);
    await korean;
    expect(locale.getSnapshot().status).toBe("error");
    await locale.setPreference("en-US");
    browser.held().answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(locale.getSnapshot()).toMatchObject({ status: "ready", preference: "en-US" });
    expect(locale.service.context.messageLocale).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(state.stored).toBe("en-US");
  });

  it("retries a wait that ran out by asking again, which joins the pending request; reload is for rejected imports only", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("hang");
    const reload = vi.fn();
    const { locale: ready } = boot(memoryPort(), { loadCatalog: browser.load, reload });
    await vi.advanceTimersByTimeAsync(BUDGET);
    const locale = await ready();
    const retrying = locale.retry();
    browser.held().answer();
    await vi.advanceTimersByTimeAsync(0);
    await retrying;
    expect(reload).not.toHaveBeenCalled();
    expect(browser.requests).toEqual(["ko-KR"]);
    expect(locale.getSnapshot().status).toBe("ready");
    expect(locale.service.context.messageLocale).toBe("ko-KR");
  });

  it("turns the retry into a reload when the request that ran out later fails, and leaves the network alone", async () => {
    vi.useFakeTimers();
    const browser = moduleMap(await loadMessageCatalog("ko-KR"));
    browser.behavior("hang");
    const reload = vi.fn();
    const { locale: ready } = boot(memoryPort(), { loadCatalog: browser.load, reload });
    await vi.advanceTimersByTimeAsync(BUDGET);
    const locale = await ready();
    expect(locale.getSnapshot().needsReload).toBe(false);
    browser.held().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(locale.getSnapshot()).toMatchObject({ status: "error", needsReload: true });
    await locale.retry();
    expect(reload).toHaveBeenCalledOnce();
    expect(browser.requests).toEqual(["ko-KR"]);
  });
});
