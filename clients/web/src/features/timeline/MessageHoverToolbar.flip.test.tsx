// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { resetEmojiFrequencyForTests } from "@/features/emoji/frequencyStore";
import { MessageHoverToolbar, type MessageActionCallbacks } from "./MessageActions";

// =============================================================================
// 뒤집기 배선 시험 (#5179). 순수 규칙(`hoverToolbarModel.test.ts`)이 아니라 **마운트된 막대가** 이웃 글자를 읽어 자리를 정하는가:
// 막대가 서는 행 · 앞 이웃 · 뒤 이웃을 `data-virtuoso-scroller` 안에 세우고, 막대·행·스크롤러의 상자와 글 노드의 줄 조각은 숫자로 못 박는다
// (jsdom 은 레이아웃이 없다). 숫자는 390 열 레인 실측이다: 막대 x 151~374 y 329~371, 행 y 365~399, 앞 행 마지막 줄 x 56~214 y 337~355.
// 실제 엔진에서 같은 일이 되는지는 캡처 레인 `scripts/capture-5179.mjs` 가 잰다(이 시험은 배선이 끊기면 CI 에서 붉게 하는 몫이다).
// =============================================================================

type Box = { left: number; right: number; top: number; bottom: number };
const BOXES: Record<string, Box> = {
  scroller: { left: 0, right: 390, top: 120, bottom: 800 },
  row: { left: 4, right: 386, top: 365, bottom: 399 },
  toolbar: { left: 151, right: 374, top: 329, bottom: 371 },
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const memory = new Map<string, string>();
let mountedRoot: Root | null = null;
const originalRect = Element.prototype.getBoundingClientRect;
const originalRects = (Range.prototype as { getClientRects?: () => DOMRectList }).getClientRects;

function rectOf(box: Box): DOMRect {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  return { ...box, x: box.left, y: box.top, width, height, toJSON: () => box } as DOMRect;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // 상자는 요소가 어느 칸인지로 정한다: 스크롤러(속성) · 막대(role) · 포인터 행(id).
  Element.prototype.getBoundingClientRect = function stub(this: Element): DOMRect {
    if (this.hasAttribute("data-virtuoso-scroller")) return rectOf(BOXES.scroller!);
    if (this.getAttribute("role") === "toolbar") return rectOf(BOXES.toolbar!);
    if (this.id === "row") return rectOf(BOXES.row!);
    return rectOf({ left: 0, right: 0, top: 0, bottom: 0 });
  };
  // 글 노드의 줄 조각은 글을 든 요소의 `data-rect="left,right,top,bottom"` 로 정한다.
  (Range.prototype as { getClientRects?: () => DOMRectList }).getClientRects = function stub(this: Range) {
    const holder = this.startContainer.parentElement;
    const raw = holder?.getAttribute("data-rect");
    if (!raw) return [] as unknown as DOMRectList;
    const [left, right, top, bottom] = raw.split(",").map(Number) as [number, number, number, number];
    return [rectOf({ left, right, top, bottom })] as unknown as DOMRectList;
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  const range = Range.prototype as { getClientRects?: () => DOMRectList };
  if (originalRects) range.getClientRects = originalRects;
  else Reflect.deleteProperty(range, "getClientRects");
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiFrequencyForTests();
});
afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const available: MessageActionAvailability = { reply: true, quote: true, react: true, pin: true, remind: true, edit: true, delete: true };
const callbacks: MessageActionCallbacks = {
  onReply: () => undefined,
  onQuote: () => undefined,
  onCopy: () => undefined,
  onCopyLink: () => undefined,
  onReact: () => undefined,
  onPin: () => undefined,
  onRemind: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
};
const copyState = { canCopy: true, copied: false, canCopyLink: true, copiedLink: false, pinned: false };

/** 앞 이웃 · (막대가 서는) 행 · 뒤 이웃을 스크롤러 안에 세우고 막대를 행 안에 마운트한다. */
function mount(neighbors: { prev: string; next: string }): HTMLElement {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-virtuoso-scroller", "");
  const row = (id: string, rect: string) =>
    `<article data-testid="timeline-message" id="${id}"><div data-row-body><span data-rect="${rect}">글 ${id}</span></div></article>`;
  scroller.innerHTML = row("prev", neighbors.prev) + '<article data-testid="timeline-message" id="row"></article>' + row("next", neighbors.next);
  document.body.append(scroller);
  const host = scroller.querySelector("#row") as HTMLElement;
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(
      createElement(MessageHoverToolbar, {
        available,
        copyState,
        callbacks,
        onOpenPicker: () => undefined,
        menuOpen: false,
        onMenuOpenChange: () => undefined,
        mineEmojis: new Set<string>(),
      })
    )
  );
  return host;
}
const straddleOf = (host: HTMLElement) => host.querySelector('[data-testid="message-hover-toolbar"]')?.getAttribute("data-straddle");

const REACHING = "56,214,337,355"; // 앞 행 마지막 줄: 막대 왼쪽 끝(151)을 넘어 막대 밑에 선다
const SHORT = "56,121,337,355"; // 막대에 닿지 않는 짧은 줄
const NEXT_HEAD = "56,95,415,433"; // 뒤 행 머리 줄(이름): 아래 자리(y 393~435, x 151~374)와 가로로 떨어져 있다
const NEXT_LONG = "56,360,410,428"; // 뒤 행의 긴 첫 줄: 아래 자리 밑에 선다

describe("MessageHoverToolbar 뒤집기 배선 (#5179)", () => {
  it("앞 이웃 마지막 줄이 막대 밑에 서고 아래 자리는 뒤 이웃 글자를 안 덮으면 행 아래 경계로 뒤집는다", () => {
    expect(straddleOf(mount({ prev: REACHING, next: NEXT_HEAD }))).toBe("below");
  });

  it("아래 자리가 뒤 이웃 글자를 덮으면 위 그대로다(한 겹침을 다른 겹침으로 바꾸지 않는다)", () => {
    expect(straddleOf(mount({ prev: REACHING, next: NEXT_LONG }))).toBe("top");
  });

  it("앞 이웃 글자가 막대에 닿지 않으면 위 그대로다(덮을 것이 없으면 뒤집지 않는다)", () => {
    expect(straddleOf(mount({ prev: SHORT, next: NEXT_HEAD }))).toBe("top");
  });
});
