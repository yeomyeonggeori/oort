// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTitlebar } from "./AppTitlebar";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
});

function mountTitlebar(collapsed = false) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  function Harness() {
    const [folded, setFolded] = useState(collapsed);
    return createElement("div", {
      className: "app-shell",
      "data-sidebar-collapsed": folded ? "" : undefined,
      "data-testid": "shell",
      children: [
        createElement(AppTitlebar, {
          key: "titlebar",
          collapsed: folded,
          onCollapsedChange: setFolded,
        }),
        createElement("div", {
          key: "sidebar",
          id: "sidebar-drawer",
          "data-testid": "sidebar",
          children: createElement("button", {
            type: "button",
            "data-testid": "sidebar-search",
          }, "검색과 이동"),
        }),
        createElement("main", {
          key: "main",
          "data-testid": "shell-main",
        }, "본문"),
      ],
    });
  }
  act(() => mountedRoot?.render(createElement(Harness)));
  return host;
}

describe("AppTitlebar", () => {
  it("상단 줄에 토글을 그리고 클릭으로 접힘↔펼침과 aria를 맞춘다", () => {
    const host = mountTitlebar();
    const toggle = host.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-toggle"]'
    );
    const titlebar = host.querySelector('[data-testid="app-titlebar"]');
    expect(titlebar).not.toBeNull();
    expect(titlebar?.contains(toggle)).toBe(true);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("탐색 패널 접기");
    expect(toggle?.getAttribute("aria-controls")).toBe("sidebar-drawer");
    expect(toggle?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(titlebar?.hasAttribute("data-tauri-drag-region")).toBe(false);

    act(() => toggle?.click());
    expect(host.querySelector("[data-sidebar-collapsed]")).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-label")).toBe("탐색 패널 열기");

    act(() => toggle?.click());
    expect(host.querySelector("[data-sidebar-collapsed]")).toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });
});
