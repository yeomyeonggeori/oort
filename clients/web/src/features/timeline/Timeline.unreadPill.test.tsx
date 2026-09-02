// @vitest-environment jsdom

import {
  act,
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { Timeline } from "./Timeline";
import { unreadDividerIndexOf } from "./navigation";
import { buildTimelineItems } from "@momo/core/features/timeline/model";

const FIRST = 1_000_000;

type RangeHandler = (range: { startIndex: number; endIndex: number }) => void;
type ScrollerHandler = (node: HTMLElement | Window | null) => void;

const virtuoso = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  rangeChanged: null as RangeHandler | null,
  atBottomStateChange: null as ((bottom: boolean) => void) | null,
  scrollerRef: null as ScrollerHandler | null,
  renderUnread: true,
  data: [] as { kind: string; key: string }[],
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
      rangeChanged?: RangeHandler;
      scrollerRef?: ScrollerHandler;
      atBottomStateChange?: (bottom: boolean) => void;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.rangeChanged = props.rangeChanged ?? null;
    virtuoso.atBottomStateChange = props.atBottomStateChange ?? null;
    virtuoso.scrollerRef = props.scrollerRef ?? null;
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({
      scrollToIndex: (opts: unknown) => {
        virtuoso.scrollToIndex(opts);
        if (
          opts !== null &&
          typeof opts === "object" &&
          "done" in opts &&
          typeof opts.done === "function"
        ) {
          opts.done();
        }
      },
    }));
    const scrollerRef = props.scrollerRef;
    useEffect(() => {
      const root = document.querySelector("[data-testid='timeline-virtuoso']");
      scrollerRef?.(root instanceof HTMLElement ? root : null);
      return () => scrollerRef?.(null);
    }, [scrollerRef]);
    const rows = virtuoso.renderUnread
      ? props.data
      : props.data.filter((item) => item.kind !== "unread");
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      rows.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

vi.mock("./MessageRow", () => ({
  DayDivider: () => createElement("div", { "data-testid": "day-divider" }),
  RecoveryDivider: () => createElement("div", { "data-testid": "recovery-divider" }),
  UnreadDivider: ({ count }: { count: number }) =>
    createElement("div", { "data-testid": "unread-divider" }, `새 메시지 ${count}개`),
  MessageRow: ({ message }: { message: { seq: number } }) =>
    createElement("div", {
      "data-testid": "timeline-message",
      "data-seq": message.seq,
      tabIndex: 0,
    }),
}));

type IoCallback = (entries: IntersectionObserverEntry[]) => void;
let ioCallback: IoCallback | null = null;
let reducedMotion = false;
let rafImmediate = true;
let rafQueue: FrameRequestCallback[] = [];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

const OTHER = "00000000-0000-7000-8000-000000000101";
const ME = "00000000-0000-7000-8000-0000000001ff";
const CHANNEL = "0199cccc-0000-7000-8000-000000000201";

function message(seq: number, authorMemberId: string = OTHER): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CHANNEL,
    seq,
    authorMemberId,
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    hlcTs: 1_700_000_000_000 + seq * 1_000,
    hlcCount: 0,
  };
}

const DIRECTORY = makeDirectory([]);

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  virtuoso.scrollToIndex.mockReset();
  virtuoso.rangeChanged = null;
  virtuoso.scrollerRef = null;
  virtuoso.renderUnread = true;
  virtuoso.data = [];
  ioCallback = null;
  reducedMotion = false;
  rafImmediate = true;
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    if (rafImmediate) {
      cb(0);
      return 1;
    }
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IoCallback) {
        ioCallback = cb;
      }
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        ioCallback = null;
      }
    }
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function mountTimeline(
  over: {
    messages?: Message[];
    lastReadSeq?: number | null;
    unreadCount?: number;
    myMemberId?: string;
    holdAlign?: boolean;
  } = {}
): HTMLElement {
  rafImmediate = over.holdAlign !== true;
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const messages = over.messages ?? [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq));
  act(() => {
    mountedRoot?.render(
      createElement(Timeline, {
        messages,
        directory: DIRECTORY,
        status: "ready",
        lastReadSeq: over.lastReadSeq ?? 3,
        unreadCount: over.unreadCount ?? 5,
        actions: {
          myMemberId: over.myMemberId ?? ME,
          onToggleReaction: () => undefined,
          onTogglePin: () => undefined,
          onEditMessage: async () => undefined,
          onDeleteMessage: async () => undefined,
        },
      })
    );
  });
  return host;
}

