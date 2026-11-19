// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_CONFIRM_MS } from "@/design/ui/inlineConfirm";
import { DmLeaveReceiptRow } from "./DmLeaveHost";
import {
  holdDmLeaveReceipts,
  resetDmLeaveStoreForTest,
  showDmLeaveReceipt,
  useDmLeaveStore,
} from "./dmLeaveStore";

// =============================================================================
// 영수증의 걷힘 (ADR-0177 증보 2026-11-14 D21, #5825 · 검수 r1 M4).
//
// 걷히면 아래 줄이 한 칸 올라오므로 사람이 겨눈 줄이 바뀌지 않게 미룬다: 포인터가 목록 안이면 · 목록에서 연 메뉴(포털)가 열려 있으면.
// 메뉴 판은 포털이라 메뉴를 열면 포인터가 목록을 나간 것으로 치는데, 그 순간 걷으면 메뉴를 연 줄이 올라온다(실측 690 → 654).
// jsdom 에는 `:hover` 가 없어 목록 판의 `matches(":hover")` 를 시험이 정한다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000301";

let root: Root | null = null;
let host: HTMLElement | null = null;
let pane: HTMLElement;
let hovered = false;

// 사이드바의 `listPaneRef` 처럼 다시 그려져도 같은 객체다(효과의 시계가 다시 걸리지 않는다).
const paneRef = createRef<HTMLElement>();

function Receipts() {
  const { receipts } = useDmLeaveStore();
  const ref = paneRef;
  return createElement(
    "ul",
    null,
    receipts.map((receipt) => createElement(DmLeaveReceiptRow, { key: receipt.id, receipt, paneRef: ref }))
  );
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Receipts));
  });
}

const receiptCount = () => host!.querySelectorAll('[data-testid="dm-leave-receipt"]').length;
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  resetDmLeaveStoreForTest();
  pane = document.createElement("div");
  document.body.append(pane);
  (paneRef as { current: HTMLElement | null }).current = pane;
  hovered = false;
  const realMatches = pane.matches.bind(pane);
  pane.matches = (selector: string) => (selector === ":hover" ? hovered : realMatches(selector));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  pane.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("영수증이 걷히는 때", () => {
  it("아무것도 붙들지 않으면 1.6초 뒤에 걷힌다", async () => {
    await mount();
    await act(async () => showDmLeaveReceipt(WS, CH));
    expect(receiptCount()).toBe(1);
    await advance(INLINE_CONFIRM_MS - 10);
    expect(receiptCount()).toBe(1);
    await advance(20);
    expect(receiptCount()).toBe(0);
  });

  it("목록에서 연 메뉴가 열려 있는 동안은 걷히지 않고, 닫히고 포인터가 목록 밖이면 걷힌다 (M4)", async () => {
    await mount();
    await act(async () => showDmLeaveReceipt(WS, CH));
    let release!: () => void;
    await act(async () => {
      release = holdDmLeaveReceipts();
    });
    // 메뉴 판은 포털 - 포인터가 목록을 나간 것으로 친다.
    await act(async () => {
      pane.dispatchEvent(new Event("pointerleave"));
    });
    await advance(INLINE_CONFIRM_MS + 2_000);
    expect(receiptCount()).toBe(1);
    await act(async () => release());
    await advance(300);
    expect(receiptCount()).toBe(0);
  });

  it("메뉴가 닫혔어도 포인터가 아직 목록 안이면 목록을 떠나는 순간에 걷힌다", async () => {
    await mount();
    await act(async () => showDmLeaveReceipt(WS, CH));
    hovered = true;
    let release!: () => void;
    await act(async () => {
      release = holdDmLeaveReceipts();
    });
    await advance(INLINE_CONFIRM_MS + 200);
    await act(async () => release());
    await advance(300);
    expect(receiptCount()).toBe(1);
    hovered = false;
    await act(async () => {
      pane.dispatchEvent(new Event("pointerleave"));
    });
    expect(receiptCount()).toBe(0);
  });
});
