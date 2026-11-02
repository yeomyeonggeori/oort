// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageEditor } from "./MessageEditor";

// =============================================================================
// 메시지 고치기 입력칸의 키 (#5191): Enter = 저장, Esc = 취소, Shift+Enter = 줄바꿈 — **입력칸 규칙과 같게**.
//
// 입력칸(컴포저)은 한글 조합을 끝내는 Enter 를 보내기로 읽지 않는다(`composerKeyIntent`). 고치기 입력칸은 이미 한국어로 적힌
// 문장을 여는 곳이라 이 약속이 더 무겁다: 조합이 끝나기도 전에 저장되면 쓰던 글이 중간에 서버에 간다. 편집기는 이 가드 없이
// Enter 를 곧장 저장으로 읽고 있었다(웹·WebKit 모두 재현: `scripts/capture-5191.mjs` 「편집기 조합」).
//
// 두 브라우저 순서를 둘 다 못 박는다:
//   Chromium: keydown(Enter, isComposing=true) → compositionend → keyup
//   WebKit  : compositionend → keydown(Enter, isComposing=false) → keyup      (Tauri 웹뷰의 엔진)
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

function mountEditor(initialBody = "회의 시간은 3시예요") {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(MessageEditor, { initialBody, pending: false, error: null, onSave, onCancel })
    );
  });
  const input = host.querySelector("textarea") as HTMLTextAreaElement;
  return { input, onSave, onCancel };
}

/** 글을 바꿔 둔다: 바뀐 게 없으면 Enter 는 저장이 아니라 「그냥 닫기」라 가드를 잴 수 없다. */
function edit(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(input: HTMLTextAreaElement, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    input.dispatchEvent(event);
  });
  return event;
}

const compositionStart = (input: HTMLTextAreaElement) =>
  act(() => void input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
const compositionEnd = (input: HTMLTextAreaElement) =>
  act(() => void input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
const keyUp = (input: HTMLTextAreaElement, name: string) =>
  act(() => void input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: name })));

describe("고치기 입력칸의 키", () => {
  it("Enter 는 바뀐 글을 저장한다", () => {
    const { input, onSave, onCancel } = mountEditor();
    edit(input, "회의 시간은 3시 30분이에요");
    const enter = key(input, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("회의 시간은 3시 30분이에요");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Esc 는 저장 없이 닫는다", () => {
    const { input, onSave, onCancel } = mountEditor();
    edit(input, "고치다 만 글");
    const esc = key(input, { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Shift+Enter 는 줄바꿈이라 저장하지 않고 막지도 않는다", () => {
    const { input, onSave } = mountEditor();
    edit(input, "다른 글");
    const event = key(input, { key: "Enter", shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([["⌘Enter", { metaKey: true }], ["Ctrl+Enter", { ctrlKey: true }]])(
    "%s 도 저장한다(입력칸의 보내기와 같다)",
    (_name, modifier) => {
      const { input, onSave } = mountEditor();
      edit(input, "다른 글");
      key(input, { key: "Enter", ...modifier });
      expect(onSave).toHaveBeenCalledTimes(1);
    }
  );

  it("바뀐 게 없으면 Enter 는 저장이 아니라 닫기다(「수정됨」이 붙지 않게)", () => {
    const { input, onSave, onCancel } = mountEditor("그대로");
    key(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Chromium 순서: 조합 중 Enter(isComposing)는 저장이 아니다", () => {
    const { input, onSave } = mountEditor();
    edit(input, "다른 글");
    compositionStart(input);
    key(input, { key: "Enter", isComposing: true });
    compositionEnd(input);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("옛 엔진의 keyCode 229 도 조합이다", () => {
    const { input, onSave } = mountEditor();
    edit(input, "다른 글");
    key(input, { key: "Enter", keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("WebKit 순서: compositionend 가 먼저인 Enter 한 번은 저장이 아니고, 키를 뗀 뒤의 Enter 가 저장이다", () => {
    const { input, onSave } = mountEditor();
    edit(input, "다른 글");
    compositionStart(input);
    compositionEnd(input);
    const committing = key(input, { key: "Enter", isComposing: false });
    expect(onSave).not.toHaveBeenCalled();
    // 조합을 끝낸 키는 이 편집기가 삼키지 않는다: 막지 않아야 IME 가 자기 일(마지막 음절 확정)을 한다.
    expect(committing.defaultPrevented).toBe(false);
    keyUp(input, "Enter");
    key(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("조합 중 Esc 는 IME 의 것이다: 후보 창을 닫는 키이지 편집을 버리는 키가 아니다", () => {
    const { input, onCancel } = mountEditor();
    key(input, { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    key(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("조합이 키 없이 끝났어도(보내기를 누르는 중) 다른 키 하나면 깃발이 내려가 다음 Enter 를 삼키지 않는다", () => {
    const { input, onSave } = mountEditor();
    edit(input, "다른 글");
    compositionStart(input);
    compositionEnd(input);
    key(input, { key: "a" });
    key(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("비면 저장되지 않는다(빈 글로 고치는 것은 지우기가 아니다)", () => {
    const { input, onSave } = mountEditor();
    edit(input, "   ");
    key(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
  });
});
