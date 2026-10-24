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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { ReadState } from "@momo/core/lib/api";
import { closeDmOnDevice, reloadClosedDmsForTest } from "@/features/sidebar/sidebarDmClosure";
import { ChatShell } from "./ChatShell";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

// #4142: 닫은 DM 의 「사람이 읽을 새 메시지」 판정은 메시지 쪽을 읽는 쿼리다. 이 시험이 보는 것은 폴백이 투영의
// latestSeq 로 후보를 고르는 규칙이므로 투영 값을 그대로 돌려주는 대역을 둔다(판정 자체는 dmRevival.test.ts·Sidebar.dm.test.tsx).
vi.mock("@/features/sidebar/dmRevival", () => ({
  useDmRevival: ({ byChannel }: { byChannel: Map<string, { latestSeq: number }> }) =>
    (id: string) => byChannel.get(id.toLowerCase())?.latestSeq,
}));

// #4252: 나간 멤버 DM 의 안 읽음 판정(`useGoneUnreadVerdicts`)도 메시지 쪽을 읽는 쿼리라 QueryClient 가 필요하다. 이 시험이 보는
// 것이 아니다(판정은 goneUnreadVerdicts.test.tsx · Sidebar.dm.test.tsx).
vi.mock("@/features/sidebar/goneUnreadVerdicts", () => ({
  useGoneUnreadVerdicts: () => new Map(),
}));

// #3653: 개인 에이전트 부르기는 QueryClient가 필요하다. 이 시험이 보는 것이 아니다.
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
      itemContent: (
        index: number,
        item: { kind: string; key: string }
      ) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
    }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

// =============================================================================
// 인덱스 라우트(`/`)가 여는 대화 (#3963, design-review R1 H1).
//
// 채널이 없는 멤버는 `/` 에서 첫 DM 이 열린다. 그 DM 을 사이드바에서 X 로 닫아 두었다면 본문도 그 DM 에
// 머물면 안 된다: 사이드바와 본문이 **같은 함수**(`indexFallbackChannelId`)로 고른다. 이 시험은 본문 쪽을 잰다.
// =============================================================================

const channelsState = {
  isLoading: false,
  error: null as Error | null,
  groups: { channels: [] as Channel[], dms: [] as Channel[] },
  refetch: () => undefined,
};

const PEER_ONE = "00000000-0000-7000-8000-000000000111";
const PEER_TWO = "00000000-0000-7000-8000-000000000112";
const DM_ONE = "00000000-0000-7000-8000-0000000002a1";
const DM_TWO = "00000000-0000-7000-8000-0000000002a2";
const CHANNEL = "00000000-0000-7000-8000-0000000002c1";

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
const self = { ...member(ME, "곽성재", "seongjae"), role: "owner" } as RosterMember;
const roster = [self, member(PEER_ONE, "이도현", "dohyun"), member(PEER_TWO, "박서연", "seoyeon")];

const dm = (id: string, peer: string): Channel =>
  ({ id, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, peer] }) as Channel;
const publicChannel: Channel = { id: CHANNEL, workspaceId: WS, kind: "public", name: "general", muted: false };

const readStatesState = {
  byChannel: new Map<string, ReadState>(),
  isPending: false,
  isError: false,
  data: [] as ReadState[] | undefined,
};
function readState(channelId: string, latestSeq: number): ReadState {
  return { channelId, lastReadSeq: latestSeq, latestSeq, unreadCount: 0, mentionCount: 0, markedUnreadBeforeSeq: null };
}
function setReadStates(states: ReadState[]) {
  readStatesState.byChannel = new Map(states.map((state) => [state.channelId.toLowerCase(), state]));
  readStatesState.data = states;
}

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsState,
    useDirectory: () => ({
      directory: makeDirectory(roster),
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => undefined,
    }),
    useReadStates: () => readStatesState,
    useInvalidateReadStates: () => () => undefined,
  };
});

vi.mock("@/features/timeline/useTimeline", async () => {
  const { idleTimelineMock } = await import("@/features/timeline/idleTimelineMock");
  return { useTimeline: () => idleTimelineMock() };
});

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

const composerProps: { channelLabel: string; recipient: string }[] = [];
vi.mock("@/features/chat/Composer", () => ({
  Composer: (props: { channelLabel: string; recipient: string }) => {
    composerProps.push({ channelLabel: props.channelLabel, recipient: props.recipient });
    return createElement("textarea", {
      id: "composer-input",
      "data-testid": "composer-input",
    });
  },
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

// #2780: 헤더 도크 판정은 호스트 목록(React Query)을 읽는다. 이 파일은 도크를
// 재지 않으므로 호스트 없음(셀프호스트 기본)으로 고정한다.
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvided: () => false,
  useSurfaceProvidedWhileOpen: () => false,
  useSurfaceProvidedPredicate: () => () => false,
  useWorkHostPresence: () => "absent",
}));

vi.mock("@/features/work/TerminalDock", () => ({
  TerminalDock: () => null,
}));

