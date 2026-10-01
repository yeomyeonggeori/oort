// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";
import { resetShortcutBindingsForTest, setBinding } from "./shortcutBindings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #3281: 도움말은 설정에서 바꾼 키를 같은 정본에서 다시 읽는다(열려 있는 동안에도).
let cleanup: (() => void) | null = null;
beforeEach(() => {
  localStorage.clear();
  resetShortcutBindingsForTest();
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  localStorage.clear();
  resetShortcutBindingsForTest();
});

describe("도움말 ← 재지정", () => {
  it("열린 도움말의 키캡이 재지정과 초기화를 따른다", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ShortcutHelpDialog)));
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    act(() => {
      (document.querySelector('[data-testid="shortcut-help-trigger"]') as HTMLElement).click();
    });
    const inbox = () => document.querySelector('[data-shortcut-id="open-inbox"]')?.textContent ?? "";
    expect(inbox()).toContain("⌘⇧A");
    act(() => setBinding("open-inbox", { code: "KeyG", shift: true, alt: false }));
    expect(inbox()).toContain("⌘⇧G");
    expect(inbox()).not.toContain("⌘⇧A");
  });
});
