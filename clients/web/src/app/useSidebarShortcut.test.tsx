// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useSidebarShortcut } from "./useSidebarShortcut";

// #3280: ⌘B(Ctrl+B)는 목록 열을 접고 편다. 단, 컴포저의 「굵게」(⌘B)가 우선이고(입력 칸에서는
// 접힘이 바뀌지 않는다), 터미널에서는 macOS ⌘B만 앱이 가져가며(ADR-0190 D5 증보), 비 mac Ctrl+B는
// tmux prefix라 터미널 몫이다. 이 시험은 실제 keydown 사건(대상 DOM 포함)으로 잰다.

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function mount(platform: string, enabled = true) {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const changes: boolean[] = [];
  function Harness() {
    const [collapsed, setCollapsed] = useState(false);
    useSidebarShortcut({
      enabled,
      collapsed,
      onToggle: (next) => {
        changes.push(next);
        setCollapsed(next);
      },
    });
    return createElement(
      "div",
      null,
      createElement("button", { id: "plain", type: "button" }, "단추"),
      // 컴포저: 굵게(⌘B)는 이 칸의 몫이다.
      createElement("textarea", { id: "composer" }),
      createElement("div", { id: "rich", contentEditable: "true", suppressContentEditableWarning: true }),
      createElement("input", { id: "field", type: "text" }),
      // 터미널 입력 칸: xterm의 도우미 textarea.
      createElement(
        "div",
        { className: "xterm" },
        createElement("textarea", { id: "xterm-input", className: "xterm-helper-textarea" })
      )
    );
  }
  act(() => root?.render(createElement(Harness)));
  return changes;
}

function press(targetId: string, init: KeyboardEventInit): KeyboardEvent {
  const target = document.getElementById(targetId) ?? document.body;
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const cmdB = { code: "KeyB", key: "b", metaKey: true };
const ctrlB = { code: "KeyB", key: "b", ctrlKey: true };

describe("⌘B 전역 접기 (#3280)", () => {
  it("일반 포커스에서 ⌘B는 접고, 다시 누르면 편다(기본 동작은 막는다)", () => {
    const changes = mount("MacIntel");
    const first = press("plain", cmdB);
    expect(changes).toEqual([true]);
    expect(first.defaultPrevented).toBe(true);
    press("plain", cmdB);
    expect(changes).toEqual([true, false]);
  });

  it("한글 2벌식(key가 「ㅠ」)에서도 물리 키로 동작한다", () => {
    const changes = mount("MacIntel");
    press("plain", { code: "KeyB", key: "ㅠ", metaKey: true });
    expect(changes).toEqual([true]);
  });

  it("컴포저 textarea·contenteditable·input에서는 접지 않고 사건도 소비하지 않는다(굵게 우선)", () => {
    const changes = mount("MacIntel");
    for (const id of ["composer", "rich", "field"]) {
      const event = press(id, cmdB);
      expect(event.defaultPrevented, id).toBe(false);
    }
    expect(changes).toEqual([]);
  });

  it("비 mac에서도 Ctrl+B는 일반 포커스에서만 접고, 입력 칸에서는 접지 않는다", () => {
    const changes = mount("Win32");
    press("composer", ctrlB);
    expect(changes).toEqual([]);
    press("plain", ctrlB);
    expect(changes).toEqual([true]);
  });

  it("터미널: macOS ⌘B는 앱이 가져가고, 비 mac Ctrl+B(tmux prefix)는 터미널 몫이다", () => {
    const mac = mount("MacIntel");
    const macEvent = press("xterm-input", cmdB);
    expect(mac).toEqual([true]);
    expect(macEvent.defaultPrevented).toBe(true);
    act(() => root?.unmount());
    host?.remove();

    const other = mount("Linux x86_64");
    const otherEvent = press("xterm-input", ctrlB);
    expect(other).toEqual([]);
    expect(otherEvent.defaultPrevented).toBe(false);
    // macOS에서 ⌃B(tmux prefix)도 터미널 몫이다.
    act(() => root?.unmount());
    host?.remove();
    const macCtrl = mount("MacIntel");
    press("xterm-input", ctrlB);
    expect(macCtrl).toEqual([]);
  });

  it("수식 키가 다르면(⇧·⌥ 추가, 플랫폼 반대 수식)·IME 조합 중·반복·다이얼로그 위에서는 무시한다", () => {
    const changes = mount("MacIntel");
    press("plain", { ...cmdB, shiftKey: true });
    press("plain", { ...cmdB, altKey: true });
    press("plain", ctrlB);
    press("plain", { ...cmdB, isComposing: true });
    press("plain", { ...cmdB, repeat: true });
    expect(changes).toEqual([]);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    press("plain", cmdB);
    dialog.remove();
    expect(changes).toEqual([]);
    press("plain", cmdB);
    expect(changes).toEqual([true]);
  });

  it("비활성(폰 서랍·설정 전면)이면 아무 일도 하지 않는다", () => {
    const changes = mount("MacIntel", false);
    const event = press("plain", cmdB);
    expect(changes).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
