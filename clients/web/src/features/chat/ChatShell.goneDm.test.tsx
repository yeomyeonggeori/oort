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
  displayName: "곽성재",
  handle: "seongjae",
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
      isPending: false,
      error: null,
    }),
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

// #3675 / #3676: 은퇴·정지된 에이전트와의 DM은 명부(활성 멤버만)에서 상대가 빠진다.
describe("ChatShell · 명부에서 빠진 상대와의 DM", () => {
  it("머리와 컴포저가 「다이렉트 메시지」가 아니라 「나간 멤버」를 쓴다", async () => {
    const host = await mount();
    const header = host.querySelector('[data-testid="channel-header"]');
    expect(header?.textContent).toContain("나간 멤버");
    expect(header?.textContent).not.toContain("다이렉트 메시지");
    const last = composerProps[composerProps.length - 1];
    expect(last.channelLabel).toBe("나간 멤버");
    expect(last.channelLabel).not.toContain("다이렉트 메시지");
    expect(last.recipient).toBe("person");
  });
});

// #4252: 사이드바가 「나간 멤버와의 대화」로 접은 DM 은 `/` 가 열어 주는 대화의 후보도 아니다. 사이드바와 본문이
// 같은 집합을 읽지 않으면, 접힌 대화를 본문이 도로 열어 「열려 있음」으로 되살아난다.
describe("ChatShell · 인덱스 라우트와 접힌 나간 멤버 DM (#4252)", () => {
  const PEER = "00000000-0000-7000-8000-0000000001aa";
  const LIVE_DM = "00000000-0000-7000-8000-0000000002bb";
  const peer: RosterMember = {
    ...self,
    id: PEER,
    displayName: "이도현",
    handle: "dohyun",
    role: "member",
  };
  const ghostDm = (): Channel =>
    ({ id: DM_ID, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, GONE] }) as Channel;
  const liveDm = (): Channel =>
    ({ id: LIVE_DM, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, PEER] }) as Channel;

  it("채널이 없고 첫 DM 이 접힌 나간 멤버면, 인덱스 라우트는 다음 DM 을 연다", async () => {
    rosterMembers = [self, peer];
    channelsState.groups = { channels: [], dms: [ghostDm(), liveDm()] };
    const host = await mount("/");
    const header = host.querySelector('[data-testid="channel-header"]');
    expect(header?.textContent).toContain("이도현");
    expect(header?.textContent).not.toContain("나간 멤버");
  });

  it("남은 DM 이 전부 접혔으면 인덱스 라우트는 아무 대화도 열지 않는다", async () => {
    channelsState.groups = { channels: [], dms: [ghostDm()] };
    const host = await mount("/");
    // 열린 대화가 없다: 접힌 DM 의 이름이 머리에 서지 않고, 컴포저도 서지 않는다.
    expect(host.querySelector('[data-testid="channel-header"]')?.textContent).not.toContain("나간 멤버");
    expect(composerProps).toEqual([]);
  });

  it("주소가 정한 대화는 접힌 나간 멤버 DM 이어도 연다 (⌘K·링크로 열린다)", async () => {
    channelsState.groups = { channels: [], dms: [ghostDm()] };
    const host = await mount(`/c/${DM_ID}`);
    expect(host.querySelector('[data-testid="channel-header"]')?.textContent).toContain("나간 멤버");
  });

  // 안 읽음이 있는 나간 멤버 DM 은 그 안 읽음이 사람이 읽을 것인지의 판정(`useGoneUnreadVerdicts`, 사이드바가 같은 훅을 읽는다)이
  // 접힘을 정한다. 본문이 다른 답을 읽으면 사이드바는 접었는데 본문이 도로 연다.
  const unreadGone = () => {
    readProjection.byChannel = new Map([
      [
        DM_ID,
        { channelId: DM_ID, lastReadSeq: 5, latestSeq: 8, unreadCount: 3, mentionCount: 0, markedUnreadBeforeSeq: null },
      ],
    ]);
  };

  it("안 읽음이 기계 메시지뿐이라는 판정이면 그 나간 멤버 DM 은 접혀서 인덱스 라우트 후보가 아니다", async () => {
    rosterMembers = [self, peer];
    unreadGone();
    goneVerdicts.byId.set(DM_ID, "ambient");
    channelsState.groups = { channels: [], dms: [ghostDm(), liveDm()] };
    const host = await mount("/");
    const header = host.querySelector('[data-testid="channel-header"]');
    expect(header?.textContent).toContain("이도현");
    expect(header?.textContent).not.toContain("나간 멤버");
  });

  it("사람이 읽을 안 읽음이 있다는 판정이면 접히지 않아 인덱스 라우트가 첫 DM 으로 연다", async () => {
    rosterMembers = [self, peer];
    unreadGone();
    goneVerdicts.byId.set(DM_ID, "human");
    channelsState.groups = { channels: [], dms: [ghostDm(), liveDm()] };
    const host = await mount("/");
    expect(host.querySelector('[data-testid="channel-header"]')?.textContent).toContain("나간 멤버");
  });

  it("판정이 오는 중이면 접힌 채라 인덱스 라우트가 열지 않는다 (사이드바와 같은 답)", async () => {
    rosterMembers = [self, peer];
    unreadGone();
    goneVerdicts.byId.set(DM_ID, "pending");
    channelsState.groups = { channels: [], dms: [ghostDm(), liveDm()] };
    const host = await mount("/");
    expect(host.querySelector('[data-testid="channel-header"]')?.textContent).toContain("이도현");
  });
});

