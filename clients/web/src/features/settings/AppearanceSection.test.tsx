// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "./AppearanceSection";
import {
  APPEARANCE_STORAGE_KEY,
  ACCENT_THEMES,
  getAccent,
  getAppearance,
  getTheme,
  reloadAppearanceForTest,
  THEME_STORAGE_KEY,
  updateAppearance,
} from "@/design/theme";
import {
  LINK_PREVIEW_STORAGE_KEY,
  reloadLinkPreviewPreferenceForTest,
} from "@/features/timeline/linkPreviewPreference";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
  reloadLinkPreviewPreferenceForTest(localStorage);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  localStorage.clear();
  reloadAppearanceForTest();
  reloadLinkPreviewPreferenceForTest(localStorage);
  vi.unstubAllGlobals();
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

function pick(host: HTMLElement, testId: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, testId).not.toBeNull();
  act(() => {
    input?.click();
  });
}

describe("AppearanceSection: 색 모드", () => {
  it("offers the three color modes as one radio group", () => {
    const host = mount(createElement(AppearanceSection));
    const group = host.querySelector('[data-testid="theme-choice"]');
    expect(group?.tagName).toBe("FIELDSET");
    const radios = [...(group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
    expect(radios.map((r) => r.value)).toEqual(["system", "light", "dark"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it("walks the three values, stamps the root, and stores the scheme", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "theme-choice-light");
    expect(getTheme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    pick(host, "theme-choice-dark");
    expect(getTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    pick(host, "theme-choice-system");
    expect(getTheme()).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}") as {
      scheme?: string;
    };
    expect(stored.scheme).toBe("system");
  });

  it("says what 시스템 means on this device right now", () => {
    const stub = (dark: boolean) =>
      vi.stubGlobal("matchMedia", () => ({
        matches: dark,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    stub(true);
    const host = mount(createElement(AppearanceSection));
    const hint = host.querySelector("#appearance-mode-hint");
    expect(hint?.textContent).toContain("지금 이 기기의 시스템은 다크예요");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    stub(false);
    const again = mount(createElement(AppearanceSection));
    expect(again.querySelector("#appearance-mode-hint")?.textContent).toContain("라이트예요");
    // 고정하면 시스템 문장은 사라지고 고정 문장이 선다.
    pick(again, "theme-choice-dark");
    expect(again.querySelector("#appearance-mode-hint")?.textContent).not.toContain("시스템은");
  });

  it("reads the legacy scheme key when appearance.v1 is empty", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    reloadAppearanceForTest();
    const host = mount(createElement(AppearanceSection));
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="theme-choice-dark"]')?.checked
    ).toBe(true);
    expect(getAccent()).toBe("dawn");
  });
});

describe("AppearanceSection: 강조색", () => {
  it("lists Dawn first and applies an accent immediately", () => {
    const host = mount(createElement(AppearanceSection));
    const swatches = ACCENT_THEMES.map((theme) => {
      const node = host.querySelector<HTMLElement>(`[data-testid="accent-swatch-${theme.id}"]`);
      expect(node, theme.id).not.toBeNull();
      expect(node?.getAttribute("data-accent-swatch")).toBe(theme.id);
      return node!;
    });
    expect(swatches[0].getAttribute("data-accent-swatch")).toBe("dawn");
    expect(swatches[0].querySelector("input")?.checked).toBe(true);

    act(() => {
      swatches[1].querySelector("input")?.click();
    });
    expect(getAccent()).toBe(ACCENT_THEMES[1].id);
    expect(document.documentElement.getAttribute("data-accent")).toBe(ACCENT_THEMES[1].id);
    // 고른 칸은 정확히 하나이고, 그 칸만 체크 표시를 든다(CSS가 :checked로 드러낸다).
    const checked = swatches.filter((n) => n.querySelector("input")?.checked);
    expect(checked).toEqual([swatches[1]]);
    expect(swatches.filter((n) => n.querySelector(".accent-swatch-check")).length).toBe(5);

    act(() => {
      swatches[0].querySelector("input")?.click();
    });
    expect(getAccent()).toBe("dawn");
  });
});

describe("AppearanceSection: 테마 미리보기 카드", () => {
  function preview(host: HTMLElement) {
    const card = host.querySelector<HTMLElement>('[data-testid="theme-preview"]');
    expect(card).not.toBeNull();
    const layers = [...card!.querySelectorAll<HTMLElement>('[data-testid^="theme-preview-layer"]')];
    return { card: card!, layers };
  }

  it("draws both modes diagonally for 시스템 and one mode when pinned", () => {
    const host = mount(createElement(AppearanceSection));
    let { card, layers } = preview(host);
    expect(card.getAttribute("data-mode")).toBe("system");
    expect(layers.map((l) => l.getAttribute("data-preview-mode"))).toEqual(["light", "dark"]);
    expect(layers.map((l) => l.hasAttribute("data-split"))).toEqual([false, true]);

    pick(host, "theme-choice-dark");
    ({ card, layers } = preview(host));
    expect(card.getAttribute("data-mode")).toBe("dark");
    expect(layers.map((l) => l.getAttribute("data-preview-mode"))).toEqual(["dark"]);

    pick(host, "theme-choice-light");
    ({ layers } = preview(host));
    expect(layers.map((l) => l.getAttribute("data-preview-mode"))).toEqual(["light"]);
  });

  it("reads the root instead of scoping to a palette, so the pill follows the accent AND the theme (AP-1b #4188)", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "accent-swatch-hongyeom");
    const { card, layers } = preview(host);
    // 예전에는 층마다 `data-palette-preview`로 새벽하늘에 묶었고 알약은 새벽하늘 프리셋 값에 묶였다. 이제 둘 다 없다:
    // 층은 루트가 들고 있는 지금 테마·신호·모드의 변수를 그대로 물려받는다.
    for (const layer of layers) expect(layer.hasAttribute("data-palette-preview")).toBe(false);
    const pill = host.querySelector('[data-testid="theme-preview-pill"]');
    expect(pill?.hasAttribute("data-accent-swatch")).toBe(false);
    expect(document.documentElement.getAttribute("data-signal")).toBe("hongyeom");
    expect(card.getAttribute("data-theme-ref")).toBe("dawnsky");
  });

  it("names the selected theme on the card (catalog themes included)", () => {
    updateAppearance({ theme: "catalog:nord" });
    const host = mount(createElement(AppearanceSection));
    const { card } = preview(host);
    expect(card.getAttribute("data-theme-ref")).toBe("catalog:nord");
  });

  it("is decoration: hidden from assistive tech and not focusable", () => {
    const host = mount(createElement(AppearanceSection));
    const { card } = preview(host);
    expect(card.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector("button, a, input, [tabindex]")).toBeNull();
  });
});

describe("AppearanceSection: 링크 미리보기와 대화 미리보기", () => {
  function sample(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[data-testid="preview-link-card"]');
  }
  const inKorean = () => mount(createElement(LocaleProvider, { locale: korean }, createElement(AppearanceSection)));
  const labels = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-testid="link-preview-choice"] label')].map((label) => label.textContent);

  it("defaults to 작게 and the sample card follows each choice at once", () => {
    const host = inKorean();
    const group = host.querySelector('[data-testid="link-preview-choice"]');
    expect(group?.tagName).toBe("FIELDSET");
    expect(labels(host)).toEqual(["작게", "크게", "끄기"]);
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-compact"]')?.checked
    ).toBe(true);
    expect(sample(host)?.getAttribute("data-layout")).toBe("compact");

    pick(host, "link-preview-choice-rich");
    expect(sample(host)?.getAttribute("data-layout")).toBe("rich");
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("rich");

    pick(host, "link-preview-choice-off");
    expect(sample(host)).toBeNull();
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("off");

    pick(host, "link-preview-choice-compact");
    expect(sample(host)?.getAttribute("data-layout")).toBe("compact");
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("compact");
  });

  it("shows the explanation of the chosen size", () => {
    const host = inKorean();
    const row = () => host.querySelector('[data-testid="link-preview-choice"]')!.closest(".settings-row");
    expect(row()?.textContent).toContain("왼쪽에 작은 그림을 두고");
    pick(host, "link-preview-choice-rich");
    expect(row()?.textContent).toContain("글을 위에, 큰 그림을 아래에 둬요");
    pick(host, "link-preview-choice-off");
    expect(row()?.textContent).toContain("카드는 그리지 않아요");
  });

  it("reads the words from the dictionary: English without a Korean locale", () => {
    const host = mount(createElement(AppearanceSection));
    expect(labels(host)).toEqual(["Small", "Large", "Off"]);
  });

  it("keeps the sample out of the timeline's own test ids", () => {
    const host = inKorean();
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="conversation-preview"]')?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });
});

describe("AppearanceSection: 글자 크기와 대화 밀도 (AP-2a #4189)", () => {
  const radios = (host: HTMLElement, testId: string) => [
    ...(host.querySelector(`[data-testid="${testId}"]`)?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []),
  ];
  const labelsOf = (host: HTMLElement, testId: string) =>
    [...(host.querySelector(`[data-testid="${testId}"]`)?.querySelectorAll("label") ?? [])].map((l) =>
      l.textContent?.trim()
    );
  const storedRecord = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}") as Record<string, unknown>;

  it("offers the font size as one radio group: 작게 · 기본 · 크게, 기본이 골라져 있다", () => {
    const host = mount(createElement(AppearanceSection));
    const group = host.querySelector('[data-testid="font-size-choice"]');
    expect(group?.tagName).toBe("FIELDSET");
    const inputs = radios(host, "font-size-choice");
    expect(inputs.map((r) => r.value)).toEqual(["smaller", "default", "larger"]);
    expect(inputs.map((r) => r.checked)).toEqual([false, true, false]);
    expect(labelsOf(host, "font-size-choice")).toEqual(["작게", "기본", "크게"]);
    expect(new Set(inputs.map((r) => r.name)).size).toBe(1);
    expect(host.querySelector('[data-testid="font-size-row"]')?.textContent).toContain(
      "대화와 화면의 글자에 모두 적용돼요."
    );
  });

  it("walks the three sizes, stamps data-font-size on the root, and stores the choice", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "font-size-choice-larger");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("larger");
    expect(getAppearance().fontSize).toBe("larger");
    expect(storedRecord().fontSize).toBe("larger");
    pick(host, "font-size-choice-smaller");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("smaller");
    expect(storedRecord().fontSize).toBe("smaller");
    // 기본은 직렬화에서 빠진다(폰의 저장 형태를 한 글자도 바꾸지 않는 AP-1a 계약) — 속성은 늘 찍힌다.
    pick(host, "font-size-choice-default");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("default");
    expect(storedRecord()).not.toHaveProperty("fontSize");
    expect(radios(host, "font-size-choice").map((r) => r.checked)).toEqual([false, true, false]);
  });

  it("keeps the chosen font size across a reload", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "font-size-choice-larger");
    act(() => reloadAppearanceForTest());
    expect(getAppearance().fontSize).toBe("larger");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("larger");
  });

  it("offers the density as one radio group: 촘촘하게 · 편하게 · 여유롭게, 편하게가 골라져 있다", () => {
    const host = mount(createElement(AppearanceSection));
    const group = host.querySelector('[data-testid="density-choice"]');
    expect(group?.tagName).toBe("FIELDSET");
    const inputs = radios(host, "density-choice");
    expect(inputs.map((r) => r.value)).toEqual(["compact", "comfortable", "spacious"]);
    expect(inputs.map((r) => r.checked)).toEqual([false, true, false]);
    expect(labelsOf(host, "density-choice")).toEqual(["촘촘하게", "편하게", "여유롭게"]);
    expect(host.querySelector('[data-testid="density-row"]')?.textContent).toContain(
      "메시지 사이와 메시지 안 문단·목록 사이의 간격이에요."
    );
  });

  it("walks the three densities, stamps data-density on the root, and stores the choice", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "density-choice-spacious");
    expect(document.documentElement.getAttribute("data-density")).toBe("spacious");
    expect(getAppearance().density).toBe("spacious");
    expect(storedRecord().density).toBe("spacious");
    pick(host, "density-choice-compact");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(storedRecord().density).toBe("compact");
    pick(host, "density-choice-comfortable");
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
    expect(radios(host, "density-choice").map((r) => r.checked)).toEqual([false, true, false]);
  });

  it("changing one setting leaves the other and the color choice alone", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "theme-choice-dark");
    pick(host, "font-size-choice-larger");
    pick(host, "density-choice-spacious");
    expect(getTheme()).toBe("dark");
    expect(getAppearance()).toMatchObject({ scheme: "dark", fontSize: "larger", density: "spacious" });
    pick(host, "font-size-choice-default");
    expect(getAppearance()).toMatchObject({ scheme: "dark", density: "spacious" });
  });

  it("puts font size and density at the top of the 대화 표시 card, above the link preview", () => {
    const host = mount(createElement(AppearanceSection));
    const order = [...host.querySelectorAll("fieldset")].map((f) => f.getAttribute("data-testid"));
    expect(order.indexOf("font-size-choice")).toBeGreaterThan(order.indexOf("accent-choice"));
    expect(order.indexOf("density-choice")).toBe(order.indexOf("font-size-choice") + 1);
    expect(order.indexOf("link-preview-choice")).toBe(order.indexOf("density-choice") + 1);
  });

  it("has a conversation preview that reads the timeline's own spacing tokens", () => {
    const host = mount(createElement(AppearanceSection));
    const preview = host.querySelector('[data-testid="conversation-preview"]');
    expect(preview).not.toBeNull();
    // 세 묶음 머리(성재 · 김 에이전트 · 성재)의 아바타는 타임라인과 같은 밀도 이름 크기를 읽는다.
    const avatars = [...(preview?.querySelectorAll('[data-testid="preview-avatar"]') ?? [])];
    expect(avatars).toHaveLength(3);
    for (const avatar of avatars) {
      expect(avatar.className).toContain("size-message-avatar");
      expect(avatar.className).not.toMatch(/\bsize-8\b/);
    }
    // 마크다운 글은 타임라인과 같은 컴포넌트가 그린다: 블록 간격·목록 항목 간격 클래스가 거기서 나온다.
    expect(preview?.querySelector('[data-testid="message-markdown"]')?.className).toContain("gap-prose");
    const items = [...(preview?.querySelectorAll('[data-testid="message-list"] > li') ?? [])];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]?.className).not.toContain("mt-list-item");
    expect(items[1]?.className).toContain("mt-list-item");
  });

  it("lays the preview rows out exactly like timeline rows: group heads open upward, continuations are symmetric", () => {
    const host = mount(createElement(AppearanceSection));
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="conversation-preview"] [data-testid="preview-row"]')];
    // 성재(머리) · 성재(이어지는 행) · 에이전트(머리) · 성재(머리, 링크 카드는 맨 아래).
    expect(rows.map((row) => row.hasAttribute("data-starts-group"))).toEqual([true, false, true, true]);
    for (const row of rows) {
      const startsGroup = row.hasAttribute("data-starts-group");
      const classes = row.className.split(/\s+/);
      // 묶음 머리는 위가 열린 패딩(`pt-row-head pb-row`), 이어지는 행은 위아래 대칭(`py-row`) — 타임라인과 같은 상수다.
      if (startsGroup) {
        expect(classes, row.className).toEqual(expect.arrayContaining(["pt-row-head", "pb-row"]));
        expect(classes, row.className).not.toContain("py-row");
      } else {
        expect(classes, row.className).toContain("py-row");
        expect(classes, row.className).not.toContain("pt-row-head");
      }
      // 거터는 아바타와 같은 한 변을 밀도 이름으로 읽는다(손으로 쓴 w-6·w-8이 아니다).
      const gutter = row.firstElementChild as HTMLElement;
      expect(gutter.className.split(/\s+/), gutter.className).toContain("w-message-avatar");
      expect(gutter.className).not.toMatch(/(?<![\w-])w-\d+(?![\w-])/);
    }
  });

  it("draws the preview text with the timeline's body type, author line and 24-hour clock", () => {
    const host = mount(createElement(AppearanceSection));
    const preview = host.querySelector('[data-testid="conversation-preview"]')!;
    // 본문 문단은 전부 타임라인 본문 클래스(`leading-relaxed`)를 단다(따로 적은 `<p>`가 아니다).
    const paragraphs = [...preview.querySelectorAll("p")].filter((p) => !p.closest('[data-testid="preview-link-card"]'));
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    for (const p of paragraphs) expect(p.className, p.textContent ?? "").toContain("leading-relaxed");
    // 시각은 타임라인 행의 `HH:MM`(24시간제)이다.
    const clocks = [...preview.querySelectorAll("[data-numeric]")].map((el) => el.textContent);
    expect(clocks).toEqual(["14:14", "14:15", "14:16"]);
    // 에이전트 행은 실제 행처럼 `@핸들`(에이전트 색) + 「님이 관리」다.
    const agentName = [...preview.querySelectorAll("span")].find((el) => el.textContent === "@kim");
    expect(agentName?.className).toContain("text-agent");
    expect(preview.textContent).toContain("· 성재 님이 관리");
    // 링크 카드는 맨 아래 행에 있고(밀도에 민감한 행이 컨트롤 가까이 오게), 미리보기 상자는 카드 전폭이다.
    const rows = [...preview.querySelectorAll('[data-testid="preview-row"]')];
    expect(rows.at(-1)?.querySelector('[data-testid="preview-link-card"]')).not.toBeNull();
    expect(rows.slice(0, -1).some((row) => row.querySelector('[data-testid="preview-link-card"]'))).toBe(false);
    expect(preview.className).toMatch(/\bw-full\b/);
  });
});

