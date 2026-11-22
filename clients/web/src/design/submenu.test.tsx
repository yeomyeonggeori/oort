// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  SUBMENU_LOCKED_ROW_ERROR,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";

// =============================================================================
// 하위 메뉴 부품 (#5777, owner 2026-11-14) — 규칙 「고를 수 없는 줄이 없는 묶음에만」의 가드와 여는 줄의 모양.
//
// 규칙의 이유는 `dropdown-menu.tsx` 머리말에 있다: 고를 수 없는 줄은 이유와 함께 화면에 남아야 하는데
// 하위 메뉴는 그 이유를 한 겹 안으로 숨긴다. 그래서 하위 판 안에 잠긴 줄(`data-disabled`)이 서면 개발 중
// 오류를 낸다. 이 파일은 그 가드가 **실제로 울리는지**(잠긴 줄) 와 **헛울리지 않는지**(잠긴 줄 없음)를
// 두 메뉴(드롭다운 · 컨텍스트) 모두에서 잰다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.restoreAllMocks();
});

function mount(node: ReactNode) {
  mountedHost = document.createElement("div");
  document.body.append(mountedHost);
  mountedRoot = createRoot(mountedHost);
  act(() => mountedRoot?.render(node));
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(target: HTMLElement | null) {
  if (!target) throw new Error("누를 것이 없다");
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** 드롭다운: 열린 판 안에 「복사 ›」 하나, 그 하위 판에 줄 둘(하나는 `locked` 이면 잠긴 줄). */
function dropdown(locked: boolean) {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>열기</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>앞 줄</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="sub-trigger">복사</DropdownMenuSubTrigger>
          <DropdownMenuSubContent data-testid="sub-panel">
            <DropdownMenuItem>이름 복사하기</DropdownMenuItem>
            <DropdownMenuItem disabled={locked}>링크 복사하기</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 컨텍스트 메뉴: 우클릭으로 연 판 안에 같은 모양. */
function contextMenu(locked: boolean) {
  return (
    <ContextMenu>
      <ContextMenuTrigger data-testid="ctx-trigger">행</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>앞 줄</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="sub-trigger">복사</ContextMenuSubTrigger>
          <ContextMenuSubContent data-testid="sub-panel">
            <ContextMenuItem>이름 복사하기</ContextMenuItem>
            <ContextMenuItem disabled={locked}>링크 복사하기</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function openContextMenu() {
  act(() => {
    byTestId("ctx-trigger")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    );
  });
}

describe("하위 메뉴 여는 줄 (#5777)", () => {
  it("여는 줄은 다른 줄과 같은 자를 입고, 끝에 숨긴 › 가 서며, 하위 판을 연다", () => {
    mount(dropdown(false));
    const trigger = byTestId("sub-trigger");
    expect(trigger?.getAttribute("role")).toBe("menuitem");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    // 다른 줄과 같은 32px 자(`h-control`)와 안쪽 여백 · 간격.
    for (const cls of ["h-control", "px-2", "gap-2"]) {
      expect(trigger?.className.split(/\s+/)).toContain(cls);
    }
    const chevron = trigger?.querySelector("[data-submenu-chevron]");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger?.lastElementChild).toBe(chevron);
    expect(byTestId("sub-panel")).toBeNull();
    click(trigger);
    const panel = byTestId("sub-panel");
    expect(panel?.getAttribute("role")).toBe("menu");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    // 하위 판은 Radix 가 여는 줄을 이름으로 단다.
    expect(panel?.getAttribute("aria-labelledby")).toBe(trigger?.id);
    // 부모 판과 같은 층 · 그릇, 창보다 길면 판 안에서 스크롤.
    expect(panel?.getAttribute("data-overlay-layer")).toBe("surface");
    for (const cls of ["layer-overlay-surface", "rounded-lg", "border-line", "p-1", "max-h-menu-available"]) {
      expect(panel?.className.split(/\s+/)).toContain(cls);
    }
  });
});

describe("규칙 가드: 하위 판에 고를 수 없는 줄이 서면 개발 중 오류 (#5777)", () => {
  for (const [name, render, open] of [
    ["드롭다운", dropdown, () => undefined],
    ["컨텍스트 메뉴", contextMenu, openContextMenu],
  ] as const) {
    it(`${name}: 잠긴 줄이 든 하위 판은 오류를 낸다`, () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mount(render(true));
      open();
      click(byTestId("sub-trigger"));
      expect(byTestId("sub-panel")).not.toBeNull();
      expect(error.mock.calls.filter((call) => call[0] === SUBMENU_LOCKED_ROW_ERROR)).toHaveLength(1);
    });

    it(`${name}: 잠긴 줄이 없는 하위 판은 조용하다`, () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mount(render(false));
      open();
      click(byTestId("sub-trigger"));
      expect(byTestId("sub-panel")).not.toBeNull();
      expect(error.mock.calls.filter((call) => call[0] === SUBMENU_LOCKED_ROW_ERROR)).toHaveLength(0);
    });
  }

  it("가드는 하위 판만 본다: 위 판의 잠긴 줄(이유와 함께 화면에 남는 줄)은 규칙 그대로다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(
      <DropdownMenu open>
        <DropdownMenuTrigger>열기</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled>낡은 맥 (오프라인)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(document.querySelector("[data-disabled]")).not.toBeNull();
    expect(error.mock.calls.filter((call) => call[0] === SUBMENU_LOCKED_ROW_ERROR)).toHaveLength(0);
  });
});