// #4252 M2: 「명부를 믿을 수 있나」는 한 함수(`rosterLoaded`)가 답한다. 조회가 실패하면 비어 있는 명부 앞에서 모든 DM 이 「나간 멤버」로
// 읽히는 거짓이 사이드바 행과 이 머리·컴포저에 똑같이 있었다.
describe("ChatShell · 명부를 못 받았을 때의 이름 (#4252)", () => {
  it("명부 조회가 실패하면 머리와 컴포저는 「나간 멤버」가 아니라 「불러오는 중」이다", async () => {
    rosterFailure.failed = true;
    const host = await mount();
    const header = host.querySelector('[data-testid="channel-header"]');
    expect(header?.textContent).toContain("불러오는 중");
    expect(header?.textContent).not.toContain("나간 멤버");
    const last = composerProps[composerProps.length - 1];
    expect(last.channelLabel).toBe("불러오는 중");
    expect(last.recipient).toBe("place");
  });
});

// #4692: 사람과의 DM 머리는 상대가 지금 접속해 있는지(또는 스스로 정한 자리 비움·방해 금지)를 점과 낱말로 말한다.
// 모르면(서버가 접속 여부를 말하지 않았다) 아무것도 서지 않는다.
describe("ChatShell · DM 머리의 상대 상태 (#4692)", () => {
  const PEER = "00000000-0000-7000-8000-0000000001b1";
  const peer = (patch: Partial<RosterMember>): RosterMember => ({
    ...self,
    id: PEER,
    displayName: "이도현",
    handle: "dohyun",
    role: "member",
    ...patch,
  });
  const liveDm = () => {
    channelsState.groups = {
      channels: [],
      dms: [
        { id: DM_ID, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, PEER] } as Channel,
      ],
    };
  };
  const chip = (host: HTMLElement) =>
    host.querySelector<HTMLElement>(
      '[data-testid="channel-header"] [data-testid="human-presence"]'
    );

  it.each([
    [{ online: true }, "온라인", "ok"],
    [{ online: false }, "오프라인", "muted"],
    [{ online: true, presenceStatus: "dnd" as const }, "방해 금지", "danger"],
  ] as const)("%j → 머리에 「%s」", async (patch, word, tone) => {
    rosterMembers = [self, peer(patch)];
    liveDm();
    const host = await mount();
    expect(chip(host)?.textContent).toBe(word);
    expect(chip(host)?.getAttribute("data-tone")).toBe(tone);
  });

  it("접속 여부를 모르면 머리에 아무것도 서지 않는다 — 모름은 오프라인이 아니다", async () => {
    rosterMembers = [self, peer({})];
    liveDm();
    const host = await mount();
    expect(host.querySelector('[data-testid="channel-header"]')?.textContent).toContain("이도현");
    expect(chip(host)).toBeNull();
  });
});