function reportRange(dataStart: number, dataEnd: number) {
  act(() => {
    virtuoso.rangeChanged?.({
      startIndex: FIRST + dataStart,
      endIndex: FIRST + dataEnd,
    });
  });
}

function reportObserved(relation: "above" | "in" | "below") {
  const root = { top: 100, bottom: 500, height: 400 } as DOMRectReadOnly;
  const box =
    relation === "above"
      ? { top: 10, bottom: 40 }
      : relation === "below"
        ? { top: 540, bottom: 580 }
        : { top: 200, bottom: 240 };
  act(() => {
    ioCallback?.([
      {
        isIntersecting: relation === "in",
        rootBounds: root,
        boundingClientRect: box,
      } as IntersectionObserverEntry,
    ]);
  });
}

describe("Timeline unread jump pill", () => {
  it("구분선이 뷰포트 위쪽 밖일 때만 뜬다", () => {
    const root = mountTimeline();
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    expect(divider).not.toBeNull();
    if (divider === null) throw new Error("expected unread divider");

    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    const pill = root.querySelector("[data-testid='jump-unread']");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("새 메시지 5개 보기");
    expect(pill?.getAttribute("aria-label")).toBe("위쪽의 새 메시지 5개 보기");

    reportObserved("in");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("클릭하면 구분선으로 스크롤하고 reduced-motion이면 auto다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");

    const pill = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-unread']"
    );
    expect(pill).not.toBeNull();
    act(() => {
      pill?.click();
    });
    expect(virtuoso.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: divider,
        align: "start",
        behavior: "smooth",
      })
    );
  });

  it("reduced-motion이면 점프가 auto다", () => {
    reducedMotion = true;
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    const pill = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-unread']"
    );
    act(() => {
      pill?.click();
    });
    expect(virtuoso.scrollToIndex).toHaveBeenLastCalledWith(
      expect.objectContaining({
        index: divider,
        align: "start",
        behavior: "auto",
      })
    );
  });

  it("구분선이 창에 들어오면 소멸한다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    reportRange(divider - 1, divider + 4);
    reportObserved("in");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("채널을 갈아타면 필이 리셋된다", () => {
    const root = mountTimeline();
    const first = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(first);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    const nextMessages = [101, 102, 103, 104].map((seq) => message(seq));
    act(() => {
      mountedRoot?.render(
        createElement(Timeline, {
          messages: nextMessages,
          directory: DIRECTORY,
          status: "ready",
          lastReadSeq: 101,
          unreadCount: 3,
          actions: {
            myMemberId: ME,
            onToggleReaction: () => undefined,
            onTogglePin: () => undefined,
            onEditMessage: async () => undefined,
            onDeleteMessage: async () => undefined,
          },
        })
      );
    });
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    const nextItems = buildTimelineItems(nextMessages, {
      lastReadSeq: 101,
      unreadCount: 3,
    });
    const nextDivider = unreadDividerIndexOf(nextItems);
    if (nextDivider === null) throw new Error("expected next unread divider");
    reportRange(nextDivider + 1, nextDivider + 3);
    reportObserved("above");
    const pill = root.querySelector("[data-testid='jump-unread']");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-new-count")).toBe("3");
  });

  it("하단 필과 동시에 떠도 된다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    act(() => {
      virtuoso.atBottomStateChange?.(false);
    });
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
    expect(root.querySelector("[data-testid='jump-latest']")).not.toBeNull();
    expect(
      root.querySelector("[data-testid='jump-latest']")?.textContent
    ).toBe("최신 메시지로 이동");
  });

  it("정렬 중 in 다음 15ms 뒤 above 가 필을 무장한다 (H-5)", () => {
    const root = mountTimeline({ holdAlign: true });
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider, divider + 4);
    const scroller = { top: 85, bottom: 694, height: 609 } as DOMRectReadOnly;
    act(() => {
      ioCallback?.([
        {
          isIntersecting: true,
          rootBounds: scroller,
          boundingClientRect: { top: 144, bottom: 178 },
        } as IntersectionObserverEntry,
      ]);
    });
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
    act(() => {
      ioCallback?.([
        {
          isIntersecting: false,
          rootBounds: scroller,
          boundingClientRect: { top: -284, bottom: -250 },
        } as IntersectionObserverEntry,
      ]);
    });
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
  });

  it("구분선이 가상화로 빠져도 range가 위쪽이면 뜬다", () => {
    virtuoso.renderUnread = false;
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 3, divider + 7);
    expect(root.querySelector("[data-testid='unread-divider']")).toBeNull();
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
  });

  it("안읽음이 없으면 하단 필만 뜬다", () => {
    const root = mountTimeline({ lastReadSeq: null, unreadCount: 0 });
    act(() => {
      virtuoso.atBottomStateChange?.(false);
    });
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
    expect(root.querySelector("[data-testid='jump-latest']")).not.toBeNull();
  });

  it("라이브 꼬리는 상단 N에 섞지 않는다 — 구분선과 같은 동결 수다", () => {
    const messages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) =>
      message(seq)
    );
    const root = mountTimeline({
      messages,
      lastReadSeq: 3,
      unreadCount: 5,
    });
    const items = buildTimelineItems(messages, {
      lastReadSeq: 3,
      unreadCount: 5,
    });
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 8);
    reportObserved("above");
    const pill = root.querySelector("[data-testid='jump-unread']");
    expect(pill?.textContent).toBe("새 메시지 5개 보기");
    expect(pill?.getAttribute("aria-label")).toBe("위쪽의 새 메시지 5개 보기");
    expect(pill?.getAttribute("data-new-count")).toBe("5");
  });

  it("구분선에 들어온 뒤 바닥까지 읽고 돌아와도 필이 다시 서지 않는다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    reportObserved("in");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    act(() => {
      virtuoso.atBottomStateChange?.(true);
    });
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("Enter 실행 후 포커스가 첫 안읽음 행 정거장에 착지한다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");

    const pill = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-unread']"
    );
    expect(pill).not.toBeNull();
    pill?.focus();
    expect(document.activeElement).toBe(pill);
    act(() => {
      pill?.click();
    });
    const landed = root.querySelector("[data-testid='timeline-message'][data-seq='4']");
    expect(document.activeElement).toBe(landed);
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("observed가 없을 때 range 「in」은 래치를 무장하지 않는다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");

    // 오버스캔 거짓: 구분선 첨자를 지나는 range. IO는 아직 침묵.
    reportRange(divider - 1, divider + 4);
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    // 구분선은 창 위쪽(오버스캔에만 마운트). 래치가 무장됐으면 필은 영구 소멸한다.
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    reportRange(divider + 2, divider + 6);
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
  });

  it("채널 오픈 스윕이 구분선 첨자를 지나도 필이 선다", () => {
    const messages = Array.from({ length: 24 }, (_, i) => message(i + 1));
    const root = mountTimeline({
      messages,
      lastReadSeq: 3,
      unreadCount: 21,
    });
    const items = buildTimelineItems(messages, {
      lastReadSeq: 3,
      unreadCount: 21,
    });
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");

    // virtuoso 초기 bottom 수렴: rangeChanged가 구분선 첨자를 스친다.
    reportRange(divider - 1, divider + 4);
    reportRange(items.length - 6, items.length - 1);
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
    expect(
      root.querySelector("[data-testid='jump-unread']")?.getAttribute("data-new-count")
    ).toBe("21");
  });

  it("IO 「in」에서만 래치가 무장되고 돌아와도 다시 서지 않는다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    reportObserved("in");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("상단 필 실행은 IO 「in」 없이 래치를 무장한다", () => {
    const root = mountTimeline();
    const items = buildTimelineItems(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => message(seq)),
      { lastReadSeq: 3, unreadCount: 5 }
    );
    const divider = unreadDividerIndexOf(items);
    if (divider === null) throw new Error("expected unread divider");
    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    const pill = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-unread']"
    );
    expect(pill).not.toBeNull();
    act(() => {
      pill?.click();
    });
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();

    reportRange(divider + 2, divider + 6);
    reportObserved("above");
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
  });

  it("하단 필 실행 후 포커스가 최신 행 정거장에 착지한다", () => {
    const root = mountTimeline({ lastReadSeq: null, unreadCount: 0 });
    act(() => {
      virtuoso.atBottomStateChange?.(false);
    });
    const pill = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-latest']"
    );
    expect(pill).not.toBeNull();
    pill?.focus();
    act(() => {
      pill?.click();
    });
    const landed = root.querySelector("[data-testid='timeline-message'][data-seq='8']");
    expect(document.activeElement).toBe(landed);
  });
});
