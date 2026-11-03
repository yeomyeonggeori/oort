// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMessageCatalog, type LocalePreferencePort } from "@momo/core/i18n";
import { listboxChoices } from "@/design/ui/listboxTestKit";
import { LanguageRow } from "@/features/settings/LanguageRow";
import { LanguageChip } from "./LanguageChip";
import { LocaleProvider } from "./LocaleProvider";
import { browserLocalePort, createAppLocale, LOCALE_STORAGE_KEY, type AppLocale } from "./localeStore";

// =============================================================================
// 첫 화면의 언어 칩 (#4670): 칩 → 목록 → 즉시 반영, 그리고 **설정의 언어 행과 같은 값**.
//
// 한 `LocaleProvider` 아래에 칩과 설정의 `LanguageRow`를 함께 그린다. 칩에서 고른 뒤
// 설정 행이 같은 값을 말하고, 같은 저장소 칸에 같은 글자가 적혀 있고, 두 곳의 선택지가 같은
// 목록인지를 잰다. 칩이 따로 저장하거나 따로 목록을 들고 있으면 이 단정이 깨진다.
// =============================================================================

let root: Root | undefined;
let host: HTMLDivElement;
const originalLanguages = navigator.languages;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix가 쓰는 브라우저 API(jsdom에 없음).
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "ko-KR";
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
  act(() =>
    root!.render(
      <LocaleProvider locale={locale}>
        <LanguageChip />
        <LanguageRow />
      </LocaleProvider>
    )
  );
}

const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
  document.querySelector<T>(`[data-testid="${testId}"]`);
const chip = () => q("language-chip")!;
const option = (value: string) =>
  document.querySelector<HTMLElement>(`[data-testid="language-chip-option"][data-value="${value}"]`);
const chipName = () => q("language-chip-name")?.textContent;
const settingsRow = () => host.querySelector<HTMLElement>("#profile-language")!;

function openChip() {
  chip().focus();
  act(() => {
    chip().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(q("language-chip-menu")).not.toBeNull();
}

async function pick(value: string) {
  const item = option(value);
  expect(item, value).not.toBeNull();
  await act(async () => {
    item!.click();
  });
}

const memoryPort = (preference = "system"): LocalePreferencePort => ({
  readPreference: () => preference,
  writePreference: vi.fn(),
  readDevice: () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" }),
});

describe("언어 칩 (#4670)", () => {
  it("칩에서 고르면 바로 바뀌고, 설정의 언어 행이 같은 값·같은 저장소를 말한다", async () => {
    const locale = await createAppLocale(browserLocalePort());
    mount(locale);
    expect(chipName()).toBe("한국어");
    expect(chip().getAttribute("aria-label")).toBe("현재 언어: 한국어");

    openChip();
    await pick("en-US");

    // 설정의 언어 행이 쓰는 바로 그 저장소 칸에 같은 글자가 적혔다.
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(chipName()).toBe("English");
    expect(chip().getAttribute("aria-label")).toBe("Current language: English");
    // 같은 앱 언어 객체를 설정 행도 읽는다: 행의 값과 제목이 함께 바뀌었다.
    expect(settingsRow().dataset.value).toBe("en-US");
    expect(settingsRow().textContent).toContain("English");
    expect(host.textContent).toContain("Language");
    // 고른 뒤 목록은 닫힌다.
    expect(q("language-chip-menu")).toBeNull();

    // 다시 열면 영어 UI에서만 서는 부분 지원 한 줄이 보이고, 고른 줄에 표시가 있다.
    openChip();
    expect(q("language-chip-partial-notice")?.textContent).toBe("Some screens are still in Korean.");
    expect(option("en-US")?.getAttribute("aria-checked")).toBe("true");
    expect(option("ko-KR")?.getAttribute("aria-checked")).toBe("false");
  });

  it("칩의 선택지는 설정 행의 선택지와 같은 목록이다(기기 언어 따르기 + 사전이 있는 언어)", async () => {
    const locale = await createAppLocale(browserLocalePort());
    mount(locale);
    const settings = listboxChoices(settingsRow()).map((choice) => ({ value: choice.value, label: choice.label }));
    openChip();
    const inChip = [...document.querySelectorAll<HTMLElement>('[data-testid="language-chip-option"]')].map(
      (item) => ({ value: item.dataset.value!, label: item.textContent ?? "" })
    );
    expect(settings.map((choice) => choice.value)).toEqual(["system", "ko-KR", "en-US"]);
    expect(inChip).toEqual(settings);
  });

  it("사전을 못 불러오면 저장하지 않고 목록을 연 채 이유와 다시 시도를 말한다", async () => {
    const reload = vi.fn();
    const locale = await createAppLocale(memoryPort("en-US"), {
      loadCatalog: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      reload,
    });
    mount(locale);
    openChip();
    await pick("ko-KR");
    expect(locale.getSnapshot()).toMatchObject({ status: "error", needsReload: true, preference: "en-US" });
    expect(q("language-chip-menu")).not.toBeNull();
    expect(q("language-chip-error")?.textContent).toContain("Could not load the language");
    expect(q("language-chip-retry")?.textContent).toBe("Reload");
    expect(chipName()).toBe("English");
    expect(reload).not.toHaveBeenCalled();
  });

  it("앱 언어가 없는 독립 fixture에서는 머리 줄 칸만 지킨다", () => {
    root = createRoot(host);
    act(() => root!.render(<LanguageChip />));
    expect(q("language-chip")).toBeNull();
    expect(host.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });
});

// loadMessageCatalog를 쓰는 기본 경로도 한 번은 실제 사전으로 확인한다.
describe("언어 칩과 실제 사전", () => {
  it("영어를 고른 뒤 한국어로 되돌리면 한국어 사전이 다시 쓰인다", async () => {
    const locale = await createAppLocale(browserLocalePort(), { loadCatalog: loadMessageCatalog });
    mount(locale);
    openChip();
    await pick("en-US");
    openChip();
    await pick("ko-KR");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ko-KR");
    expect(chipName()).toBe("한국어");
    expect(host.textContent).toContain("언어");
  });
});