vi.mock("@/features/timeline/ThreadPanel", () => ({
  ThreadPanel: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

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

async function mountAt(path: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/", element: createElement(ChatShell) }),
        createElement(Route, { path: "/c/:channelId", element: createElement(ChatShell) })
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  reloadClosedDmsForTest(null);
  composerProps.length = 0;
  channelsState.isLoading = false;
  channelsState.error = null;
  channelsState.groups = { channels: [], dms: [dm(DM_ONE, PEER_ONE), dm(DM_TWO, PEER_TWO)] };
  setReadStates([readState(DM_ONE, 7), readState(DM_TWO, 3)]);
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
  mountedHost?.remove();
  mountedHost = null;
  vi.unstubAllGlobals();
  localStorage.clear();
  reloadClosedDmsForTest(null);
});

const header = (host: HTMLElement) =>
  host.querySelector('[data-testid="channel-header"]')?.textContent ?? "";

describe("ChatShell · 인덱스 라우트가 여는 대화 (design-review R1 H1)", () => {
  it("채널이 없고 닫은 DM 이 없으면 `/` 는 첫 DM 을 연다", async () => {
    const host = await mountAt("/");
    expect(header(host)).toContain("이도현");
  });

  it("첫 DM 을 닫아 두었으면 `/` 는 닫지 않은 다음 DM 을 연다 — 닫은 DM 에 머물지 않는다", async () => {
    closeDmOnDevice(WS, DM_ONE, 7);
    const host = await mountAt("/");
    expect(header(host)).toContain("박서연");
    expect(header(host)).not.toContain("이도현");
  });

  it("닫은 DM 에 새 메시지가 오면(latestSeq 증가) `/` 는 그 DM 을 다시 연다", async () => {
    closeDmOnDevice(WS, DM_ONE, 7);
    setReadStates([readState(DM_ONE, 8), readState(DM_TWO, 3)]);
    const host = await mountAt("/");
    expect(header(host)).toContain("이도현");
  });

  it("DM 이 전부 닫혀 있으면 `/` 는 아무 대화도 열지 않는다(빈 상태)", async () => {
    closeDmOnDevice(WS, DM_ONE, 7);
    closeDmOnDevice(WS, DM_TWO, 3);
    const host = await mountAt("/");
    // 빈 상태도 일반 머리(「채널」)를 그린다: 어느 DM 이름도 서지 않고 컴포저도 없다.
    expect(header(host)).not.toContain("이도현");
    expect(header(host)).not.toContain("박서연");
    expect(host.querySelector('[data-testid="composer-input"]')).toBeNull();
  });

  it("채널이 있으면 닫은 DM 과 무관하게 첫 채널을 연다", async () => {
    channelsState.groups = { channels: [publicChannel], dms: [dm(DM_ONE, PEER_ONE)] };
    closeDmOnDevice(WS, DM_ONE, 7);
    const host = await mountAt("/");
    expect(header(host)).toContain("general");
  });

  it("주소가 닫은 DM 을 가리키면 그 DM 이 열린다 — 닫기는 진열이지 접근 차단이 아니다", async () => {
    closeDmOnDevice(WS, DM_ONE, 7);
    const host = await mountAt(`/c/${DM_ONE}`);
    expect(header(host)).toContain("이도현");
  });
});


describe("ChatShell · 인덱스 라우트와 서버가 기억하는 닫기 (ADR-0177 D8, #4228)", () => {
  /** 새 서버의 행: 읽을 seq 와 내가 닫은 seq 를 싣는다. */
  const serverState = (channelId: string, latestSeq: number, closedAt: number | null): ReadState => ({
    ...readState(channelId, latestSeq),
    latestReadableSeq: latestSeq,
    closedAtSeq: closedAt,
  });

  it("서버가 닫았다고 말한 첫 DM 을 `/` 가 도로 열지 않는다 - 사이드바와 같은 훅이 같은 판정을 낸다", async () => {
    setReadStates([serverState(DM_ONE, 7, 7), serverState(DM_TWO, 3, null)]);
    const host = await mountAt("/");
    expect(header(host)).toContain("박서연");
    expect(header(host)).not.toContain("이도현");
  });

  it("닫은 뒤 읽을 메시지가 온 DM 은 다시 후보다(8번)", async () => {
    setReadStates([serverState(DM_ONE, 8, 7), serverState(DM_TWO, 3, null)]);
    const host = await mountAt("/");
    expect(header(host)).toContain("이도현");
  });

  it("옛 서버의 원장은 서버 갈래에서 읽지 않는다: 서버가 안 닫았다고 말하면 원장 항목이 남아 있어도 후보다", async () => {
    closeDmOnDevice(WS, DM_ONE, 7);
    setReadStates([serverState(DM_ONE, 7, null), serverState(DM_TWO, 3, null)]);
    const host = await mountAt("/");
    expect(header(host)).toContain("이도현");
  });
});
