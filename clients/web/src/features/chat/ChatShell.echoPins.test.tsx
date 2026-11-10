// @vitest-environment jsdom
// #5624 검수 1회차 L3: 웹 화면 배선(`ChatShell` → `Timeline` → `buildTimelineItems`)을 지킨다. 훅 시험(`useTimeline.echoSkew`)은 훅이
// 내놓는 장부·시계 차이로 코어를 **직접** 부르므로, `ChatShell`이 그것을 `Timeline`에 넘기지 않아도 통과했다(검수 사보타주 D, 훅 시험
// GREEN). 여기서는 진짜 `ChatShell`과 진짜 `Timeline`을 그리고, 목록(가상 목록 대역)이 받은 줄의 머리/이어짐을 읽는다.
//
// 장면: 내 글 둘(서버 10:47:30 · 10:48:00.1)과 날아가는 에코 하나(기기 10:46:50). 장부는 둘째 확정본이 에코 때 10:47:59.8이었다고
// 말하고, 서버 시계는 기기보다 90초 앞선다. 배선이 살아 있으면 둘째 글과 에코가 모두 이어진 줄이고, 장부·차이가 빠지면 둘 다 머리다.

import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Message, RosterMember } from "@momo/core/lib/api";
import type { EchoPins, PendingMessage } from "@momo/core/features/timeline/model";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ChatShell } from "./ChatShell";

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";

const virtuoso = vi.hoisted(() => ({
  data: [] as { kind: string; key: string }[],
}));

/** 이 시험이 훅 대신 내놓는 값(메시지·에코·장부·시계 차이). */
const timelineOver = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

// 아래 대역들은 `ChatShell.intro.test.tsx`와 같다 — 이 시험이 보는 것이 아니다.
vi.mock("@/features/sidebar/dmRevival", () => ({
  useDmRevival: () => () => undefined,
}));
vi.mock("@/features/sidebar/goneUnreadVerdicts", () => ({
  useGoneUnreadVerdicts: () => new Map(),
}));
vi.mock("@/features/chat/usePersonalCall", () => ({
  usePersonalCall: () => ({
    planFor: () => null,
    notice: null,
    retry: () => undefined,
    dismiss: () => undefined,
    clear: () => undefined,
  }),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (index: number, item: { kind: string; key: string }) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
    useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) => createElement("div", { key: item.key }, props.itemContent(index, item)))
    );
  }),
}));

const engineChannel: Channel = {
  id: CHANNEL,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};

const self: RosterMember = {
  id: ME,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "member",
  channelCount: 1,
  channelIds: [CHANNEL],
  capabilities: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: { channels: [engineChannel], dms: [] },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
    useDirectory: () => ({
      isPending: false,
      isFetching: false,
      error: null,
      directory: makeDirectory([self]),
      refetch: () => undefined,
    }),
    useReadStates: () => ({ byChannel: new Map(), isPending: false, error: null }),
    useInvalidateReadStates: () => () => undefined,
  };
});
vi.mock("@/features/timeline/useTimeline", async () => {
  const { idleTimelineMock } = await import("@/features/timeline/idleTimelineMock");
  return { useTimeline: () => ({ ...idleTimelineMock(), ...timelineOver.value }) };
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
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvided: () => false,
  useSurfaceProvidedWhileOpen: () => false,
  useSurfaceProvidedPredicate: () => () => false,
  useWorkHostPresence: () => "absent",
}));
vi.mock("@/features/work/TerminalDock", () => ({ TerminalDock: () => null }));
vi.mock("@/features/timeline/ThreadPanel", () => ({ ThreadPanel: () => null }));

const at = (m: number, s: number, ms = 0) => new Date(2026, 10, 9, 10, m, s, ms).getTime();

function mine(seq: number, body: string, createdAtMs: number): Message {
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body,
    state: "sent",
    createdAtMs,
  } as Message;
}

const FIRST = mine(1, "47분의 글", at(47, 30));
const BOUNDARY = mine(2, "경계의 글", at(48, 0, 100));
const ECHO: PendingMessage = {
  clientMsgId: "client-echo",
  channelId: CHANNEL,
  authorMemberId: ME,
  body: "날아가는 글",
  createdAtMs: at(46, 50),
  sinceSeq: 2,
  status: "sending",
};

/** 훅이 내놓는 값: 메시지 둘·에코 하나, 그리고 장부와 시계 차이(주지 않으면 비운 값). */
function hookGives(echoPins: EchoPins, serverOffsetMs: number): void {
  timelineOver.value = {
    state: { messages: [FIRST, BOUNDARY], oldestSeq: 1, newestSeq: 2 },
    pending: [ECHO],
    echoPins,
    serverOffsetMs,
  };
}

/** 목록이 받은 줄들의 머리/이어짐(본문 → 머리인가). */
function listedHeads(): Record<string, boolean> {
  const heads: Record<string, boolean> = {};
  for (const raw of virtuoso.data) {
    const item = raw as unknown as {
      kind: string;
      startsGroup?: boolean;
      message?: Message;
      pending?: PendingMessage;
    };
    if (item.kind === "message" && item.message) heads[item.message.body ?? ""] = item.startsGroup === true;
    if (item.kind === "pending" && item.pending) heads[item.pending.body] = item.startsGroup === true;
  }
  return heads;
}

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mountShell(): void {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  // 메시지 행이 서면 행 부품이 쿼리 하나를 읽는다(이 시험이 보는 것이 아니다). 재시도 없이 조용히 비게 둔다.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
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
            { initialEntries: [`/c/${CHANNEL}`] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/c/:channelId", element: createElement(ChatShell) })
            )
          )
        )
      )
    );
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});

beforeEach(() => {
  virtuoso.data = [];
  timelineOver.value = {};
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

describe("#5624 L3 — ChatShell은 훅의 장부와 시계 차이를 목록까지 넘긴다", () => {
  it("장부가 이어진 줄이라 말한 확정본과, 차이를 더하면 같은 분인 에코가 모두 이어진 줄로 그려진다", () => {
    hookGives(new Map([[BOUNDARY.id, { atMs: at(47, 59, 800), clientMsgId: "client-boundary" }]]), 90_000);
    mountShell();
    expect(listedHeads()).toEqual({ "47분의 글": true, "경계의 글": false, "날아가는 글": false });
  });

  it("대조: 장부가 비고 차이가 0이면 같은 메시지가 서버·기기 시각으로 묶여 둘 다 머리다(장면이 배선을 가른다)", () => {
    hookGives(new Map(), 0);
    mountShell();
    expect(listedHeads()).toEqual({ "47분의 글": true, "경계의 글": true, "날아가는 글": true });
  });
});
