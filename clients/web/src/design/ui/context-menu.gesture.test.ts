// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  OPENING_GESTURE_MS,
} from "./context-menu";

// =============================================================================
// 메뉴를 연 제스처의 뗌은 항목이 받지 않는다 (#3963 design-review R2 H1).
//
// macOS 는 `contextmenu` 를 누르는 순간 쏘고, 트랙패드 두 손가락 탭은 누름과 뗌이 몇 ms 사이다. 그 뗌이
// 막 열린 판의 항목 위로 떨어지면 Radix `MenuItem` 이 「누름 없는 뗌 = 끌어서 고른 것」으로 읽어 `click()`
// 한다. 여기서는 그 뗌을 그대로 쏘아(`pointerup`, 앞선 `pointerdown` 없음) 항목이 받는지를 잰다.
// 실제 엔진의 재현은 `scripts/capture-3963.mjs` 의 Q 단정이다(첫 프레임 배치는 jsdom 에 없다).
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
const onSelectA = vi.fn();
const onSelectB = vi.fn();

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  onSelectA.mockReset();
  onSelectB.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        ContextMenu,
        null,
        createElement(
          ContextMenuTrigger,
          { asChild: true },
          createElement("div", { "data-testid": "row" }, "행")
        ),
        createElement(
          ContextMenuContent,
          { "data-testid": "menu" } as Record<string, string>,
          createElement(ContextMenuItem, { onSelect: onSelectA }, "알림 끄기"),
          createElement(ContextMenuItem, { onSelect: onSelectB }, "별표 붙이기")
        )
      )
    );
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const row = () => document.querySelector<HTMLElement>('[data-testid="row"]')!;
const items = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const menuOpen = () => document.querySelector('[data-testid="menu"]') !== null;

function rightClick() {
  act(() => {
    row().dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 40,
      })
    );
  });
}

/** 포인터 이벤트(jsdom 에 PointerEvent 생성자가 없어도 React 는 이름으로 듣는다). */
function pointer(target: Element, type: "pointerdown" | "pointerup", button = 0) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button })
    );
  });
}

/** Radix 는 마운트/언마운트 포커스를 setTimeout(0) 에 태운다. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("메뉴를 연 제스처의 뗌 (#3963 R2 H1)", () => {
  it("연 직후, 메뉴 안에서 누른 적 없는 뗌은 항목이 받지 않는다 — 메뉴는 열린 채 남는다", async () => {
    rightClick();
    await flush();
    expect(items()).toHaveLength(2);
    // 두 손가락 탭: 누름은 행에서 있었고(메뉴 밖), 뗌만 첫 항목 위로 떨어진다.
    pointer(items()[0], "pointerup", 2);
    await flush();
    expect(onSelectA).not.toHaveBeenCalled();
    expect(onSelectB).not.toHaveBeenCalled();
    expect(menuOpen()).toBe(true);
  });

  it("어느 항목이든 같다 — 포인터 아래에 무엇이 있든 열림과 동시에 실행되지 않는다", async () => {
    rightClick();
    await flush();
    pointer(items()[1], "pointerup", 2);
    await flush();
    expect(onSelectB).not.toHaveBeenCalled();
    expect(onSelectA).not.toHaveBeenCalled();
  });

  it("메뉴 안에서 누른 뒤의 클릭은 열린 직후여도 고른다 — 일부러 고르는 클릭을 삼키지 않는다", async () => {
    rightClick();
    await flush();
    const target = items()[0];
    pointer(target, "pointerdown", 0);
    pointer(target, "pointerup", 0);
    act(() => target.click());
    await flush();
    expect(onSelectA).toHaveBeenCalledTimes(1);
  });

  it("메뉴 안에서 누른 채 **다른 항목** 위에서 떼도(끌어서 고르기) 열린 직후에는 막지 않는다", async () => {
    // 이 길은 Radix 의 `pointerup` 만이 고른다(떼는 항목에는 누름이 없다). 메뉴를 연 제스처의 뗌과 겉모양이 같지만
    // 메뉴 **안에서** 누름이 있었으므로 삼키지 않는다 — 삼키는 조건 둘 중 `pressedInside` 가 이 시험의 몫이다.
    rightClick();
    await flush();
    pointer(items()[0], "pointerdown", 0);
    pointer(items()[1], "pointerup", 0);
    await flush();
    expect(onSelectB).toHaveBeenCalledTimes(1);
    expect(onSelectA).not.toHaveBeenCalled();
  });

  it(`${OPENING_GESTURE_MS}ms 가 지난 뒤의 뗌은 막지 않는다 — 오래 눌러 끌어서 고르기는 그대로다`, async () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(10_000);
    rightClick();
    await flush();
    now.mockReturnValue(10_000 + OPENING_GESTURE_MS + 1);
    pointer(items()[0], "pointerup", 2);
    await flush();
    expect(onSelectA).toHaveBeenCalledTimes(1);
  });

  it(`${OPENING_GESTURE_MS}ms 안이면 막는다 — 경계 바로 안쪽`, async () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(20_000);
    rightClick();
    await flush();
    now.mockReturnValue(20_000 + OPENING_GESTURE_MS - 1);
    pointer(items()[0], "pointerup", 2);
    await flush();
    expect(onSelectA).not.toHaveBeenCalled();
  });

  it("다시 열 때는 앞 메뉴에서 누른 기록이 남지 않는다 — 새 제스처의 뗌도 막는다", async () => {
    rightClick();
    await flush();
    pointer(items()[0], "pointerdown", 0); // 앞 메뉴 안의 누름(기록이 남는 쪽)
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flush();
    onSelectA.mockReset();
    rightClick();
    await flush();
    pointer(items()[0], "pointerup", 2);
    await flush();
    expect(onSelectA).not.toHaveBeenCalled();
  });

  it("호출자의 onPointerUpCapture 도 그대로 불린다(삼키는 것은 항목으로 가는 전파뿐이다)", async () => {
    const seen = vi.fn();
    act(() => {
      root?.render(
        createElement(
          ContextMenu,
          null,
          createElement(
            ContextMenuTrigger,
            { asChild: true },
            createElement("div", { "data-testid": "row" }, "행")
          ),
          createElement(
            ContextMenuContent,
            {
              "data-testid": "menu",
              onPointerUpCapture: seen,
            } as Record<string, unknown>,
            createElement(ContextMenuItem, { onSelect: onSelectA }, "알림 끄기")
          )
        )
      );
    });
    rightClick();
    await flush();
    pointer(items()[0], "pointerup", 2);
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(onSelectA).not.toHaveBeenCalled();
  });
});
