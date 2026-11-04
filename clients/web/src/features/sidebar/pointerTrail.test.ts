// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePointerTrail, lastPointerAt, onNextPointerMove, resetPointerTrailForTest } from "./pointerTrail";

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

// #5191 - 「포인터가 다음에 움직일 때 한 번」. 편집이 끝난 행이 낡은 호버를 그때 다시 읽는 데 쓴다.
describe("포인터가 다음에 움직일 때", () => {
  it("다음 mousemove 에서 한 번만 불리고, 그 뒤의 움직임에는 불리지 않는다", () => {
    const watcher = vi.fn();
    onNextPointerMove(watcher);
    expect(watcher).not.toHaveBeenCalled();
    move(document.body, 5, 6);
    expect(watcher).toHaveBeenCalledTimes(1);
    move(document.body, 7, 8);
    move(document.body, 9, 10);
    expect(watcher).toHaveBeenCalledTimes(1);
  });

  it("풀면 불리지 않는다", () => {
    const watcher = vi.fn();
    const release = onNextPointerMove(watcher);
    release();
    move(document.body, 5, 6);
    expect(watcher).not.toHaveBeenCalled();
  });

  it("기다리는 호출이 여럿이어도 각자 한 번씩 부른다", () => {
    const first = vi.fn();
    const second = vi.fn();
    onNextPointerMove(first);
    onNextPointerMove(second);
    move(document.body, 1, 1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("부르는 중에 다시 건 호출은 그다음 이동을 기다린다(같은 이동에 또 불리지 않는다)", () => {
    const again = vi.fn();
    const watcher = vi.fn(() => {
      onNextPointerMove(again);
    });
    onNextPointerMove(watcher);
    move(document.body, 1, 1);
    expect(watcher).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
    move(document.body, 2, 2);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("기다리는 호출이 있어도 위치 기록은 그대로다", () => {
    onNextPointerMove(() => undefined);
    move(document.body, 30, 40);
    expect(lastPointerAt()).toEqual({ x: 30, y: 40 });
  });

  it("호출만으로 리스너가 늘지 않는다(한 번만 단다)", () => {
    ensurePointerTrail();
    const add = vi.spyOn(document, "addEventListener");
    onNextPointerMove(() => undefined);
    onNextPointerMove(() => undefined);
    expect(add).not.toHaveBeenCalled();
  });
});
