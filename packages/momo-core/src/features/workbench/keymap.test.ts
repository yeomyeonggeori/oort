import { describe, expect, it } from "vitest";
import {
  WORKBENCH_BINDINGS,
  keyPlatformOf,
  resolveWorkbenchKey,
  type WorkbenchKeyEvent,
} from "./keymap";

const mac = (event: WorkbenchKeyEvent) => resolveWorkbenchKey(event, "mac");
const other = (event: WorkbenchKeyEvent) => resolveWorkbenchKey(event, "other");

describe("macOS 격자 키(ADR-0190 D5)", () => {
  it.each<[string, WorkbenchKeyEvent, unknown]>([
    ["⌘D 오른쪽 분할", { code: "KeyD", key: "d", metaKey: true }, { type: "split", axis: "row" }],
    ["⌘⇧D 아래 분할", { code: "KeyD", key: "D", metaKey: true, shiftKey: true }, { type: "split", axis: "column" }],
    ["⌘⌥← 방향", { code: "ArrowLeft", key: "ArrowLeft", metaKey: true, altKey: true }, { type: "focus-direction", direction: "left" }],
    ["⌘⌥↑ 방향", { code: "ArrowUp", metaKey: true, altKey: true }, { type: "focus-direction", direction: "up" }],
    ["⌘⌥→ 방향", { code: "ArrowRight", metaKey: true, altKey: true }, { type: "focus-direction", direction: "right" }],
    ["⌘⌥↓ 방향", { code: "ArrowDown", metaKey: true, altKey: true }, { type: "focus-direction", direction: "down" }],
    ["⌘] 다음", { code: "BracketRight", key: "]", metaKey: true }, { type: "focus-cycle", delta: 1 }],
    ["⌘[ 이전", { code: "BracketLeft", key: "[", metaKey: true }, { type: "focus-cycle", delta: -1 }],
    ["⌃1 번호", { code: "Digit1", key: "1", ctrlKey: true }, { type: "focus-index", index: 1 }],
    ["⌃9 번호", { code: "Digit9", key: "9", ctrlKey: true }, { type: "focus-index", index: 9 }],
    ["⌘⇧↵ 최대화", { code: "Enter", key: "Enter", metaKey: true, shiftKey: true }, { type: "toggle-maximize" }],
    ["⌘⇧↵ 숫자판", { code: "NumpadEnter", key: "Enter", metaKey: true, shiftKey: true }, { type: "toggle-maximize" }],
    ["⌘W 닫기", { code: "KeyW", key: "w", metaKey: true }, { type: "close" }],
  ])("%s", (_name, event, expected) => {
    expect(mac(event)).toEqual(expected);
  });
});

describe("한글 2벌식 입력 상태: key가 한글이어도 code로 판정한다", () => {
  it.each<[string, WorkbenchKeyEvent, unknown]>([
    ["⌘D (ㅇ)", { code: "KeyD", key: "ㅇ", metaKey: true }, { type: "split", axis: "row" }],
    ["⌘⇧D (ㅇ)", { code: "KeyD", key: "ㅇ", metaKey: true, shiftKey: true }, { type: "split", axis: "column" }],
    ["⌘W (ㅈ)", { code: "KeyW", key: "ㅈ", metaKey: true }, { type: "close" }],
    ["⌘⇧W (ㅈ) 는 닫기가 아님", { code: "KeyW", key: "ㅈ", metaKey: true, shiftKey: true }, null],
  ])("%s", (_name, event, expected) => {
    expect(mac(event)).toEqual(expected);
  });

  it("key만 d이고 code가 다른 자리면 판정하지 않는다(물리 키가 기준)", () => {
    expect(mac({ code: "KeyE", key: "d", metaKey: true })).toBeNull();
  });

  it("code가 없으면 판정하지 않는다", () => {
    expect(mac({ key: "d", metaKey: true })).toBeNull();
    expect(mac({ code: "", key: "d", metaKey: true })).toBeNull();
  });
});

