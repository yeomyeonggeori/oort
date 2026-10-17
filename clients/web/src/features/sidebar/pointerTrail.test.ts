// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePointerTrail, lastPointerAt, resetPointerTrailForTest } from "./pointerTrail";

// =============================================================================
// 포인터의 마지막 자리 기록 (#3963, 마이크로 델타 H). 호버 X 가 「포인터가 움직였는가」를 재는 데 쓴다.
// =============================================================================

const move = (target: EventTarget, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));

afterEach(() => {
  resetPointerTrailForTest();
  vi.restoreAllMocks();
});

describe("포인터의 마지막 자리", () => {
  it("본 적 없으면 null 이다 - 시험용 초기화는 본 적 없음으로 되돌린다", () => {
    ensurePointerTrail();
    move(document.body, 1, 2);
    expect(lastPointerAt()).toEqual({ x: 1, y: 2 });
    resetPointerTrailForTest();
    expect(lastPointerAt()).toBeNull();
  });

  it("문서에서 일어난 마지막 mousemove 의 뷰포트 좌표를 안다", () => {
    ensurePointerTrail();
    move(document.body, 12, 34);
    expect(lastPointerAt()).toEqual({ x: 12, y: 34 });
    move(document.body, 200, 300);
    expect(lastPointerAt()).toEqual({ x: 200, y: 300 });
  });

  it("자손이 전파를 막아도 놓치지 않는다(캡처 단계에서 듣는다)", () => {
    ensurePointerTrail();
    const child = document.createElement("div");
    child.addEventListener("mousemove", (event) => event.stopPropagation());
    document.body.append(child);
    move(child, 77, 88);
    expect(lastPointerAt()).toEqual({ x: 77, y: 88 });
    child.remove();
  });

  it("여러 번 불러도 리스너는 한 번만 단다", () => {
    ensurePointerTrail(); // 이미 달렸을 수 있다: 그 뒤의 호출만 센다
    const add = vi.spyOn(document, "addEventListener");
    ensurePointerTrail();
    ensurePointerTrail();
    expect(add).not.toHaveBeenCalled();
  });
});
