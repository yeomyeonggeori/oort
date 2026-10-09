// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "./AppearanceSection";
import {
  APPEARANCE_STORAGE_KEY,
  ACCENT_THEMES,
  getAccent,
  getTheme,
  reloadAppearanceForTest,
  THEME_STORAGE_KEY,
} from "@/design/theme";
import {
  LINK_PREVIEW_STORAGE_KEY,
  reloadLinkPreviewPreferenceForTest,
} from "@/features/timeline/linkPreviewPreference";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

  it("scopes every layer to the active palette, and the pill follows the accent", () => {
    const host = mount(createElement(AppearanceSection));
    pick(host, "accent-swatch-hongyeom");
    const { layers } = preview(host);
    for (const layer of layers) expect(layer.getAttribute("data-palette-preview")).toBe("dawnsky");
    const pill = host.querySelector('[data-testid="theme-preview-pill"]');
    expect(pill?.getAttribute("data-accent-swatch")).toBe("hongyeom");
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

  it("defaults to 사진 카드 and the sample card follows each choice at once", () => {
    const host = mount(createElement(AppearanceSection));
    const group = host.querySelector('[data-testid="link-preview-choice"]');
    expect(group?.tagName).toBe("FIELDSET");
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-rich"]')?.checked
    ).toBe(true);
    expect(sample(host)?.getAttribute("data-layout")).toBe("rich");

    pick(host, "link-preview-choice-compact");
    expect(sample(host)?.getAttribute("data-layout")).toBe("compact");
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("compact");

    pick(host, "link-preview-choice-off");
    expect(sample(host)).toBeNull();
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("off");

    pick(host, "link-preview-choice-rich");
    expect(sample(host)?.getAttribute("data-layout")).toBe("rich");
    expect(localStorage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("rich");
  });

  it("shows the explanation of the chosen layout", () => {
    const host = mount(createElement(AppearanceSection));
    const row = () => host.querySelector('[data-testid="link-preview-choice"]')!.closest(".settings-row");
    expect(row()?.textContent).toContain("사진을 위에 두고");
    pick(host, "link-preview-choice-off");
    expect(row()?.textContent).toContain("카드는 그리지 않아요");
  });

  it("keeps the sample out of the timeline's own test ids", () => {
    const host = mount(createElement(AppearanceSection));
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="conversation-preview"]')?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });
});

describe("AppearanceSection: S3b 컨트롤은 아직 열리지 않는다 (R4)", () => {
  it("offers exactly the three live groups and no switch, slider, or text field", () => {
    const host = mount(createElement(AppearanceSection));
    const groups = [...host.querySelectorAll("fieldset")].map((f) => f.getAttribute("data-testid"));
    expect(groups).toEqual(["theme-choice", "accent-choice", "link-preview-choice"]);
    expect(host.querySelector('[role="switch"], input[type="range"], input[type="text"], select')).toBeNull();
    for (const closed of ["density", "font-size", "glass", "palette", "hex"]) {
      expect(host.querySelector(`[data-testid*="${closed}"]`), closed).toBeNull();
    }
  });
});