describe("AppearanceSection: S3b 컨트롤 중 아직 열리지 않은 것 (R4)", () => {
  it("offers exactly the six live groups and no switch, slider, or text field", () => {
    const host = mount(createElement(AppearanceSection));
    const groups = [...host.querySelectorAll("fieldset")].map((f) => f.getAttribute("data-testid"));
    // 글자 크기·대화 밀도는 AP-2a(#4189)가 소비자(타임라인·미리보기)와 같은 PR에서 열었고, 배경화면(AP-4 #4191)은
    // 카드 「배경」의 라디오 묶음 하나를 더했다(카드 순서: 색상 → 배경 → 대화 표시).
    expect(groups).toEqual([
      "theme-choice",
      "accent-choice",
      "wallpaper-choice",
      "font-size-choice",
      "density-choice",
      "link-preview-choice",
    ]);
    // 유리 배경(AP-3 #4190)은 열렸다: 브라우저에서는 잠긴 스위치 하나뿐이다(슬라이더는 켜진 동안에만 선다).
    expect(host.querySelector('[role="switch"]:not([data-testid^="glass-"]), input[type="range"], input[type="text"]:not([data-testid^="font-"]), select')).toBeNull();
    const glass = host.querySelector<HTMLButtonElement>('[data-testid="glass-background-toggle"]');
    expect(glass?.disabled).toBe(true);
    expect(glass?.getAttribute("aria-checked")).toBe("false");
    // 글꼴(#3774)은 이름 입력 두 칸까지만 연다.
    expect([...host.querySelectorAll('input[type="text"]')].map((i) => i.getAttribute("data-testid"))).toEqual([
      "font-sans-input",
      "font-mono-input",
    ]);
    for (const closed of ["palette", "hex"]) {
      expect(host.querySelector(`[data-testid*="${closed}"]`), closed).toBeNull();
    }
  });
});
