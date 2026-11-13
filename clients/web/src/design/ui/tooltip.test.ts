// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS } from "@/design/motion";
import { Tooltip } from "./tooltip";

/**
 * 공용 툴팁의 동작 (#4324): 가리키면 지연(`TOOLTIP_DELAY_MS`) 뒤, 키보드 초점은 즉시, 눌림·나감·Esc·초점 나감은 즉시 안 보인다
 * (초점 나감만 노드를 한 박자 뒤에 뗀다, #5780 B1 — 실제 Tab 이동은 `scripts/capture-5780.mjs`가 실제 엔진에서 잰다).
 * 지연의 값과 옮겨 다닐 때의 0은 `tooltipDelay.test.ts`가 잰다(#5192).
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
  /** 초점이 나가며 숨긴 채 남은 한 박자의 노드(#5780 B1). */
  const leftover = () => host.querySelector<HTMLElement>("[data-tooltip-leaving]");
  return { host, button, tip, leftover };
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
    expect(TOOLTIP_DELAY_MS).toBeLessThanOrEqual(150);
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

  it("보이는 닫힘은 즉시다: 눌림·Esc는 노드도 그 자리에서 떼고, 초점 나감은 같은 커밋에 숨긴 뒤 한 박자 뒤에 뗀다 (#5780 B1)", () => {
    vi.useFakeTimers();
    const { button, tip, leftover } = mount();
    focusVisible(button, true);

    act(() => button.focus());
    const shown = tip();
    expect(shown?.hidden).toBe(false);
    act(() => button.blur());
    // 보이는 것은 지금 닫힌다(`hidden` → display:none, 「툴팁」 표지도 내려놓음). 노드는 초점 이동이 끝난 뒤에 떼어진다: blur
    // 안에서 노드를 떼면 모달의 초점 가둠(Radix FocusScope)이 초점을 대화상자 상자로 끌어가 Tab이 다음 컨트롤에 닿지 못한다.
    expect(tip()).toBeNull();
    expect(leftover()).toBe(shown);
    expect(leftover()?.hidden).toBe(true);
    act(() => void vi.advanceTimersByTime(0));
    expect(leftover()).toBeNull();

    act(() => button.focus());
    expect(tip()).not.toBeNull();
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tip()).toBeNull();
    expect(leftover()).toBeNull();

    act(() => button.blur());
    act(() => button.focus());
    expect(tip()).not.toBeNull();
    pointer(button, "pointerdown");
    expect(tip()).toBeNull();
    expect(leftover()).toBeNull();
  });

  it("숨긴 채 남은 한 박자 안에 초점이 돌아오면 같은 노드가 다시 보이고 떼기는 취소된다", () => {
    vi.useFakeTimers();
    const { button, tip, leftover } = mount();
    focusVisible(button, true);
    act(() => button.focus());
    const first = tip();
    act(() => button.blur());
    expect(leftover()).toBe(first);
    act(() => button.focus());
    expect(tip()).toBe(first);
    expect(tip()?.hidden).toBe(false);
    act(() => void vi.advanceTimersByTime(1000));
    expect(tip()).toBe(first);
    expect(tip()?.hidden).toBe(false);
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

// =============================================================================
// #4230 — 툴팁은 자기를 가둔 판 안에 머문다. 판(`overflow: clip`)은 툴팁이 가장자리를 넘으면 글자를 자른다.
// 상자는 jsdom이 못 재므로 가짜로 끼운다(계산 자체는 `tooltipFit.test.ts`가 숫자로, 진짜 상자는 `gate:channel-header-fit`이 잰다).
// 여기서 지키는 것은 **연결**이다: 열릴 때 재서 변수를 넣고, 닫혔다 다시 열려도 낡은 값이 남지 않으며, CSS가 그 변수를 읽는다.
// =============================================================================

// jsdom 환경의 `URL`은 노드의 것이 아니라 `readFileSync(new URL(...))`이 거부된다: 경로 문자열로 읽는다.
const TOKENS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../tokens.css"),
  "utf8"
);

/** `@utility <name> { ... }`의 본문(중첩 블록은 들여써서 열 0의 `}`가 유틸리티의 끝이다). */
function utilityBody(name: string): string {
  const start = TOKENS.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`tokens.css에 @utility ${name}이 없다`);
  return TOKENS.slice(start, TOKENS.indexOf("\n}", start));
}

interface PaneLayout {
  pane: { left: number; right: number };
  anchor: { left: number; right: number };
  tipWidth: number;
}

function mockPaneLayout(layout: PaneLayout) {
  const rect = (box: { left: number; right: number }) =>
    ({
      left: box.left,
      right: box.right,
      top: 0,
      bottom: 20,
      width: box.right - box.left,
      height: 20,
      x: box.left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-pane")) return rect(layout.pane);
    // `Tooltip`의 래퍼(`relative inline-flex`)가 트리거의 상자다.
    if (this.classList.contains("relative")) return rect(layout.anchor);
    return rect({ left: 0, right: 0 });
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === "tooltip" ? layout.tipWidth : 0;
  });
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element, pseudo?: string | null) =>
    el.hasAttribute("data-pane")
      ? ({ overflowX: "clip" } as CSSStyleDeclaration)
      : real(el, pseudo)) as typeof window.getComputedStyle);
}

