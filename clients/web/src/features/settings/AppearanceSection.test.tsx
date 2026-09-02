// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppearanceSection } from "./AppearanceSection";
import {
  APPEARANCE_STORAGE_KEY,
  ACCENT_THEMES,
  getAccent,
  getTheme,
  reloadAppearanceForTest,
  THEME_STORAGE_KEY,
} from "@/design/theme";

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

describe("AppearanceSection", () => {
  it("offers the three color-mode radios with the house ChoiceRadios grammar", () => {
    const host = mount(createElement(AppearanceSection));
    const group = host.querySelector('[data-testid="theme-choice"]');
    expect(group).not.toBeNull();
    expect(group?.tagName).toBe("FIELDSET");
    expect(host.querySelector<HTMLInputElement>("#theme-system")?.checked).toBe(
      true
    );
    expect(host.querySelector("#theme-light")).not.toBeNull();
    expect(host.querySelector("#theme-dark")).not.toBeNull();
  });

  it("walks the three color-mode values and follows the system default", () => {
    const host = mount(createElement(AppearanceSection));
    act(() => {
      host.querySelector<HTMLInputElement>("#theme-light")?.click();
    });
    expect(getTheme()).toBe("light");
    act(() => {
      host.querySelector<HTMLInputElement>("#theme-dark")?.click();
    });
    expect(getTheme()).toBe("dark");
    act(() => {
      host.querySelector<HTMLInputElement>("#theme-system")?.click();
    });
    expect(getTheme()).toBe("system");
    const stored = JSON.parse(
      localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}"
    ) as { scheme?: string };
    expect(stored.scheme).toBe("system");
  });

  it("lists Dawn first and applies an accent immediately", () => {
    const host = mount(createElement(AppearanceSection));
    const swatches = ACCENT_THEMES.map((theme) => {
      const node = host.querySelector<HTMLElement>(
        `[data-testid="accent-swatch-${theme.id}"]`
      );
      expect(node, theme.id).not.toBeNull();
      expect(node?.getAttribute("data-accent-swatch")).toBe(theme.id);
      return node!;
    });
    expect(swatches[0].getAttribute("data-accent-swatch")).toBe("dawn");
    const firstRadio = swatches[0].querySelector("input");
    expect(firstRadio?.checked).toBe(true);

    act(() => {
      swatches[1].querySelector("input")?.click();
    });
    expect(getAccent()).toBe(ACCENT_THEMES[1].id);
    expect(document.documentElement.getAttribute("data-accent")).toBe(
      ACCENT_THEMES[1].id
    );

    act(() => {
      swatches[0].querySelector("input")?.click();
    });
    expect(getAccent()).toBe("dawn");
  });

  it("reads the legacy scheme key when appearance.v1 is empty", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    reloadAppearanceForTest();
    const host = mount(createElement(AppearanceSection));
    expect(host.querySelector<HTMLInputElement>("#theme-dark")?.checked).toBe(
      true
    );
    expect(getAccent()).toBe("dawn");
  });
});
