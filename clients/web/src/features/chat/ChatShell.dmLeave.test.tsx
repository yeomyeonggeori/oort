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
import { ChatShell } from "./ChatShell";
import { endDmLeaveRequest, openTimelineFor, resetDmLeaveStoreForTest, useDmLeaveStore } from "@/features/sidebar/dmLeaveStore";
import { resetDmLeaveFoldForTest } from "@momo/core/features/channels/dmLeave";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

// #3653: 개인 에이전트 부르기는 QueryClient가 필요하다. 이 시험이 보는 것이 아니다.
// #4142: 닫은 DM 의 되살림 판정은 메시지 쪽을 읽는 쿼리라 QueryClient 가 필요하다. 이 시험이 보는 것이 아니다
// (판정은 dmRevival.test.ts · Sidebar.dm.test.tsx).
vi.mock("@/features/sidebar/dmRevival", () => ({
  useDmRevival: () => () => undefined,
}));

// #4252: 나간 멤버 DM 의 안 읽음 판정(`useGoneUnreadVerdicts`)은 메시지 쪽을 읽는 쿼리라 QueryClient 가 필요하다. 판정 자체는
// goneUnreadVerdicts.test.tsx · Sidebar.dm.test.tsx 가 잰다. 여기서는 인덱스 라우트가 그 판정으로 접힌 집합을 따르는지만 보므로
// 시험이 판정을 직접 정하는 대역을 둔다(소문자 id -> 판정).
const goneVerdicts = vi.hoisted(() => ({ byId: new Map<string, string>() }));
/** 읽음 투영의 대역(소문자 id -> 행). 기본은 비어 있다(안 읽음 없음). */
const readProjection = vi.hoisted(() => ({ byChannel: new Map<string, unknown>() }));
vi.mock("@/features/sidebar/goneUnreadVerdicts", () => ({
  useGoneUnreadVerdicts: () => goneVerdicts.byId,
}));

// 에이전트 DM 머리의 상태 줄은 QueryClient 가 필요하다. 이 시험이 보는 것이 아니다.
vi.mock("@/features/agents/AgentLivenessLabel", () => ({ AgentLivenessLabel: () => null }));

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

const channelsState = {
  isLoading: false,
  error: null as Error | null,
  groups: { channels: [] as Channel[], dms: [] as Channel[] },
  refetch: () => undefined,
};

const GONE = "00000000-0000-7000-8000-0000000001ff";
const DM_ID = "00000000-0000-7000-8000-0000000002aa";
const self: RosterMember = {
  id: ME,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "한지후",
  handle: "jihu",
  role: "owner",
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};

let rosterMembers: RosterMember[] = [];
/** 명부 조회가 한 번도 못 받은 채 실패했다(`isError`, 데이터 없음). 이때 명부는 비어 있다(#4252 M2). */
const rosterFailure = { failed: false };
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsState,
    useDirectory: () => ({
      directory: makeDirectory(rosterFailure.failed ? [] : rosterMembers),
      isPending: false,
      isFetching: false,
      isError: rosterFailure.failed,
      data: undefined,
      error: null,
      refetch: () => undefined,
    }),
    useReadStates: () => ({
      byChannel: readProjection.byChannel,
      data: [...readProjection.byChannel.values()],
      isPending: false,
      error: null,
    }),
    useInvalidateReadStates: () => () => undefined,
  };
});

