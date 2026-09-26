// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TERMINAL_APP_BINDINGS } from "@momo/core/features/workbench/keymap";
import { TERMINAL_THEME_ENTRY } from "@momo/core/features/workbench/terminalTheme";
import { resetTerminalThemeForTest, terminalThemeSnapshot } from "@/features/workbench/local/terminalTheme";
import { TerminalSection, keycapLabel } from "./TerminalSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(desktop: boolean, platform: "mac" | "other" = "mac") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(TerminalSection, { desktop, platform })));
  return { host, unmount: () => act(() => root.unmount()) };
}

describe("설정 > 터미널 (#2774, ADR-0190 D5 「이 목록은 설정에서 볼 수 있다」)", () => {
  it("가로채는 키 표는 판정과 같은 배열의 모든 줄이다", () => {
    const { host, unmount } = render(true);
    const rows = host.querySelectorAll('[data-testid="terminal-shortcut-row"]');
    expect(rows.length).toBe(TERMINAL_APP_BINDINGS.length);
    expect(host.textContent).toContain("⌃`");
    expect(host.textContent).toContain("Esc를 포함해 모두 터미널로 갑니다");
    unmount();
  });

  it("브라우저에서는 로컬 터미널이 없다고 말한다", () => {
    const { host, unmount } = render(false);
    expect(host.textContent).toContain("이 브라우저에는 로컬 터미널이 없습니다");
    unmount();
  });

  it("macOS 밖에서는 ⌘와 ⌃를 Ctrl로 적는다", () => {
    expect(keycapLabel("other", "⌘⇧D")).toBe("Ctrl+Shift+D");
    expect(keycapLabel("other", "⌃`")).toBe("Ctrl+`");
    expect(keycapLabel("mac", "⌘⇧↵")).toBe("⌘⇧↵");
  });
});

describe("설정 > 터미널 색 (#2849)", () => {
  function radios(host: HTMLElement) {
    return Array.from(
      host.querySelectorAll<HTMLInputElement>('[data-testid="terminal-theme-choice"] input[type="radio"]')
    );
  }

  it("데스크탑은 세 가지를 보이고, 고른 적이 없으면 어둡게가 골라져 있다", () => {
    window.localStorage.removeItem(TERMINAL_THEME_ENTRY);
    resetTerminalThemeForTest();
    const { host, unmount } = render(true);
    const inputs = radios(host);
    expect(inputs.map((i) => i.value)).toEqual(["dark", "app", "light"]);
    expect(inputs.find((i) => i.checked)?.value).toBe("dark");
    expect(host.textContent).toContain("어둡게 (기본)");
    unmount();
  });

  it("고르면 이 기기에 저장하고 저장소가 바로 바뀐다", () => {
    window.localStorage.removeItem(TERMINAL_THEME_ENTRY);
    resetTerminalThemeForTest();
    const { host, unmount } = render(true);
    const light = radios(host).find((i) => i.value === "light")!;
    act(() => light.click());
    expect(terminalThemeSnapshot().theme).toBe("light");
    expect(JSON.parse(window.localStorage.getItem(TERMINAL_THEME_ENTRY) ?? "null")).toEqual({ v: 1, theme: "light" });
    expect(radios(host).find((i) => i.checked)?.value).toBe("light");
    unmount();
    window.localStorage.removeItem(TERMINAL_THEME_ENTRY);
    resetTerminalThemeForTest();
  });

  it("저장소를 못 읽으면 어둡게로 그리고 그렇다고 말한다", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      resetTerminalThemeForTest();
      expect(terminalThemeSnapshot()).toEqual({ theme: "dark", storageFailed: true });
      const { host, unmount } = render(true);
      expect(host.textContent).toContain("이 기기에 저장하지 못했습니다");
      unmount();
    } finally {
      Object.defineProperty(window, "localStorage", original);
      resetTerminalThemeForTest();
    }
  });

  it("브라우저에는 터미널 색 고르기가 없다", () => {
    const { host, unmount } = render(false);
    expect(radios(host)).toHaveLength(0);
    unmount();
  });
});
