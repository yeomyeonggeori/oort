// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS } from "@/design/motion";
import { Tooltip } from "./tooltip";

/**
 * 공용 툴팁의 동작 (#4324): 가리키면 500ms 뒤, 키보드 초점은 즉시, 눌림·나감·Esc는 즉시 닫힘.
 * 시간은 가짜 타이머로 재고, 경계(499 / 500)에서 단정한다.
 */

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete env.IS_REACT_ACT_ENVIRONMENT;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(props: { side?: "top" | "bottom"; align?: "center" | "end" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(Tooltip, {
        label: "답글 달기",
        ...props,
        children: createElement(
          "button",
          { type: "button", "aria-label": "답글 달기" },
          "x"
        ),
      })
    )
  );
  const button = host.querySelector("button") as HTMLButtonElement;
  const tip = () => host.querySelector<HTMLElement>('[data-testid="tooltip"]');
  return { host, button, tip };
}

function pointer(el: Element, type: "pointerover" | "pointerout" | "pointerdown", pointerType = "mouse") {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: type === "pointerout" ? document.body : null });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    el.dispatchEvent(event);
  });
}

function focusVisible(el: HTMLElement, visible: boolean) {
  const original = el.matches.bind(el);
  vi.spyOn(el, "matches").mockImplementation((selector: string) =>
    selector === ":focus-visible" ? visible : original(selector)
  );
}

describe("공용 툴팁", () => {
  it("가리키면 지연(TOOLTIP_DELAY_MS) 뒤에야 뜬다: 한 틱 전엔 없고 정확히 그때 선다", () => {
    expect(TOOLTIP_DELAY_MS).toBe(500);
    vi.useFakeTimers();
    const { button, tip } = mount();
    pointer(button, "pointerover");
    act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(tip()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(tip()?.textContent).toBe("답글 달기");
  });

  it("지연 안에 나가면 뜨지 않는다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount();
    pointer(button, "pointerover");
    act(() => void vi.advanceTimersByTime(300));
    pointer(button, "pointerout");
    act(() => void vi.advanceTimersByTime(1000));
    expect(tip()).toBeNull();
  });

  it("터치 포인터는 띄우지 않는다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount();
    pointer(button, "pointerover", "touch");
    act(() => void vi.advanceTimersByTime(2000));
    expect(tip()).toBeNull();
  });

  it("키보드 초점(:focus-visible)은 지연 없이 즉시 뜬다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount();
    focusVisible(button, true);
    act(() => button.focus());
    expect(tip()?.textContent).toBe("답글 달기");
  });

  it("마우스로 간 초점(:focus-visible 아님)은 띄우지 않는다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount();
    focusVisible(button, false);
    act(() => button.focus());
    act(() => void vi.advanceTimersByTime(2000));
    expect(tip()).toBeNull();
  });

  it("눌림·초점 나감·Esc는 즉시 닫는다", () => {
    vi.useFakeTimers();
    const { button, tip } = mount();
    focusVisible(button, true);

    act(() => button.focus());
    expect(tip()).not.toBeNull();
    act(() => button.blur());
    expect(tip()).toBeNull();

    act(() => button.focus());
    expect(tip()).not.toBeNull();
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tip()).toBeNull();

    act(() => button.blur());
    act(() => button.focus());
    expect(tip()).not.toBeNull();
    pointer(button, "pointerdown");
    expect(tip()).toBeNull();
  });

  it("방향은 data-side로 드러나고 이름을 두 번 읽히지 않는다(aria-hidden, describedby 없음)", () => {
    vi.useFakeTimers();
    const { button, tip } = mount({ side: "bottom" });
    focusVisible(button, true);
    act(() => button.focus());
    expect(tip()?.getAttribute("data-side")).toBe("bottom");
    expect(tip()?.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("title")).toBeNull();
  });

  it("align=end는 가운데 정렬 클래스를 덮어 오른쪽 끝에 붙고, 기본은 가운데다(가장자리 단추의 툴팁 잘림 M-1)", () => {
    vi.useFakeTimers();
    const end = mount({ align: "end" });
    focusVisible(end.button, true);
    act(() => end.button.focus());
    const cls = end.tip()?.className ?? "";
    expect(cls).toContain("right-0");
    expect(cls).not.toContain("left-1/2");
    expect(cls).not.toContain("-translate-x-1/2");
    act(() => root?.unmount());
    document.body.replaceChildren();
    const center = mount();
    focusVisible(center.button, true);
    act(() => center.button.focus());
    expect(center.tip()?.className).toContain("-translate-x-1/2");
  });
});
