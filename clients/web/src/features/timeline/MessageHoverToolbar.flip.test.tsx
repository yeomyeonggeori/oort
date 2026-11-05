// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { resetEmojiFrequencyForTests } from "@/features/emoji/frequencyStore";
import { MessageHoverToolbar, type MessageActionCallbacks } from "./MessageActions";
import { belowStraddleRect } from "./hoverToolbarModel";

// =============================================================================
// 뒤집기 배선 시험 (#5179). 순수 규칙(`hoverToolbarModel.test.ts`)이 아니라 **마운트된 막대가** 이웃 글자를 읽어 자리를 정하는가:
// 막대가 서는 행 · 앞 이웃 · 뒤 이웃을 `data-virtuoso-scroller` 안에 세우고, 막대·행·스크롤러의 상자와 글 노드의 줄 조각은 숫자로 못 박는다
// (jsdom 은 레이아웃이 없다). 숫자는 390 열 레인 실측이다: 막대 x 151~374 y 329~371, 행 y 365~399, 앞 행 마지막 줄 x 56~214 y 337~355.
// 실제 엔진에서 같은 일이 되는지는 캡처 레인 `scripts/capture-5179.mjs` 가 잰다(이 시험은 배선이 끊기면 CI 에서 붉게 하는 몫이다).
// 뒤집기(`data-straddle`)와 행 안쪽으로 밀기(막대의 `--hover-toolbar-slide` 변수, 위 자리에서 아래로 px)를 모두 잰다.
//
// 다시 재기 (#5307 M1): 포인터가 행 위에 머문 채 레이아웃이 바뀌면(입력창 위에 작업 띠가 서서 스크롤러가 줄어든다) 막대는 마운트 때 정한 자리를 붙들면 안 된다.
// `ResizeObserver` 는 jsdom 에 없으므로 이 파일이 손으로 알림을 보내는 대역을 세운다. 막대 상자의 대역은 막대가 **지금 서 있는 자리**(`data-straddle` · 밀림 · 비낌)를
// 따라가야 다시 잴 때 위 자리 상자를 되돌리는 계산이 실제처럼 돈다.
// =============================================================================

type Box = { left: number; right: number; top: number; bottom: number };
const DEFAULT_BOXES: Record<string, Box> = {
  scroller: { left: 0, right: 390, top: 120, bottom: 800 },
  row: { left: 4, right: 386, top: 365, bottom: 399 },
  toolbar: { left: 151, right: 374, top: 329, bottom: 371 },
};
const BOXES: Record<string, Box> = structuredClone(DEFAULT_BOXES);

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

/** 막대가 지금 서 있는 상자: 위 자리 상자(`BOXES.toolbar`)에서 아래로 뒤집혔으면 아래 자리로, 아니면 밀림만큼 내리고, 비낌만큼 오른쪽으로 민다. */
function placedToolbarBox(bar: Element): Box {
  const el = bar as HTMLElement;
  const below = el.getAttribute("data-straddle") === "below";
  const slide = Number.parseFloat(el.style.getPropertyValue("--hover-toolbar-slide")) || 0;
  const nudge = Number.parseFloat(el.style.getPropertyValue("--hover-toolbar-nudge")) || 0;
  const rest = BOXES.toolbar!;
  const base = below ? belowStraddleRect(rest, BOXES.row!) : { ...rest, top: rest.top + slide, bottom: rest.bottom + slide };
  return { left: base.left + nudge, right: base.right + nudge, top: base.top, bottom: base.bottom };
}

