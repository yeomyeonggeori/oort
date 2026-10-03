// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TabTitleCount, tabTitle } from "./TabTitleCount";

const count = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/features/inbox/useNeedsMe", () => ({ useNeedsMeCount: () => count.value }));
vi.mock("@/lib/tauri", () => ({ isDesktop: () => false }));

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
});

describe("tab title count (#3340)", () => {
  it("formats", () => {
    expect(tabTitle("oort", 0)).toBe("oort");
    expect(tabTitle("oort", 3)).toBe("(3) oort");
    expect(tabTitle("oort", 250)).toBe("(99+) oort");
  });

  it("prefixes the needs-me count and restores on unmount", () => {
    document.title = "oort";
    count.value = 3;
    const host = document.createElement("div");
    root = createRoot(host);
    act(() => root?.render(createElement(TabTitleCount)));
    expect(document.title).toBe("(3) oort");
    act(() => root?.unmount());
    root = null;
    expect(document.title).toBe("oort");
  });
});
