// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isContextPress, shouldYieldContextMenu } from "./messageContextMenuModel";
import { useContextMenuYield } from "./useContextMenuYield";

/**
 * 우클릭 양보 훅 (#5192)을 **이벤트 순서 그대로** 흉내 낸다. macOS WebKit의 순서는
 *   pointerdown(보조 버튼) → [엔진이 클릭한 낱말을 선택] → contextmenu
 * 이고, Chromium은 가운데 단계가 없다. 가운데 단계를 시험이 직접 한다(`engineSelectsWord`).
 * 진짜 엔진에서의 같은 장면은 레인 `scripts/capture-5192.mjs`(WebKit·Chromium)가 잰다.
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
  document.getSelection()?.removeAllRanges();
});

/** 행 둘 + 버블 단계 감시자: 양보하면 감시자(Radix 트리거 자리)가 못 받는다. */
function mount() {
  const bubbled = vi.fn();
  function Row({ id }: { id: string }) {
    const ref = useRef<HTMLElement | null>(null);
    const yieldHandlers = useContextMenuYield(ref);
    return createElement(
      "article",
      { ref, "data-testid": id, onContextMenu: bubbled, ...yieldHandlers },
      createElement("p", { "data-testid": `${id}-text` }, "배포 전에 체크리스트를 한 번만 같이 봐 주세요")
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement("div", null, createElement(Row, { id: "a" }), createElement(Row, { id: "b" }))));
  const el = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  return { bubbled, el, text: (id: string) => host.querySelector(`[data-testid="${id}-text"]`) as HTMLElement };
}

const selection = () => document.getSelection() as Selection;

/** 낱말(글 노드 안의 구간)을 고른다. */
function selectWord(p: HTMLElement) {
  const node = p.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 2);
  selection().removeAllRanges();
  selection().addRange(range);
}

function press(target: Element, init: { button: number; ctrlKey?: boolean }) {
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, ...init }));
  });
}
function contextMenu(target: Element): boolean {
  let notCancelled = true;
  act(() => {
    notCancelled = target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  });
  return notCancelled;
}

describe("우클릭 양보 훅", () => {
  it("엔진이 우클릭 때문에 만든 낱말 선택(WebKit)은 양보하지 않는다: 앱 메뉴 자리가 이벤트를 받고, 그 선택은 지워진다", () => {
    const { bubbled, el, text } = mount();
    press(el("a"), { button: 2 }); // 누르는 순간엔 선택이 없다
    selectWord(text("a")); // 엔진의 낱말 선택(contextmenu 직전)
    expect(selection().isCollapsed).toBe(false);

    contextMenu(el("a"));

    expect(bubbled).toHaveBeenCalledTimes(1); // 트리거(버블 단계)까지 닿았다 = 앱 메뉴가 열린다
    expect(selection().rangeCount === 0 || selection().isCollapsed).toBe(true); // 낱말이 파랗게 남지 않는다
  });

  it("사용자가 우클릭 전에 고른 선택은 기본 메뉴에 양보한다: 트리거가 이벤트를 못 받고 선택은 남는다", () => {
    const { bubbled, el, text } = mount();
    selectWord(text("a")); // 사용자가 먼저 고름
    press(el("a"), { button: 2 });

    contextMenu(el("a"));

    expect(bubbled).not.toHaveBeenCalled();
    expect(selection().isCollapsed).toBe(false);
  });

  it("Chromium의 순서(엔진 선택 없음)에서는 선택이 없으니 늘 앱 메뉴다", () => {
    const { bubbled, el } = mount();
    press(el("a"), { button: 2 });
    contextMenu(el("a"));
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("다른 행의 선택은 이 행의 우클릭을 막지 않는다", () => {
    const { bubbled, el, text } = mount();
    selectWord(text("b"));
    press(el("a"), { button: 2 });
    contextMenu(el("a"));
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("키보드로 연 컨텍스트 메뉴(누른 기록 없음)는 지금 선택으로 판단한다: 선택이 있으면 양보, 없으면 앱 메뉴", () => {
    const { bubbled, el, text } = mount();
    selectWord(text("a"));
    contextMenu(el("a"));
    expect(bubbled).not.toHaveBeenCalled();

    selection().removeAllRanges();
    contextMenu(el("a"));
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("오래된 우클릭 기록은 왼쪽 누르기가 지운다: 그 뒤 키보드 컨텍스트 메뉴가 옛 기록을 잘못 읽지 않는다", () => {
    const { bubbled, el, text } = mount();
    press(el("a"), { button: 2 }); // 선택 없음으로 기록
    press(el("a"), { button: 0 }); // 왼쪽 누르기 → 기록 지움
    selectWord(text("a")); // 사용자가 고름
    contextMenu(el("a")); // 키보드로 연 메뉴
    expect(bubbled).not.toHaveBeenCalled(); // 옛 기록(없음)이 아니라 지금 선택으로 양보
  });

  it("기록은 한 번 쓰고 비운다: 같은 눌림의 두 번째 contextmenu는 기록 없음으로 판단한다", () => {
    const { bubbled, el, text } = mount();
    press(el("a"), { button: 2 });
    contextMenu(el("a")); // 기록 소비, 선택 없음 → 앱 메뉴
    expect(bubbled).toHaveBeenCalledTimes(1);
    selectWord(text("a"));
    contextMenu(el("a")); // 기록 없음 + 지금 선택 있음 → 양보
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("맥의 Ctrl+클릭도 우클릭으로 센다(그 입력도 엔진이 낱말을 고르고 contextmenu를 쏜다)", () => {
    const { bubbled, el, text } = mount();
    press(el("a"), { button: 0, ctrlKey: true });
    selectWord(text("a")); // 엔진의 낱말 선택
    contextMenu(el("a"));
    expect(bubbled).toHaveBeenCalledTimes(1);
  });
});

describe("우클릭 양보의 판단 (#5192, macOS WebKit은 우클릭한 낱말을 스스로 고른다)", () => {
  it("누르기 전에 이 행에 선택이 있었고 지금도 있으면 사용자가 고른 선택이라 양보한다", () => {
    expect(shouldYieldContextMenu(true, true)).toBe(true);
  });

  it("누르기 전엔 없었는데 지금 있으면 엔진이 만든 낱말 선택이라 양보하지 않는다(앱 메뉴가 열린다)", () => {
    expect(shouldYieldContextMenu(false, true)).toBe(false);
  });

  it("선택이 없으면 어느 경우에도 양보할 것이 없다", () => {
    expect(shouldYieldContextMenu(false, false)).toBe(false);
    expect(shouldYieldContextMenu(true, false)).toBe(false);
    expect(shouldYieldContextMenu(null, false)).toBe(false);
  });

  it("누른 기록이 없으면(키보드로 연 컨텍스트 메뉴) 지금 선택으로 판단한다: 예전 규칙 그대로", () => {
    expect(shouldYieldContextMenu(null, true)).toBe(true);
  });

  it("우클릭을 누르는 입력: 보조 버튼, 그리고 맥의 Ctrl+클릭. 평범한 왼쪽 클릭은 아니다", () => {
    expect(isContextPress({ button: 2, ctrlKey: false })).toBe(true);
    expect(isContextPress({ button: 0, ctrlKey: true })).toBe(true);
    expect(isContextPress({ button: 0, ctrlKey: false })).toBe(false);
    expect(isContextPress({ button: 1, ctrlKey: false })).toBe(false);
  });
});

