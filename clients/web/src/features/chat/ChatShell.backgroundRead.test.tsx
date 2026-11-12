// @vitest-environment jsdom

import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Message, ReadState, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ChatShell } from "@/features/chat/ChatShell";

// 창이 뒤에 있는 동안 열어 둔 대화에 온 글은 읽음으로 올리지 않는다 (#5660 H1). 웹뷰가 뒤에서도 살아 있게 된 뒤로, 열어 둔 채널·DM 에
// 나를 부르는 글이 오면 페이지가 곧바로 `PUT read-state`를 보내 메뉴 막대 점이 켜지지 않고 다른 기기의 안 읽음까지 지워졌다.
// 읽음 위치는 사람이 그 대화를 보고 있을 때(창이 앞 + 문서가 보임, `documentForeground`)만 오르고, 앞으로 돌아온 순간 한 번 오른다.

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const PEER = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000301";

const advertiseReadState = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item)))
    );
  }),
}));

vi.mock("@/features/chat/advertiseReadState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/advertiseReadState")>();
  return {
    ...actual,
    advertiseReadState: (workspaceId: string, channelId: string, lastReadSeq: number, reason: string) =>
      advertiseReadState(workspaceId, channelId, lastReadSeq, reason) as Promise<ReadState>,
  };
});

const channel: Channel = { id: CH, workspaceId: WS, kind: "public", name: "엔진", muted: false };
const directoryState = {
  isPending: false,
  isFetching: false,
  error: null as Error | null,
  directory: makeDirectory([]),
  refetch: () => undefined,
};
const timelineState = { messages: [] as Message[], newestSeq: 10 as number | null, oldestSeq: 1 as number | null };

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({ groups: { channels: [channel], dms: [] }, isLoading: false, error: null, refetch: () => undefined }),
    useDirectory: () => directoryState,
    useInvalidateReadStates: () => () => undefined,
  };
});

vi.mock("@/features/timeline/useTimeline", async () => {
  const { idleTimelineMock } = await import("@/features/timeline/idleTimelineMock");
  return {
    useTimeline: () =>
      idleTimelineMock({
        state: { messages: timelineState.messages, oldestSeq: timelineState.oldestSeq, newestSeq: timelineState.newestSeq },
      }),
  };
});

vi.mock("@/features/chat/useTyping", () => ({ useTypingReceive: () => undefined }));
vi.mock("@/features/channels/useCreateChannel", () => ({ useOpenCreateChannel: () => () => undefined }));
vi.mock("@/features/channels/useAddChannelMember", () => ({ useOpenAddChannelMember: () => () => undefined }));
vi.mock("@/features/directory/memberProfileContext", () => ({ useOpenMemberProfile: () => () => undefined }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));
vi.mock("@/features/agents/workLogStore", () => ({ useWorkPanelTarget: () => null }));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/chat/Composer", () => ({
  Composer: () => createElement("textarea", { id: "composer-input", "data-testid": "composer-input" }),
}));
vi.mock("@/features/hostedAgents/FirstMentionOnboarding", () => ({ FirstMentionOnboarding: () => null }));
vi.mock("@/features/huddles/HuddleHeaderControl", () => ({
  HuddleHeaderState: ({ children }: { children: (huddle: null) => ReactElement }) => children(null),
  HuddleHeaderControl: () => null,
  HuddleHeaderBanner: () => null,
}));
vi.mock("@/features/timeline/PinListMenu", () => ({ PinListMenu: () => null }));
vi.mock("@/features/chat/ChannelHeaderMenu", () => ({ ChannelHeaderMenu: () => null }));
vi.mock("@/features/timeline/LongPressHint", () => ({ LongPressHint: () => null }));
vi.mock("@/features/work/WorkPanel", () => ({ WorkPanel: () => null }));
vi.mock("@/features/work/TerminalDock", () => ({ TerminalDock: () => null }));
vi.mock("@/features/timeline/ThreadPanel", () => ({ ThreadPanel: () => null }));
vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function textMessage(seq: number, author = ME): Message {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body: `메시지 ${seq}`,
    state: "sent",
    createdAtMs: seq * 1000,
  };
}

