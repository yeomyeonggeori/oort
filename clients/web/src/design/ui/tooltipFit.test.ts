// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_CAPPED_ATTR,
  TOOLTIP_EDGE_PAD,
  TOOLTIP_MAX_VAR,
  TOOLTIP_SHIFT_VAR,
  clipRange,
  fitTooltipElement,
  tooltipFit,
  type TooltipAlign,
} from "./tooltipFit";

/**
 * 툴팁이 자기를 가둔 판 안에 머무는 계산 (#4230). 계산은 숫자로, DOM 읽기·쓰기는 상자를 가짜로 끼워 잰다.
 * 숫자는 `gate:channel-header-fit`이 실브라우저에서 잰 장면에서 따왔다(계획 독 「계획 12단계 중 1단계 완료」 149px,
 * 데스크탑 600 폭의 판 324→592, 폰 320의 판 0→320, ⋮ 의 「{긴 이름} 채널 메뉴」 407px).
 */

const PAD = TOOLTIP_EDGE_PAD;

/** 놓인 상자(자연 위치에서 `shift`만큼 옮긴 뒤). */
function placed(
  anchor: { left: number; right: number },
  width: number,
  align: TooltipAlign,
  fit: { shift: number; maxWidth: number | null }
): { left: number; right: number } {
  const used = fit.maxWidth ?? width;
  const natural = align === "end" ? anchor.right - used : (anchor.left + anchor.right) / 2 - used / 2;
  return { left: natural + fit.shift, right: natural + fit.shift + used };
}

