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
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type Channel,
  type Message,
  type ReadState,
  type RosterMember,
} from "@momo/core/lib/api";
import { markAt3Cursor10, MARK_AT_3_CURSOR_10 } from "@momo/core/features/readState/proof";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ChatShell } from "@/features/chat/ChatShell";
import { sidebarUnreadCounts } from "@/features/sidebar/sidebarUnread";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = markAt3Cursor10().channelId;

type RangeHandler = (range: { startIndex: number; endIndex: number }) => void;
type ScrollerHandler = (node: HTMLElement | Window | null) => void;
type IoCallback = (entries: IntersectionObserverEntry[]) => void;

const virtuoso = vi.hoisted(() => ({
  rangeChanged: null as RangeHandler | null,
  scrollerRef: null as ScrollerHandler | null,
  data: [] as { kind: string; key: string }[],
}));

const advertiseReadState = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (
        index: number,
        item: { kind: string; key: string }
      ) => ReactElement;
      rangeChanged?: RangeHandler;
      scrollerRef?: ScrollerHandler;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.rangeChanged = props.rangeChanged ?? null;
    virtuoso.scrollerRef = props.scrollerRef ?? null;
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
    }));
    const scrollerRef = props.scrollerRef;
    useEffect(() => {
      const root = document.querySelector("[data-testid='timeline-virtuoso']");
      scrollerRef?.(root instanceof HTMLElement ? root : null);
      return () => scrollerRef?.(null);
    }, [scrollerRef]);
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

vi.mock("@/features/chat/advertiseReadState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/chat/advertiseReadState")>();
  return {
    ...actual,
    advertiseReadState: (
      workspaceId: string,
      channelId: string,
      lastReadSeq: number,
      reason: string,
      extra?: { markUnreadBeforeSeq?: number }
    ) =>
      advertiseReadState(
        workspaceId,
        channelId,
        lastReadSeq,
        reason,
        extra
      ) as Promise<ReadState>,
  };
});

const engineChannel: Channel = {
  id: CH,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};

const directoryState = {
  isPending: false,
  isFetching: false,
  error: null as Error | null,
  directory: makeDirectory([]),
  refetch: () => undefined,
};

const timelineState = {
  messages: [] as Message[],
  newestSeq: 10 as number | null,
  oldestSeq: 1 as number | null,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: { channels: [engineChannel], dms: [] },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
    useDirectory: () => directoryState,
    useInvalidateReadStates: () => () => undefined,
  };
});

vi.mock("@/features/timeline/useTimeline", () => ({
  useTimeline: () => ({
    state: {
      messages: timelineState.messages,
      oldestSeq: timelineState.oldestSeq,
      newestSeq: timelineState.newestSeq,
    },
    status: "ready",
    resume: { lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 },
    recoveryMarkers: [],
    pending: [],
    send: async () => undefined,
    resend: async () => undefined,
    loadOlder: () => undefined,
    reload: () => undefined,
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
    toggleReaction: async () => undefined,
    pins: {},
    pinsStatus: "ready",
    reloadPins: () => undefined,
    togglePin: async () => undefined,
    editMessage: async () => undefined,
    deleteMessage: async () => undefined,
    unfurls: {},
    removeUnfurls: async () => undefined,
  }),
}));

vi.mock("@/features/chat/useTyping", () => ({
  useTypingReceive: () => undefined,
}));

vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => () => undefined,
}));

vi.mock("@/features/channels/useAddChannelMember", () => ({
  useOpenAddChannelMember: () => () => undefined,
}));

vi.mock("@/features/directory/memberProfileContext", () => ({
  useOpenMemberProfile: () => () => undefined,
}));

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

vi.mock("@/features/agents/workLogStore", () => ({
  useWorkPanelTarget: () => null,
}));

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

vi.mock("@/features/chat/Composer", () => ({
  Composer: () =>
    createElement("textarea", {
      id: "composer-input",
      "data-testid": "composer-input",
    }),
}));

vi.mock("@/features/hostedAgents/FirstMentionOnboarding", () => ({
  FirstMentionOnboarding: () => null,
}));

vi.mock("@/features/huddles/HuddleHeaderControl", () => ({
  HuddleHeaderState: ({
    children,
  }: {
    children: (huddle: null) => ReactElement;
  }) => children(null),
  HuddleHeaderControl: () => null,
  HuddleHeaderBanner: () => null,
}));

vi.mock("@/features/timeline/PinListMenu", () => ({
  PinListMenu: () => null,
}));

vi.mock("@/features/chat/ChannelHeaderMenu", () => ({
  ChannelHeaderMenu: () => null,
}));

vi.mock("@/features/timeline/LongPressHint", () => ({
  LongPressHint: () => null,
}));

vi.mock("@/features/work/WorkPanel", () => ({
  WorkPanel: () => null,
}));

vi.mock("@/features/work/TerminalDock", () => ({
  TerminalDock: () => null,
}));

vi.mock("@/features/timeline/ThreadPanel", () => ({
  ThreadPanel: () => null,
}));

vi.mock("@/features/reminders/RemindDialog", () => ({
  RemindDialog: () => null,
}));