function readRow(lastReadSeq: number, latestSeq: number): ReadState {
  return {
    channelId: CH,
    lastReadSeq,
    latestSeq,
    unreadCount: latestSeq - lastReadSeq,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
  } as ReadState;
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(client: QueryClient) {
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
            createElement(Routes, null, createElement(Route, { path: "/c/:channelId", element: createElement(ChatShell) }))
          )
        )
      )
    );
  });
}

/** 브라우저의 창 앞뒤: 보임과 초점을 바꾸고 그 사건을 쏜다(`documentForeground`가 듣는 것). */
const windowState = { visible: true, focused: true };
function setWindow(next: Partial<typeof windowState>) {
  Object.assign(windowState, next);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(windowState.focused ? "focus" : "blur"));
  });
}

/** 다른 사람의 새 글이 열어 둔 대화에 들어왔다(타임라인의 최신 번호가 오른다). */
function peerArrives(client: QueryClient, seq: number) {
  timelineState.messages = [...timelineState.messages, textMessage(seq, PEER)];
  timelineState.newestSeq = seq;
  render(client);
}

const sentSeqs = () => advertiseReadState.mock.calls.map((call) => [call[2], call[3]]);

function makeClient(row: ReadState): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["read-state", WS], [row]);
  return client;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
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
  timelineState.messages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) => textMessage(seq));
  timelineState.newestSeq = 10;
  timelineState.oldestSeq = 1;
  directoryState.directory = makeDirectory([member(ME, "김도현", "dohyun"), member(PEER, "이서연", "seoyeon")]);
  windowState.visible = true;
  windowState.focused = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (windowState.visible ? "visible" : "hidden") });
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
  advertiseReadState.mockImplementation((_ws: string, _ch: string, lastReadSeq: number) =>
    Promise.resolve(readRow(lastReadSeq, lastReadSeq))
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("열어 둔 대화의 읽음 위치는 사람이 보고 있을 때만 오른다 (#5660 H1)", () => {
  it("대조: 앞에 있는 창은 연 순간 읽음을 올리고, 새 글이 오면 그 글까지 올린다", async () => {
    const client = makeClient(readRow(10, 10));
    render(client);
    await flush();
    expect(sentSeqs()).toEqual([[10, "channel_open"]]);
    peerArrives(client, 11);
    await flush();
    expect(sentSeqs()).toEqual([
      [10, "channel_open"],
      [11, "arrival_flush"],
    ]);
  });

  it("창을 치운(숨긴) 동안 열어 둔 채널에 온 글은 읽음으로 올리지 않고, 앞으로 돌아온 순간 한 번 올린다", async () => {
    const client = makeClient(readRow(10, 10));
    render(client);
    await flush();
    advertiseReadState.mockClear();

    setWindow({ visible: false, focused: false });
    peerArrives(client, 11);
    await flush();
    peerArrives(client, 12);
    await flush();
    expect(sentSeqs()).toEqual([]);

    setWindow({ visible: true, focused: true });
    await flush();
    expect(sentSeqs()).toEqual([[12, "arrival_flush"]]);
  });

  it("보이기는 하지만 초점이 다른 창에 있는 동안(뒤에 둠)도 같다", async () => {
    const client = makeClient(readRow(10, 10));
    render(client);
    await flush();
    advertiseReadState.mockClear();

    setWindow({ focused: false });
    peerArrives(client, 11);
    await flush();
    expect(sentSeqs()).toEqual([]);

    setWindow({ focused: true });
    await flush();
    expect(sentSeqs()).toEqual([[11, "arrival_flush"]]);
  });

  it("뒤에 있는 채로 열린 대화는 앞으로 올 때 연 것으로 읽음을 올린다(그 전에는 보내지 않는다)", async () => {
    windowState.visible = false;
    windowState.focused = false;
    const client = makeClient(readRow(8, 10));
    render(client);
    await flush();
    expect(sentSeqs()).toEqual([]);

    setWindow({ visible: true, focused: true });
    await flush();
    expect(sentSeqs()).toEqual([[10, "channel_open"]]);
  });
});