// 이력 훅의 대역: ChatShell 이 넘기는 선택 인자(`historyFloorOf`)를 잡고, 열린 이력이 아는 가장 큰 seq 를 시험이 정한다.
const timelineSpy = vi.hoisted(() => ({
  options: [] as Array<{ historyFloorOf?: (channelId: string) => number | null } | undefined>,
  newestSeq: null as number | null,
}));
vi.mock("@/features/timeline/useTimeline", async () => {
  const { idleTimelineMock } = await import("@/features/timeline/idleTimelineMock");
  const { emptyTimeline } = await import("@momo/core/features/timeline/model");
  return {
    useTimeline: (_rt: unknown, _ws: string, _ch: string | null, _me: string, options?: { historyFloorOf?: (channelId: string) => number | null }) => {
      timelineSpy.options.push(options);
      return idleTimelineMock({ state: { ...emptyTimeline(), newestSeq: timelineSpy.newestSeq } });
    },
  };
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

// 머리 ⋮ 의 대역: 무엇을 받았는지(내밀기 손 `onLeaveDm`)만 잡는다. 메뉴 자체의 동작은 ChannelHeaderMenu.handoff.test.tsx 가 잰다.
const headerMenu = vi.hoisted(() => ({
  props: [] as Array<{ channel: { id: string }; onLeaveDm?: (opener: HTMLElement | null) => void }>,
}));
vi.mock("@/features/chat/ChannelHeaderMenu", () => ({
  ChannelHeaderMenu: (props: { channel: { id: string }; onLeaveDm?: (opener: HTMLElement | null) => void }) => {
    headerMenu.props.push(props);
    return null;
  },
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
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "한지후",
        handle: "jihu",
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

async function mount(path = `/c/${DM_ID}`): Promise<HTMLElement> {
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
        createElement(Route, {
          path: "/c/:channelId",
          element: createElement(ChatShell),
        }),
        // 인덱스 라우트(#4252): 채널이 없을 때 어떤 대화를 열어 주는가.
        createElement(Route, { path: "/", element: createElement(ChatShell) })
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
  goneVerdicts.byId.clear();
  readProjection.byChannel = new Map();
  rosterFailure.failed = false;
  rosterMembers = [self];
  composerProps.length = 0;
  channelsState.isLoading = false;
  channelsState.error = null;
  channelsState.groups = {
    channels: [],
    dms: [
      {
        id: DM_ID,
        workspaceId: WS,
        kind: "dm",
        muted: false,
        memberIds: [ME, GONE],
      } as Channel,
    ],
  };
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
});


// =============================================================================
// #5825 수리 1회차(검수 r1 M6 V1·V2·V11): 1:1 머리 ⋮ 의 「대화 나가기」 내밀기와 넘김, 열린 이력이 아는 seq, 하한 손.
// 실제 ChatShell 을 세우고 머리 메뉴·이력 훅만 대역으로 둔다 - 판정(`dmLeaveOffered`)과 넘김(`requestDmLeave`)은 실제 코드가 한다.
// =============================================================================

const PEER = "00000000-0000-7000-8000-000000000111";
const AGENT = "00000000-0000-7000-8000-000000000112";
const DM_HUMAN = "00000000-0000-7000-8000-0000000002b1";
const DM_AGENT = "00000000-0000-7000-8000-0000000002b2";
const OTHER = "00000000-0000-7000-8000-0000000002b3";

function member(id: string, displayName: string, handle: string, kind: "human" | "agent" = "human"): RosterMember {
  return { ...self, id, displayName, handle, kind, role: "member" };
}
function dm(id: string, other: string): Channel {
  return { id, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, other] } as Channel;
}
/** 새 서버의 읽음 투영 행(`historyFromSeq` 칸이 있다). */
function projectionRow(channelId: string, historyFromSeq: number | null, withKey = true) {
  const row: Record<string, unknown> = {
    channelId, lastReadSeq: 3, latestSeq: 3, unreadCount: 0, mentionCount: 0,
    markedUnreadBeforeSeq: null, latestReadableSeq: 3, closedAtSeq: null,
  };
  if (withKey) row.historyFromSeq = historyFromSeq;
  return row;
}
function setProjection(rows: Array<ReturnType<typeof projectionRow>>) {
  readProjection.byChannel = new Map(rows.map((row) => [String(row.channelId).toLowerCase(), row]));
}

/** 마지막 렌더의 머리 메뉴가 받은 `onLeaveDm`. */
const lastLeaveHand = () => headerMenu.props.at(-1)?.onLeaveDm;

describe("ChatShell · 1:1 머리 ⋮ 의 「대화 나가기」 (#5825)", () => {
  let observed: ReturnType<typeof useDmLeaveStore> | null = null;
  beforeEach(() => {
    headerMenu.props.length = 0;
    timelineSpy.options.length = 0;
    timelineSpy.newestSeq = null;
    resetDmLeaveStoreForTest();
    resetDmLeaveFoldForTest();
    rosterMembers = [self, member(PEER, "이서연", "seoyeon"), member(AGENT, "정리봇", "tidy", "agent")];
    channelsState.groups = { channels: [], dms: [dm(DM_HUMAN, PEER), dm(DM_AGENT, AGENT)] };
    observed = null;
  });
  afterEach(() => {
    endDmLeaveRequest();
    resetDmLeaveStoreForTest();
    resetDmLeaveFoldForTest();
  });

  it("새 서버의 사람끼리 1:1 머리에는 내미는 손이 있고, 고르면 머리에서 온 요청이 이름·열린 이력 없이 저장소에 적힌다 (V2)", async () => {
    setProjection([projectionRow(DM_HUMAN, null)]);
    await mount(`/c/${DM_HUMAN}`);
    const hand = lastLeaveHand();
    expect(hand).toBeTypeOf("function");
    const opener = document.createElement("button");
    function Probe() {
      observed = useDmLeaveStore();
      return null;
    }
    const probeHost = document.createElement("div");
    const probeRoot = createRoot(probeHost);
    await act(async () => probeRoot.render(createElement(Probe)));
    await act(async () => hand!(opener));
    expect(observed!.request).toMatchObject({
      workspaceId: WS,
      channelId: DM_HUMAN,
      name: "이서연",
      via: "header",
      opener,
      observedSeq: null,
      rootIds: [],
    });
    await act(async () => probeRoot.unmount());
  });

  it("에이전트와의 1:1 · 옛 서버(투영에 하한 칸 없음) · 투영이 아직 없을 때는 내미는 손이 없다 (V1)", async () => {
    setProjection([projectionRow(DM_AGENT, null)]);
    await mount(`/c/${DM_AGENT}`);
    expect(headerMenu.props.length).toBeGreaterThan(0);
    expect(lastLeaveHand()).toBeUndefined();

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    headerMenu.props.length = 0;
    setProjection([projectionRow(DM_HUMAN, null, false)]);
    await mount(`/c/${DM_HUMAN}`);
    expect(headerMenu.props.length).toBeGreaterThan(0);
    expect(lastLeaveHand()).toBeUndefined();

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    headerMenu.props.length = 0;
    setProjection([]);
    await mount(`/c/${DM_HUMAN}`);
    expect(lastLeaveHand()).toBeUndefined();
  });

  it("이 워크스페이스의 나가기가 접히면(405·501) 머리에서도 손이 걷힌다", async () => {
    setProjection([projectionRow(DM_HUMAN, null)]);
    await mount(`/c/${DM_HUMAN}`);
    expect(lastLeaveHand()).toBeTypeOf("function");
    const { foldDmLeaveAbsent } = await import("@momo/core/features/channels/dmLeave");
    const { noteDmLeaveFolded } = await import("@/features/sidebar/dmLeaveStore");
    foldDmLeaveAbsent(WS);
    await act(async () => noteDmLeaveFolded());
    expect(lastLeaveHand()).toBeUndefined();
  });

  it("열려 있는 이력이 아는 가장 큰 seq 를 「대화 나가기」가 읽는 자리에 적는다 (V11)", async () => {
    setProjection([projectionRow(DM_HUMAN, null)]);
    timelineSpy.newestSeq = 25;
    await mount(`/c/${DM_HUMAN}`);
    expect(openTimelineFor(WS, DM_HUMAN)?.newestSeq).toBe(25);
    expect(openTimelineFor(WS, OTHER)).toBeNull();
  });

  it("이력 훅에 하한 손을 넘기고, 그 손은 읽음 투영의 하한을 대화마다 읽는다", async () => {
    setProjection([projectionRow(DM_HUMAN, 11), projectionRow(DM_AGENT, null)]);
    await mount(`/c/${DM_HUMAN}`);
    const floorOf = timelineSpy.options.at(-1)?.historyFloorOf;
    expect(floorOf).toBeTypeOf("function");
    expect(floorOf!(DM_HUMAN)).toBe(11);
    expect(floorOf!(DM_HUMAN.toUpperCase())).toBe(11);
    expect(floorOf!(DM_AGENT)).toBeNull();
    expect(floorOf!(OTHER)).toBeNull();
  });
});
