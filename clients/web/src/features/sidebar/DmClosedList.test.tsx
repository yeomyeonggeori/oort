// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DmClosedMenu, type DmClosedListItem } from "./DmClosedList";

// 「⋯ › 닫은 대화」 (ADR-0177 D11, #4228). 메뉴 항목이 목록 다이얼로그를 열고, 「다시 열기」가 그 대화를 호출부에 넘긴다.

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

const ITEMS: DmClosedListItem[] = [
  { id: "00000000-0000-7000-8000-000000000301", name: "이도현", reason: "closed" },
  { id: "00000000-0000-7000-8000-000000000305", name: "나간 멤버", reason: "gone" },
];

function render(items: readonly DmClosedListItem[], handlers: { onOpenChange?: (open: boolean) => void; onReopen?: (item: DmClosedListItem) => void } = {}) {
  act(() => {
    root?.render(
      createElement(DmClosedMenu, {
        items,
        onOpenChange: handlers.onOpenChange ?? (() => undefined),
        onReopen: handlers.onReopen ?? (() => undefined),
      })
    );
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

function mountRoot() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
}

/** Radix 메뉴는 포인터·키로 열린다: 트리거에 Enter 를 보낸다. */
async function openList() {
  const trigger = document.querySelector<HTMLElement>('[data-testid="dm-section-menu"]')!;
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  const item = document.querySelector<HTMLElement>('[data-testid="dm-closed-list-open"]')!;
  await act(async () => {
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
}

describe("DmClosedMenu", () => {
  it("닫은 대화가 없으면 문이 서지 않는다", () => {
    mountRoot();
    render([]);
    expect(document.querySelector('[data-testid="dm-section-menu"]')).toBeNull();
  });

  it("「⋯」 는 닫은 대화 수를 싣고 이름을 가진 버튼이다", () => {
    mountRoot();
    render(ITEMS);
    const trigger = document.querySelector<HTMLElement>('[data-testid="dm-section-menu"]')!;
    expect(trigger.getAttribute("data-closed-count")).toBe("2");
    expect(trigger.getAttribute("aria-label")).toBe("다이렉트 메시지 메뉴");
    expect(trigger.hasAttribute("data-section-action")).toBe(true);
  });

  it("메뉴의 「닫은 대화」가 목록을 연다: 닫은 대화는 「다시 열기」, 나간 상대는 「열기」", async () => {
    mountRoot();
    render(ITEMS);
    await openList();
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="dm-closed-list-item"]')];
    expect(rows.map((row) => row.dataset.reason)).toEqual(["closed", "gone"]);
    expect(rows[0]?.textContent).toContain("이도현");
    expect(rows[0]?.textContent).toContain("내가 닫았어요");
    expect(rows[1]?.textContent).toContain("나간 멤버");
    expect(rows[1]?.textContent).toContain("상대가 나갔고 안 읽은 메시지가 없어요");
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid="dm-closed-list-reopen"]')];
    expect(buttons.map((button) => button.textContent)).toEqual(["다시 열기", "열기"]);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "이도현, 다시 열기",
      "나간 멤버, 열기",
    ]);
  });

  it("「다시 열기」는 그 대화를 호출부에 넘기고 목록을 닫는다", async () => {
    const onReopen = vi.fn();
    const onOpenChange = vi.fn();
    mountRoot();
    render(ITEMS, { onReopen, onOpenChange });
    await openList();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="dm-closed-list-reopen"]')!.click();
      await Promise.resolve();
    });
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(onReopen).toHaveBeenCalledWith(ITEMS[0]);
    expect(document.querySelector('[data-testid="dm-closed-list"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("목록이 열린 채 비면 제목과 힌트만 남지 않고 빈 상태를 말한다", async () => {
    mountRoot();
    render(ITEMS);
    await openList();
    render([]);
    expect(document.querySelector('[data-testid="dm-closed-list-empty"]')?.textContent).toBe("닫은 대화가 없어요.");
    expect(document.querySelectorAll('[data-testid="dm-closed-list-item"]')).toHaveLength(0);
  });
});
