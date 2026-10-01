// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySidebarListChange,
  getSidebarAutoClosed,
  getSidebarCollapsed,
  resetSidebarCollapsedForTest,
  useDisplayedSidebarCollapsed,
} from "@/app/sidebarCollapseStore";
import { useSidebarShortcut } from "@/app/useSidebarShortcut";
import { useSessionListOpen } from "./sessionListOpen";

// #3280: 「내 작업」이 좁은 창(1280)에서 폭 규칙으로 세션 목록을 접어 두었을 때, 제목줄 단추와 ⌘B가
// 읽는 「접힘」은 화면과 같아야 한다. 저장된 상태만 읽으면 aria-expanded가 거짓이고 첫 ⌘B가
// 아무 일도 하지 않는다(두 번째에야 열린다).

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
  resetSidebarCollapsedForTest();
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "MacIntel" });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.unstubAllGlobals();
});

const MIN_4X2 = 4 * 240 + 3 * 8; // 984

function mount(innerWidth: number) {
  Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const seen = { open: false, displayed: false };
  function Harness() {
    const list = useSessionListOpen(MIN_4X2);
    const displayed = useDisplayedSidebarCollapsed(true);
    seen.open = list.open;
    seen.displayed = displayed;
    // 셸과 같은 배선: 표시된 접힘을 읽고, 요청은 applySidebarListChange로.
    useSidebarShortcut({
      enabled: true,
      collapsed: displayed,
      onToggle: (next) => applySidebarListChange(next),
    });
    return createElement("button", { id: "plain", type: "button" }, "x");
  }
  act(() => root?.render(createElement(Harness)));
  return seen;
}

function cmdB() {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "KeyB", key: "b", metaKey: true });
  act(() => {
    document.getElementById("plain")!.dispatchEvent(event);
  });
}

describe("좁은 창의 「내 작업」: 단추·⌘B가 보이는 상태를 읽는다 (#3280)", () => {
  it("1280: 폭 규칙으로 목록이 닫혀 있으면 표시된 접힘이 참이고, ⌘B 한 번에 열린다", () => {
    const seen = mount(1280);
    expect(seen.open).toBe(false);
    expect(getSidebarAutoClosed()).toBe(true);
    expect(getSidebarCollapsed()).toBe(false); // 저장된 접힘은 아니다
    expect(seen.displayed).toBe(true); // 단추의 aria-expanded=false, 라벨 「열기」

    cmdB();
    expect(seen.open).toBe(true); // 첫 번째 누름이 연다
    expect(seen.displayed).toBe(false);
    expect(getSidebarCollapsed()).toBe(false);

    cmdB(); // 다시 누르면 접는다(저장)
    expect(seen.open).toBe(false);
    expect(getSidebarCollapsed()).toBe(true);
    expect(window.localStorage.getItem("momo.web.shell.listColumn.collapsed.v1")).toBe("1");
  });

  it("1440: 목록이 열려 있으면 표시된 접힘은 거짓이고 첫 ⌘B가 접는다", () => {
    const seen = mount(1440);
    expect(seen.open).toBe(true);
    expect(seen.displayed).toBe(false);
    cmdB();
    expect(seen.open).toBe(false);
    expect(seen.displayed).toBe(true);
  });

  it("사람이 편 목록은 폭이 모자라도 이번 실행에 다시 자동으로 접히지 않는다", () => {
    const seen = mount(1280);
    cmdB(); // 연다
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(seen.open).toBe(true);
  });
});