describe("수식 키는 정확히 맞아야 한다", () => {
  it.each<[string, WorkbenchKeyEvent]>([
    ["D 단독", { code: "KeyD" }],
    ["⌃D", { code: "KeyD", ctrlKey: true }],
    ["⌘⌥D", { code: "KeyD", metaKey: true, altKey: true }],
    ["⌘⌃D", { code: "KeyD", metaKey: true, ctrlKey: true }],
    ["⌘← (⌥ 없음)", { code: "ArrowLeft", metaKey: true }],
    ["⌥← (⌘ 없음)", { code: "ArrowLeft", altKey: true }],
    ["⌘⌥⇧←", { code: "ArrowLeft", metaKey: true, altKey: true, shiftKey: true }],
    ["⌘1 (워크스페이스 전환 몫)", { code: "Digit1", metaKey: true }],
    ["⌃0", { code: "Digit0", ctrlKey: true }],
    ["⌃⇧1", { code: "Digit1", ctrlKey: true, shiftKey: true }],
    ["⌘↵ (보내기 몫)", { code: "Enter", metaKey: true }],
    ["⌘⇧W", { code: "KeyW", metaKey: true, shiftKey: true }],
    ["⌘⇧]", { code: "BracketRight", metaKey: true, shiftKey: true }],
    ["⌘K (격자 키 아님)", { code: "KeyK", metaKey: true }],
  ])("%s → null", (_name, event) => {
    expect(mac(event)).toBeNull();
  });
});

describe("macOS 밖은 ⌘ 자리를 Ctrl로 읽는다", () => {
  it("Ctrl+D, Ctrl+Shift+D, Ctrl+Alt+→, Ctrl+], Ctrl+Shift+Enter, Ctrl+W", () => {
    expect(other({ code: "KeyD", ctrlKey: true })).toEqual({ type: "split", axis: "row" });
    expect(other({ code: "KeyD", ctrlKey: true, shiftKey: true })).toEqual({ type: "split", axis: "column" });
    expect(other({ code: "ArrowRight", ctrlKey: true, altKey: true })).toEqual({
      type: "focus-direction",
      direction: "right",
    });
    expect(other({ code: "BracketRight", ctrlKey: true })).toEqual({ type: "focus-cycle", delta: 1 });
    expect(other({ code: "Enter", ctrlKey: true, shiftKey: true })).toEqual({ type: "toggle-maximize" });
    expect(other({ code: "KeyW", ctrlKey: true })).toEqual({ type: "close" });
    expect(other({ code: "Digit2", ctrlKey: true })).toEqual({ type: "focus-index", index: 2 });
  });

  it("Meta(Windows 키)가 눌려 있으면 판정하지 않는다", () => {
    expect(other({ code: "KeyD", metaKey: true })).toBeNull();
    expect(other({ code: "KeyD", ctrlKey: true, metaKey: true })).toBeNull();
  });
});

describe("플랫폼 판정", () => {
  it.each<[string | null | undefined, "mac" | "other"]>([
    ["MacIntel", "mac"],
    ["iPhone", "mac"],
    ["Win32", "other"],
    ["Linux x86_64", "other"],
    ["", "other"],
    [null, "other"],
    [undefined, "other"],
  ])("%s → %s", (hint, expected) => {
    expect(keyPlatformOf(hint)).toBe(expected);
  });
});

describe("도움말 표", () => {
  it("키캡은 ADR-0190 D5 표와 같다", () => {
    const byId = Object.fromEntries(WORKBENCH_BINDINGS.map((b) => [b.id, b.keycaps]));
    expect(byId["split-right"]).toEqual(["⌘D"]);
    expect(byId["split-down"]).toEqual(["⌘⇧D"]);
    expect(byId["focus-cycle"]).toEqual(["⌘]", "⌘["]);
    expect(byId["toggle-maximize"]).toEqual(["⌘⇧↵"]);
    expect(byId["close"]).toEqual(["⌘W"]);
  });
});