/** `ResizeObserver` 대역: 관찰 칸을 기억하고, 테스트가 `notifyResize` 로 알림을 손으로 보낸다. */
interface StubObserver {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}
const observers = new Set<StubObserver>();
function stubResizeObserver(): void {
  class Stub {
    private readonly record: StubObserver;
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: new Set() };
      observers.add(this.record);
    }
    observe(target: Element): void {
      this.record.targets.add(target);
    }
    unobserve(target: Element): void {
      this.record.targets.delete(target);
    }
    disconnect(): void {
      this.record.targets.clear();
      observers.delete(this.record);
    }
  }
  vi.stubGlobal("ResizeObserver", Stub);
}
/** 관찰 중인 칸마다 지금 크기를 알린다. 스크롤러는 `BOXES.scroller` 의 높이, 나머지는 고정 크기다. */
function notifyResize(): void {
  const sizeOf = (target: Element) =>
    target.hasAttribute("data-virtuoso-scroller")
      ? { width: 390, height: BOXES.scroller!.bottom - BOXES.scroller!.top }
      : { width: 382, height: 34 };
  for (const record of Array.from(observers)) {
    const entries = Array.from(record.targets).map((target) => ({ target, contentRect: sizeOf(target) }));
    act(() => record.callback(entries as unknown as ResizeObserverEntry[], record as unknown as ResizeObserver));
  }
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // 상자는 요소가 어느 칸인지로 정한다: 스크롤러(속성) · 막대(role) · 포인터 행(id).
  Element.prototype.getBoundingClientRect = function stub(this: Element): DOMRect {
    if (this.hasAttribute("data-virtuoso-scroller")) return rectOf(BOXES.scroller!);
    if (this.getAttribute("role") === "toolbar") return rectOf(placedToolbarBox(this));
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
  stubResizeObserver();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiFrequencyForTests();
});
afterEach(() => {
  observers.clear();
  BOXES.scroller = { ...DEFAULT_BOXES.scroller! };
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

/**
 * 앞 이웃 · (막대가 서는) 행 · 뒤 이웃을 스크롤러 안에 세우고 막대를 행 안에 마운트한다. `own` 은 포인터 행 본문의 줄 조각(`data-rect`)이다 —
 * 막대는 본문 상자(`data-row-body`) 밖에 서므로 막대 자신의 글은 이웃으로 세지 않는다.
 */
function mount(neighbors: { prev: string; next: string }, own?: string, menuOpen = false): HTMLElement {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-virtuoso-scroller", "");
  const row = (id: string, rect: string) =>
    `<article data-testid="timeline-message" id="${id}"><div data-row-body><span data-rect="${rect}">글 ${id}</span></div></article>`;
  const ownBody = own ? `<div data-row-body><span data-rect="${own}">글 own</span></div>` : "";
  scroller.innerHTML =
    row("prev", neighbors.prev) +
    `<article data-testid="timeline-message" id="row">${ownBody}<div id="slot"></div></article>` +
    row("next", neighbors.next);
  document.body.append(scroller);
  const host = scroller.querySelector("#slot") as HTMLElement;
  mountedRoot = createRoot(host);
  act(() =>
    mountedRoot?.render(
      createElement(MessageHoverToolbar, {
        available,
        copyState,
        callbacks,
        onOpenPicker: () => undefined,
        menuOpen,
        onMenuOpenChange: () => undefined,
        mineEmojis: new Set<string>(),
      })
    )
  );
  return host;
}
const barOf = (host: HTMLElement) => host.querySelector('[data-testid="message-hover-toolbar"]') as HTMLElement;
const straddleOf = (host: HTMLElement) => barOf(host).getAttribute("data-straddle");
/** 막대가 건 밀림(px, 위 자리에서 아래로). 걸지 않았으면 빈 문자열이다. */
const slideOf = (host: HTMLElement) => barOf(host).style.getPropertyValue("--hover-toolbar-slide");
/** 막대가 건 가로 비끼기(px, 오른쪽으로). 걸지 않았으면 빈 문자열이다. */
const nudgeOf = (host: HTMLElement) => barOf(host).style.getPropertyValue("--hover-toolbar-nudge");

const REACHING = "56,214,337,355"; // 앞 행 마지막 줄: 막대 왼쪽 끝(151)을 넘어 막대 밑에 선다
const SHORT = "56,121,337,355"; // 막대에 닿지 않는 짧은 줄
const NEXT_HEAD = "56,95,415,433"; // 뒤 행 머리 줄(이름): 아래 자리(y 393~435, x 151~374)와 가로로 떨어져 있다
const NEXT_LONG = "56,360,410,428"; // 뒤 행의 긴 첫 줄: 아래 자리 밑에 선다
const OWN_SHORT = "56,116,374,392"; // 포인터 행의 짧은 글: 막대 가로 범위(151~374) 밖
const OWN_LONG = "56,254,374,392"; // 포인터 행의 한 줄 긴 글: 막대 밑까지 온다
const REACHING_BY_ONE = "56,152,337,355"; // 앞 행 끝줄 오른끝이 막대 왼쪽 끝(151)을 1px 넘는다
const REACHING_BY_NINE = "56,160,337,355"; // 9px 넘는다: 비껴서 풀 일이 아니다

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

  it("뒤집기는 밀기보다 먼저다: 아래 자리가 비면 행 안쪽으로 밀지 않고 아래로 뒤집는다(1차 수리의 자리 그대로)", () => {
    const host = mount({ prev: REACHING, next: NEXT_HEAD }, OWN_SHORT);
    expect(straddleOf(host)).toBe("below");
    expect(slideOf(host)).toBe("");
  });

  it("앞 글줄이 막대에 안 닿으면 밀지 않는다(위 그대로, 밀림 변수 없음)", () => {
    const host = mount({ prev: SHORT, next: NEXT_LONG }, OWN_SHORT);
    expect(straddleOf(host)).toBe("top");
    expect(slideOf(host)).toBe("");
  });
});

