// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TERMINAL_APP_BINDINGS } from "@momo/core/features/workbench/keymap";
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
