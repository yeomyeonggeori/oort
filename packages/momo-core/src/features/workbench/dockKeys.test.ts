import { describe, expect, it } from "vitest";
import {
  TERMINAL_APP_BINDINGS,
  isTerminalAppKey,
  keycapToEvent,
  resolveDockKey,
  type WorkbenchKeyEvent,
} from "./keymap";

const mac = (event: WorkbenchKeyEvent, dockFocused = false) =>
  resolveDockKey(event, "mac", { dockFocused });

describe("도크 키(ADR-0190 D5, #2774)", () => {
  it("⌃`는 물리 키로 판정한다: 한글 2벌식에서 key가 「₩」여도 도크를 연다", () => {
    expect(mac({ code: "Backquote", key: "₩", ctrlKey: true })).toEqual({ type: "toggle-dock" });
    expect(mac({ code: "Backquote", key: "`", ctrlKey: true })).toEqual({ type: "toggle-dock" });
  });

  it("key만 「`」이고 code가 다른 자판(배열이 다른 키보드)은 도크 키가 아니다", () => {
    expect(mac({ code: "IntlBackslash", key: "`", ctrlKey: true })).toBeNull();
    expect(mac({ key: "`", ctrlKey: true })).toBeNull();
  });

  it("⌃⇧`는 전체 화면이다(key가 「~」여도)", () => {
    expect(mac({ code: "Backquote", key: "~", ctrlKey: true, shiftKey: true })).toEqual({
      type: "toggle-fullscreen",
    });
  });

  it("⌘`는 macOS 창 순환이라 가로채지 않는다", () => {
    expect(mac({ code: "Backquote", key: "`", metaKey: true })).toBeNull();
    expect(mac({ code: "Backquote", key: "`", ctrlKey: true, metaKey: true })).toBeNull();
    expect(mac({ code: "Backquote", key: "`", ctrlKey: true, altKey: true })).toBeNull();
  });

  it("⌃⇧N은 새 세션, ⌘T는 도크 포커스 중일 때만 새 세션", () => {
    expect(mac({ code: "KeyN", ctrlKey: true, shiftKey: true })).toEqual({ type: "new-session" });
    expect(mac({ code: "KeyN", metaKey: true })).toBeNull();
    expect(mac({ code: "KeyT", metaKey: true })).toBeNull();
    expect(mac({ code: "KeyT", metaKey: true }, true)).toEqual({ type: "new-session" });
  });

  it("⌘J는 점프 목록, ⌃⇧J는 다음 「나를 기다림」", () => {
    expect(mac({ code: "KeyJ", metaKey: true })).toEqual({ type: "jump-palette" });
    expect(mac({ code: "KeyJ", ctrlKey: true, shiftKey: true })).toEqual({ type: "next-waiting" });
    expect(mac({ code: "KeyJ", ctrlKey: true })).toBeNull();
  });

  it("macOS 밖에서는 ⌃`가 Ctrl+`이고 Meta가 눌리면 판정하지 않는다", () => {
    expect(resolveDockKey({ code: "Backquote", ctrlKey: true }, "other")).toEqual({ type: "toggle-dock" });
    expect(resolveDockKey({ code: "Backquote", ctrlKey: true, metaKey: true }, "other")).toBeNull();
    expect(resolveDockKey({ code: "KeyJ", ctrlKey: true }, "other")).toEqual({ type: "jump-palette" });
  });
});

describe("터미널 포커스 중 가로채는 키 = D5 표 전부, 그 밖은 없음", () => {
  it("표의 모든 키캡이 앱 키로 판정된다", () => {
    const caps = TERMINAL_APP_BINDINGS.flatMap((b) => b.keycaps);
    // 표가 비지 않았다는 것 자체를 잰다(빈 표로 초록이 되는 것을 막는다).
    expect(caps.length).toBeGreaterThanOrEqual(15);
    for (const cap of caps) {
      const event = keycapToEvent(cap);
      expect(event, cap).not.toBeNull();
      expect(isTerminalAppKey(event!, "mac"), cap).toBe(true);
    }
  });

  it("D5 표의 줄이 모두 있다", () => {
    expect(TERMINAL_APP_BINDINGS.map((b) => b.id)).toEqual([
      "toggle-dock",
      "toggle-fullscreen",
      "new-session",
      "split-right",
      "split-down",
      "focus-direction",
      "focus-cycle",
      "focus-index",
      "toggle-maximize",
      "close",
      "jump-palette",
      "next-waiting",
    ]);
  });

  it.each<[string, WorkbenchKeyEvent]>([
    ["⌃C", { code: "KeyC", key: "c", ctrlKey: true }],
    ["⌃D", { code: "KeyD", key: "d", ctrlKey: true }],
    ["⌃R", { code: "KeyR", key: "r", ctrlKey: true }],
    ["Esc", { code: "Escape", key: "Escape" }],
    ["⌥←", { code: "ArrowLeft", key: "ArrowLeft", altKey: true }],
    ["⌥↑", { code: "ArrowUp", key: "ArrowUp", altKey: true }],
    ["⌘K", { code: "KeyK", key: "k", metaKey: true }],
    ["⌘⇧A", { code: "KeyA", key: "a", metaKey: true, shiftKey: true }],
    ["Tab", { code: "Tab", key: "Tab" }],
    ["한글 ㅇ", { code: "KeyD", key: "ㅇ" }],
    ["⌃N", { code: "KeyN", key: "n", ctrlKey: true }],
  ])("%s는 터미널 입력이다", (_name, event) => {
    expect(isTerminalAppKey(event, "mac")).toBe(false);
  });
});