describe("MessageHoverToolbar 가로 비끼기 배선 (#5179)", () => {
  it("앞 글줄 끝이 막대 왼쪽 끝을 1px 넘는 경계는 1px 비껴 위 그대로 선다(밀지 않는다)", () => {
    const host = mount({ prev: REACHING_BY_ONE, next: NEXT_LONG }, OWN_SHORT);
    expect(straddleOf(host)).toBe("top");
    expect(nudgeOf(host)).toBe("1");
    expect(slideOf(host)).toBe("");
  });

  it("비껴 뒤집으면 비끼기 변수가 막대에 남는다(자리 이름이 below 로 바뀌어도)", () => {
    // 뒤 이웃 머리 줄 시각(x 90~152)이 아래 자리 왼쪽 끝(151)을 1px 넘는다 → 1px 비껴야 아래 자리가 빈다.
    const host = mount({ prev: REACHING, next: "90,152,415,433" }, OWN_SHORT);
    expect(straddleOf(host)).toBe("below");
    expect(nudgeOf(host)).toBe("1");
  });

  it("9px 넘게 닿으면 비끼지 않는다(밀기도 창이 없으면 위 그대로, 변수 없음)", () => {
    const host = mount({ prev: REACHING_BY_NINE, next: NEXT_LONG }, OWN_LONG);
    expect(straddleOf(host)).toBe("top");
    expect(nudgeOf(host)).toBe("");
    expect(slideOf(host)).toBe("");
  });

  it("닿지 않으면 비끼지 않는다(변수 없음)", () => {
    expect(nudgeOf(mount({ prev: SHORT, next: NEXT_HEAD }))).toBe("");
  });
});

describe("MessageHoverToolbar 밀기 배선 (#5179 남은 경우 C·F)", () => {
  it("위·아래가 모두 글자에 막히고 포인터 행 글이 짧으면 막대가 행 안쪽으로 밀려 앉는다(위 자리에서 아래로 28px, 자리 이름은 위 그대로)", () => {
    // 앞 글줄 밑단 355 + 틈 2 = 357 → 위 자리 윗단 329 에서 28 아래. 막대 밑단 399 는 뒤 글줄 윗단 410 에 닿지 않는다.
    const host = mount({ prev: REACHING, next: NEXT_LONG }, OWN_SHORT);
    expect(straddleOf(host)).toBe("top");
    expect(slideOf(host)).toBe("28");
  });

  it("포인터 행의 글도 막대 밑까지 오면 창이 없다 — 위 그대로이고 밀림 변수도 없다(남은 경우)", () => {
    const host = mount({ prev: REACHING, next: NEXT_LONG }, OWN_LONG);
    expect(straddleOf(host)).toBe("top");
    expect(slideOf(host)).toBe("");
  });

  it("포인터 행 본문 상자가 없으면(막는 글이 없다) 앞·뒤 글줄만으로 정한다", () => {
    // 막대 자신의 글이 포인터 행의 글로 읽히지 않는지는 실제 엔진 레인(`capture-5179.mjs` C·F)이 잰다: 읽혔다면 막대 이모지 글줄이 자기 위치를 막아 창이 없다.
    const host = mount({ prev: REACHING, next: NEXT_LONG });
    expect(slideOf(host)).toBe("28");
  });
});

describe("MessageHoverToolbar 다시 재기 (#5307 M1): 포인터가 머문 채 레이아웃이 바뀐다", () => {
  it("마운트 때 아래 자리가 스크롤러 안이었어도, 스크롤러가 줄어 밖이 되면 아래로 두지 않고 행 안쪽으로 다시 앉는다", () => {
    const host = mount({ prev: REACHING, next: NEXT_HEAD }, OWN_SHORT);
    expect(straddleOf(host)).toBe("below");
    notifyResize(); // 관찰을 시작할 때의 처음 알림: 같은 자리가 나오므로 아무것도 바뀌지 않는다
    expect(straddleOf(host)).toBe("below");
    expect(slideOf(host)).toBe("");
    // 입력창 위에 작업 띠가 서서 스크롤러 바닥이 올라온다. 아래 자리 밑단(399 − 6 + 42 = 435)이 바닥(420)을 넘는다.
    BOXES.scroller!.bottom = 420;
    notifyResize();
    expect(straddleOf(host)).toBe("top");
    expect(slideOf(host)).toBe("28");
    // 막대 상자(위 자리 329 + 밀림 28 = 357 ~ 399)가 스크롤러(120 ~ 420) 안이다.
    const rect = barOf(host).getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(BOXES.scroller!.top);
    expect(rect.bottom).toBeLessThanOrEqual(BOXES.scroller!.bottom);
  });

  it("스크롤러가 다시 커지면 처음 정한 자리로 돌아온다(밀림 변수는 지운다)", () => {
    const host = mount({ prev: REACHING, next: NEXT_HEAD }, OWN_SHORT);
    notifyResize();
    BOXES.scroller!.bottom = 420;
    notifyResize();
    expect(slideOf(host)).toBe("28");
    BOXES.scroller!.bottom = 800;
    notifyResize();
    expect(straddleOf(host)).toBe("below");
    expect(slideOf(host)).toBe("");
  });

  it("메뉴가 열려 있는 동안은 얼린다: 열린 메뉴가 붙든 막대가 옮겨 다니지 않는다", () => {
    const host = mount({ prev: REACHING, next: NEXT_HEAD }, OWN_SHORT, true);
    expect(straddleOf(host)).toBe("below");
    notifyResize();
    BOXES.scroller!.bottom = 420;
    notifyResize();
    expect(straddleOf(host)).toBe("below");
    expect(slideOf(host)).toBe("");
  });

  it("언마운트하면 관찰을 끊는다", () => {
    mount({ prev: REACHING, next: NEXT_HEAD }, OWN_SHORT);
    expect(observers.size).toBe(1);
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(observers.size).toBe(0);
  });
});