vi.mock("@/features/emoji/EmojiPickerDialog", () => ({
  EmojiPickerDialog: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ioCallback: IoCallback | null = null;

function member(): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function textMessage(seq: number): Message {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: seq * 1000,
  };
}

function unmarked(): ReadState {
  return {
    ...markAt3Cursor10(),
    markedUnreadBeforeSeq: null,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function leaveBadge(client: QueryClient): number {
  const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
  const row = cached?.find((item) => item.channelId === CH);
  return sidebarUnreadCounts(CH, null, row).unreadCount;
}

function fireDividerAbove() {
  if (ioCallback === null) {
    throw new Error("구분선 IntersectionObserver 가 없다");
  }
  act(() => {
    ioCallback?.([
      {
        isIntersecting: false,
        rootBounds: { top: 100, bottom: 500, height: 400 },
        boundingClientRect: { top: 10, bottom: 40 },
      } as IntersectionObserverEntry,
    ]);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickMarkSeq(seq: number) {
  const row = host?.querySelector<HTMLElement>(
    `[data-testid="timeline-message"][data-seq="${seq}"]`
  );
  if (row === null || row === undefined) {
    throw new Error(`seq ${seq} 행이 없다`);
  }
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 40,
      })
    );
    await Promise.resolve();
  });
  const item = document.querySelector<HTMLElement>(
    '[data-testid="context-mark-unread"]'
  );
  if (item === null) {
    throw new Error("여기부터 안 읽음 항목이 없다");
  }
  await act(async () => {
    item.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeClient(row: ReadState): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["read-state", WS], [row]);
  return client;
}

function mountShell(client: QueryClient): HTMLElement {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
  }
  act(() => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(
            MemoryRouter,
            { initialEntries: [`/c/${CH}`] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: "/c/:channelId",
                element: createElement(ChatShell),
              })
            )
          )
        )
      )
    );
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
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
  virtuoso.rangeChanged = null;
  virtuoso.scrollerRef = null;
  virtuoso.data = [];
  ioCallback = null;
  timelineState.messages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(textMessage);
  timelineState.newestSeq = 10;
  timelineState.oldestSeq = 1;
  directoryState.directory = makeDirectory([member()]);
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
    matches: false,
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
  advertiseReadState.mockReset();
  vi.unstubAllGlobals();
});

describe("400 롤백은 방문 경계를 되돌린다 (H-6)", () => {
  it("마크 뒤 400 이면 구분선·필이 사라지고 사이드바 배지도 0 이다", async () => {
    const client = makeClient(unmarked());
    let rejectMark: ((error: unknown) => void) | undefined;
    advertiseReadState.mockImplementation(
      (
        _ws: string,
        _ch: string,
        lastReadSeq: number,
        reason: string
      ) => {
        if (reason === "mark_unread") {
          return new Promise<ReadState>((_resolve, reject) => {
            rejectMark = reject;
          });
        }
        return Promise.resolve({
          ...unmarked(),
          lastReadSeq,
        });
      }
    );

    const root = mountShell(client);
    await flush();
    expect(root.querySelector("[data-testid='unread-divider']")).toBeNull();

    await clickMarkSeq(3);
    await flush();
    const divider = root.querySelector("[data-testid='unread-divider']");
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain(`새 메시지 ${MARK_AT_3_CURSOR_10.count}`);
    fireDividerAbove();
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();

    await act(async () => {
      rejectMark?.(
        new ApiError(400, "mark_unread_before_seq must name an existing seq")
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const delays = [0, 500, 1500, 3000];
    let waited = 0;
    for (const at of delays) {
      const step = at - waited;
      if (step > 0) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, step));
        });
      }
      waited = at;
      expect(
        root.querySelector("[data-testid='unread-divider']"),
        `divider still up at +${at}ms`
      ).toBeNull();
      expect(
        root.querySelector("[data-testid='jump-unread']"),
        `pill still up at +${at}ms`
      ).toBeNull();
      expect(leaveBadge(client), `leave badge at +${at}ms`).toBe(0);
    }

    const close = document.querySelector(
      '[data-testid="message-action-error"] button'
    );
    expect(close?.textContent).toContain("닫기");
    await act(async () => {
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(root.querySelector("[data-testid='unread-divider']")).toBeNull();
    expect(root.querySelector("[data-testid='jump-unread']")).toBeNull();
    expect(leaveBadge(client)).toBe(0);
  });

  it("성공한 마크는 방문 경계를 유지한다", async () => {
    const client = makeClient(unmarked());
    const marked = markAt3Cursor10();
    advertiseReadState.mockImplementation(
      (
        _ws: string,
        _ch: string,
        lastReadSeq: number,
        reason: string
      ) => {
        if (reason === "mark_unread") {
          return Promise.resolve(marked);
        }
        return Promise.resolve({
          ...unmarked(),
          lastReadSeq,
        });
      }
    );

    const root = mountShell(client);
    await flush();
    await clickMarkSeq(3);
    await flush();

    const divider = root.querySelector("[data-testid='unread-divider']");
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain(`새 메시지 ${MARK_AT_3_CURSOR_10.count}`);
    fireDividerAbove();
    expect(root.querySelector("[data-testid='jump-unread']")).not.toBeNull();
    expect(leaveBadge(client)).toBe(MARK_AT_3_CURSOR_10.count);
  });
});