describe("tooltipFit: 순수 계산", () => {
  it("범위 안에 있으면 건드리지 않는다", () => {
    expect(tooltipFit({ left: 200, right: 234 }, 100, "center", { left: 0, right: 390 })).toEqual({
      shift: 0,
      maxWidth: null,
    });
    expect(tooltipFit({ left: 300, right: 334 }, 100, "end", { left: 0, right: 390 })).toEqual({
      shift: 0,
      maxWidth: null,
    });
  });

  it("가운데 정렬이 왼쪽 끝을 넘으면 오른쪽으로 민다 (폰 320의 독: 판 0→320, 독 42.4→102.4, 글 149)", () => {
    const fit = tooltipFit({ left: 42.4, right: 102.4 }, 149, "center", { left: 0, right: 320 });
    // 자연 위치 왼쪽 끝은 72.4 - 74.5 = -2.1이다 → 틈 4까지 6.1을 민다.
    expect(fit.maxWidth).toBeNull();
    expect(fit.shift).toBeCloseTo(PAD + 2.1, 5);
  });

  it("판이 왼쪽에 오프셋을 가져도 그 판의 왼쪽이 기준이다 (데스크탑 600 폭: 판 324→592, 독 350.4→410.4)", () => {
    const fit = tooltipFit({ left: 350.4, right: 410.4 }, 149, "center", { left: 324, right: 592 });
    const box = placed({ left: 350.4, right: 410.4 }, 149, "center", fit);
    expect(box.left).toBeCloseTo(324 + PAD, 5);
    expect(fit.shift).toBeGreaterThan(20);
  });

  it("가운데 정렬이 오른쪽 끝을 넘으면 왼쪽으로 민다", () => {
    const fit = tooltipFit({ left: 290, right: 310 }, 100, "center", { left: 0, right: 320 });
    const box = placed({ left: 290, right: 310 }, 100, "center", fit);
    expect(box.right).toBeCloseTo(320 - PAD, 5);
    expect(fit.shift).toBeLessThan(0);
  });

  it("오른쪽 끝 정렬(align=end)도 왼쪽 끝을 넘으면 오른쪽으로 민다", () => {
    const fit = tooltipFit({ left: 10, right: 44 }, 80, "end", { left: 0, right: 320 });
    const box = placed({ left: 10, right: 44 }, 80, "end", fit);
    expect(box.left).toBeCloseTo(PAD, 5);
    expect(fit.shift).toBeCloseTo(40, 5);
  });

  it("범위보다 넓으면 범위 폭에서 줄바꿈하고 왼쪽 틈에 붙인다 (⋮ 의 긴 이름: 407px, 폰 390)", () => {
    const fit = tooltipFit({ left: 340, right: 374 }, 407, "end", { left: 0, right: 390 });
    expect(fit.maxWidth).toBe(390 - PAD * 2);
    const box = placed({ left: 340, right: 374 }, 407, "end", fit);
    expect(box.left).toBeCloseTo(PAD, 5);
    expect(box.right).toBeCloseTo(390 - PAD, 5);
  });

  it("잴 수 없는 값이면 건드리지 않는다 (폭 0, 범위 0)", () => {
    expect(tooltipFit({ left: 0, right: 0 }, 0, "center", { left: 0, right: 1024 })).toEqual({
      shift: 0,
      maxWidth: null,
    });
    expect(tooltipFit({ left: 10, right: 40 }, 100, "center", { left: 0, right: PAD * 2 })).toEqual({
      shift: 0,
      maxWidth: null,
    });
  });

  it("어떤 입력이든 놓인 상자는 범위 안이다 (격자 훑기)", () => {
    const problems: string[] = [];
    for (const bounds of [
      { left: 0, right: 320 },
      { left: 324, right: 592 },
      { left: 324, right: 712 },
      { left: 0, right: 1440 },
    ]) {
      for (const width of [20, 55, 149, 300, 407, 900]) {
        for (const align of ["center", "end"] as const) {
          for (let left = bounds.left - 40; left <= bounds.right + 40; left += 13) {
            const anchor = { left, right: left + 34 };
            const fit = tooltipFit(anchor, width, align, bounds);
            const box = placed(anchor, width, align, fit);
            if (box.left < bounds.left + PAD - 1e-6 || box.right > bounds.right - PAD + 1e-6) {
              problems.push(`${JSON.stringify({ bounds, width, align, anchor })} -> ${JSON.stringify(box)}`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---- DOM: 상자를 가짜로 끼운다 ------------------------------------------------------------

interface Layout {
  pane: { left: number; right: number };
  anchor: { left: number; right: number };
  tipWidth: number;
}

/** pane(overflow: clip) > 래퍼(트리거 상자) > 툴팁. 측정만 가짜다. */
function mountTip(layout: Layout) {
  const pane = document.createElement("div");
  pane.setAttribute("data-pane", "");
  const wrapper = document.createElement("span");
  wrapper.setAttribute("data-wrapper", "");
  const tip = document.createElement("span");
  tip.setAttribute("data-testid", "tooltip");
  wrapper.append(tip);
  pane.append(wrapper);
  document.body.append(pane);

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
    if (this.hasAttribute("data-wrapper")) return rect(layout.anchor);
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
  return { pane, wrapper, tip };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("clipRange: 툴팁을 자르는 범위", () => {
  it("overflow가 visible이 아닌 조상(판)과 창의 교집합이다", () => {
    const { tip } = mountTip({
      pane: { left: 324, right: 592 },
      anchor: { left: 350, right: 410 },
      tipWidth: 149,
    });
    expect(clipRange(tip)).toEqual({ left: 324, right: 592 });
  });

  it("자르는 조상이 없으면 창 전체다", () => {
    const tip = document.createElement("span");
    const host = document.createElement("div");
    host.append(tip);
    document.body.append(host);
    expect(clipRange(tip)).toEqual({ left: 0, right: window.innerWidth });
  });
});

describe("fitTooltipElement: 열린 툴팁을 범위 안에 놓는다", () => {
  it("왼쪽 끝을 넘으면 --tooltip-shift를 넣는다 (폭이 맞으면 줄바꿈 표지는 없다)", () => {
    const { tip } = mountTip({
      pane: { left: 324, right: 592 },
      anchor: { left: 350.4, right: 410.4 },
      tipWidth: 149,
    });
    fitTooltipElement(tip, "center");
    expect(Number.parseFloat(tip.style.getPropertyValue(TOOLTIP_SHIFT_VAR))).toBeCloseTo(
      324 + PAD - (380.4 - 74.5),
      5
    );
    expect(tip.hasAttribute(TOOLTIP_CAPPED_ATTR)).toBe(false);
    expect(tip.style.getPropertyValue(TOOLTIP_MAX_VAR)).toBe("");
  });

  it("범위보다 넓으면 줄바꿈 표지와 상한을 넣는다", () => {
    const { tip } = mountTip({
      pane: { left: 0, right: 390 },
      anchor: { left: 340, right: 374 },
      tipWidth: 407,
    });
    fitTooltipElement(tip, "end");
    expect(tip.hasAttribute(TOOLTIP_CAPPED_ATTR)).toBe(true);
    expect(tip.style.getPropertyValue(TOOLTIP_MAX_VAR)).toBe(String(390 - PAD * 2));
    expect(Number.parseFloat(tip.style.getPropertyValue(TOOLTIP_SHIFT_VAR))).toBeCloseTo(12, 5);
  });

  it("범위 안이면 아무 값도 남기지 않고, 이전 값은 걷는다 (같은 요소를 다시 재도 같은 답)", () => {
    const layout: Layout = {
      pane: { left: 0, right: 390 },
      anchor: { left: 200, right: 234 },
      tipWidth: 100,
    };
    const { tip } = mountTip(layout);
    tip.style.setProperty(TOOLTIP_SHIFT_VAR, "99px");
    tip.style.setProperty(TOOLTIP_MAX_VAR, "50px");
    tip.setAttribute(TOOLTIP_CAPPED_ATTR, "");
    fitTooltipElement(tip, "center");
    expect(tip.style.getPropertyValue(TOOLTIP_SHIFT_VAR)).toBe("");
    expect(tip.style.getPropertyValue(TOOLTIP_MAX_VAR)).toBe("");
    expect(tip.hasAttribute(TOOLTIP_CAPPED_ATTR)).toBe(false);

    layout.anchor = { left: 10, right: 44 };
    fitTooltipElement(tip, "center");
    const first = tip.style.getPropertyValue(TOOLTIP_SHIFT_VAR);
    fitTooltipElement(tip, "center");
    expect(first).not.toBe("");
    expect(tip.style.getPropertyValue(TOOLTIP_SHIFT_VAR)).toBe(first);
  });

  it("폭이 0이면(그려지지 않음, jsdom) 아무것도 하지 않는다", () => {
    const { tip } = mountTip({
      pane: { left: 0, right: 0 },
      anchor: { left: 0, right: 0 },
      tipWidth: 0,
    });
    fitTooltipElement(tip, "center");
    expect(tip.style.length).toBe(0);
    expect(tip.hasAttribute(TOOLTIP_CAPPED_ATTR)).toBe(false);
  });
});