function mountInPane(layout: PaneLayout, align: "center" | "end" = "center") {
  mockPaneLayout(layout);
  const pane = document.createElement("div");
  pane.setAttribute("data-pane", "");
  document.body.append(pane);
  root = createRoot(pane);
  act(() =>
    root?.render(
      createElement(Tooltip, {
        label: "계획 12단계 중 1단계 완료",
        side: "bottom",
        align,
        children: createElement("button", { type: "button", "aria-label": "계획" }, "x"),
      })
    )
  );
  const button = pane.querySelector("button") as HTMLButtonElement;
  const tip = () => pane.querySelector<HTMLElement>('[data-testid="tooltip"]');
  return { button, tip };
}

describe("판 안에 머문다 (#4230)", () => {
  it("열릴 때 판 왼쪽을 넘는 만큼 안으로 민다: --tooltip-shift (줄이 바뀐 아랫줄의 첫 단추)", () => {
    vi.useFakeTimers();
    const { button, tip } = mountInPane({
      pane: { left: 324, right: 592 },
      anchor: { left: 350.4, right: 410.4 },
      tipWidth: 149,
    });
    focusVisible(button, true);
    act(() => button.focus());
    // 자연 위치 왼쪽 끝은 380.4 - 74.5 = 305.9, 판 왼쪽 + 틈 4 = 328 → 22.1을 민다.
    expect(Number.parseFloat(tip()?.style.getPropertyValue("--tooltip-shift") ?? "")).toBeCloseTo(22.1, 5);
    expect(tip()?.hasAttribute("data-capped")).toBe(false);
  });

  it("판보다 넓으면 판 폭에서 줄바꿈한다: --tooltip-max와 data-capped (⋮의 「{긴 이름} 채널 메뉴」, 오른쪽 끝 정렬)", () => {
    vi.useFakeTimers();
    const { button, tip } = mountInPane(
      { pane: { left: 0, right: 390 }, anchor: { left: 340, right: 374 }, tipWidth: 407 },
      "end"
    );
    focusVisible(button, true);
    act(() => button.focus());
    expect(tip()?.hasAttribute("data-capped")).toBe(true);
    expect(tip()?.style.getPropertyValue("--tooltip-max")).toBe("382");
    expect(Number.parseFloat(tip()?.style.getPropertyValue("--tooltip-shift") ?? "")).toBeCloseTo(12, 5);
  });

  it("판 안이면 아무 값도 넣지 않고, 닫았다 다시 열면 낡은 값이 남지 않는다", () => {
    vi.useFakeTimers();
    const layout: PaneLayout = {
      pane: { left: 0, right: 390 },
      anchor: { left: 10, right: 44 },
      tipWidth: 150,
    };
    const { button, tip } = mountInPane(layout);
    focusVisible(button, true);
    act(() => button.focus());
    expect(tip()?.style.getPropertyValue("--tooltip-shift")).not.toBe("");
    act(() => button.blur());
    expect(tip()).toBeNull();
    // 숨긴 노드가 떼어진 뒤에 다시 연다(한 박자 안에 다시 열면 같은 노드를 다시 재며, `fitTooltipElement`가 먼저 값을 걷는다).
    act(() => void vi.advanceTimersByTime(0));

    // 다른 자리(판 한가운데)에서 다시 열면 새 요소가 값 없이 선다.
    layout.anchor = { left: 200, right: 234 };
    act(() => button.focus());
    expect(tip()?.style.getPropertyValue("--tooltip-shift")).toBe("");
    expect(tip()?.hasAttribute("data-capped")).toBe(false);
  });

  it("tooltip-surface가 그 변수와 줄바꿈 표지를 읽는다 (연결이 끊기면 값만 넣고 안 움직인다)", () => {
    const surface = utilityBody("tooltip-surface");
    // 두 변수는 단위 없는 px 숫자라 CSS가 `* 1px`로 곱한다.
    expect(surface).toMatch(/margin-inline-start: calc\(var\(--tooltip-shift, 0\) \* 1px\);/);
    // 오른쪽 끝 정렬(`right: 0`)은 끝 여백의 음수가 같은 쪽으로 민다.
    expect(surface).toMatch(/margin-inline-end: calc\(var\(--tooltip-shift, 0\) \* -1px\);/);
    const capped = surface.slice(surface.indexOf("&[data-capped] {"));
    expect(capped).toMatch(/inline-size: max-content;/);
    expect(capped).toMatch(/max-inline-size: calc\(var\(--tooltip-max\) \* 1px\);/);
    expect(capped).toMatch(/white-space: normal;/);
    expect(capped).toMatch(/word-break: keep-all;/);
    // 기본 면은 그대로 한 줄이다.
    expect(surface.slice(0, surface.indexOf("&[data-capped] {"))).toMatch(/white-space: nowrap;/);
  });
});
