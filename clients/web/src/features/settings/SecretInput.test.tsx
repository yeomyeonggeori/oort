// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SecretInput } from "./SecretInput";

const env = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        "form",
        { "data-testid": "f" },
        createElement(SecretInput, {
          "aria-label": "키",
          "data-testid": "k",
          revealTestId: "eye",
        } as ComponentProps<typeof SecretInput>),
      ),
    ),
  );
  const input = host.querySelector<HTMLInputElement>('[data-testid="k"]')!;
  const eye = host.querySelector<HTMLButtonElement>('[data-testid="eye"]')!;
  const form = host.querySelector("form")!;
  return { input, eye, form };
}

describe("SecretInput (눈 토글)", () => {
  it("기본은 가림이고, 누르면 보이며 값·캐럿·선택이 그대로다", () => {
    const { input, eye } = mount();
    expect(input.type).toBe("password");
    expect(eye.getAttribute("aria-label")).toBe("키 보기");
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    input.value = "sk-test-12345";
    input.focus();
    input.setSelectionRange(3, 7);
    act(() => eye.click());
    expect(input.type).toBe("text");
    expect(input.value).toBe("sk-test-12345");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
    expect(eye.getAttribute("aria-label")).toBe("키 가리기");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    act(() => eye.click());
    expect(input.type).toBe("password");
    expect(input.value).toBe("sk-test-12345");
  });

  it("눈 버튼은 키보드 Tab 순서에 있는 button[type=button]이고 mousedown이 칸의 초점을 뺏지 않는다", () => {
    const { eye } = mount();
    expect(eye.tagName).toBe("BUTTON");
    expect(eye.type).toBe("button");
    expect(eye.tabIndex).toBe(0);
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    eye.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("폼을 저장(submit)하면 가림으로 돌아간다", () => {
    const { input, eye, form } = mount();
    act(() => eye.click());
    expect(input.type).toBe("text");
    act(() => {
      form.addEventListener("submit", (e) => e.preventDefault());
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(input.type).toBe("password");
  });
});
