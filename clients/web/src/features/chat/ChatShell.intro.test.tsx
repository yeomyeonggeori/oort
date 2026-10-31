// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { EMPTY_ADD_MEMBER_ACTION_LABEL } from "@momo/core/features/timeline/model";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { canAddChannelMemberNow, ChatShell } from "./ChatShell";

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";

const virtuoso = vi.hoisted(() => ({
  data: [] as { kind: string; key: string }[],
}));

// 기본은 공개 채널 「엔진」이다. 셋 이상 DM 시험(#4912)만 이 칸에 DM 하나를 넣는다.
const dmState = vi.hoisted(() => ({ channel: null as Channel | null }));

// #3653: 개인 에이전트 부르기는 QueryClient가 필요하다. 이 시험이 보는 것이 아니다.
// #4142: 닫은 DM 의 되살림 판정은 메시지 쪽을 읽는 쿼리라 QueryClient 가 필요하다. 이 시험이 보는 것이 아니다
// (판정은 dmRevival.test.ts · Sidebar.dm.test.tsx).
vi.mock("@/features/sidebar/dmRevival", () => ({
  useDmRevival: () => () => undefined,
}));

// #4252: 나간 멤버 DM 의 안 읽음 판정(`useGoneUnreadVerdicts`)도 메시지 쪽을 읽는 쿼리라 QueryClient 가 필요하다. 이 시험이 보는
// 것이 아니다(판정은 goneUnreadVerdicts.test.tsx · Sidebar.dm.test.tsx).
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
      itemContent: (
        index: number,
        item: { kind: string; key: string }
      ) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    virtuoso.data = props.data;
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

const directoryState = {
  isPending: true,
  isFetching: true,
  error: null as Error | null,
  directory: makeDirectory([]),
  refetch: () => undefined,
};

const engineChannel: Channel = {
  id: CHANNEL,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: dmState.channel
        ? { channels: [], dms: [dmState.channel] }
        : { channels: [engineChannel], dms: [] },
      isLoading: false,
      error: null,
      refetch: () => undefined,
    }),
    useDirectory: () => directoryState,
    useReadStates: () => ({
      byChannel: new Map(),
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

const SHELL_SRC = readFileSync(
  resolve("src/features/chat/ChatShell.tsx"),
  "utf8"
);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

function member(over: Partial<RosterMember> = {}): RosterMember {
  return {
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
    ...over,
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

function mountShell(): HTMLElement {
  if (host === null) {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
  }
  act(() => {
    mountedRoot?.render(
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(
          MemoryRouter,
          { initialEntries: [`/c/${CHANNEL}`] },
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
    );
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
  dmState.channel = null;
  directoryState.isPending = true;
  directoryState.isFetching = true;
  directoryState.error = null;
  directoryState.directory = makeDirectory([]);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

describe("canAddChannelMemberNow", () => {
  it("says nothing while the roster is in flight, even for an owner", () => {
    expect(canAddChannelMemberNow(false, undefined, "public")).toBe(false);
    expect(canAddChannelMemberNow(false, "owner", "public")).toBe(false);
    expect(canAddChannelMemberNow(false, "member", "public")).toBe(false);
  });

  it("hides the card once the roster settles as a member", () => {
    expect(canAddChannelMemberNow(true, "member", "public")).toBe(false);
    expect(canAddChannelMemberNow(true, "guest", "public")).toBe(false);
  });

  it("offers the card once the roster settles as owner or admin", () => {
    expect(canAddChannelMemberNow(true, "owner", "public")).toBe(true);
    expect(canAddChannelMemberNow(true, "admin", "private")).toBe(true);
  });

  it("never offers add-member on a DM", () => {
    expect(canAddChannelMemberNow(true, "owner", "dm")).toBe(false);
  });
});

describe("ChatShell add-member offer follows the roster", () => {
  it("wires canAddMember through canAddChannelMemberNow and the in-flight roster", () => {
    expect(SHELL_SRC).toContain("canAddChannelMemberNow");
    expect(SHELL_SRC).toMatch(
      /canAddChannelMemberNow\(\s*!directoryQuery\.isPending/
    );
    expect(SHELL_SRC).not.toMatch(
      /canAddMember=\{\s*[\s\S]{0,200}canCreateChannel\(/
    );
  });

  it("does not flash the add-member card from roster pending to settled member", () => {
    const root = mountShell();
    expect(root.querySelector("[data-testid='timeline-empty']")).not.toBeNull();
    expect(
      root.querySelector("[data-testid='timeline-empty-secondary']")
    ).toBeNull();
    expect(root.textContent).not.toContain(EMPTY_ADD_MEMBER_ACTION_LABEL);

    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory([member({ role: "member" })]);
    mountShell();

    expect(root.querySelector("[data-testid='timeline-empty']")).not.toBeNull();
    expect(
      root.querySelector("[data-testid='timeline-empty-secondary']")
    ).toBeNull();
    expect(root.textContent).not.toContain(EMPTY_ADD_MEMBER_ACTION_LABEL);
    expect(
      root.querySelector("[data-testid='timeline-empty-primary']")
    ).not.toBeNull();
  });

  it("shows the add-member card only after the roster settles as owner", () => {
    directoryState.isPending = true;
    directoryState.directory = makeDirectory([]);
    const root = mountShell();
    expect(
      root.querySelector("[data-testid='timeline-empty-secondary']")
    ).toBeNull();

    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory([member({ role: "owner" })]);
    mountShell();

    const add = root.querySelector(
      "[data-testid='timeline-empty-secondary']"
    );
    expect(add).not.toBeNull();
    expect(add?.textContent).toContain(EMPTY_ADD_MEMBER_ACTION_LABEL);
  });
});

describe("빈 채널의 「에이전트 연결」 (#3697)", () => {
  const connect = (root: HTMLElement) =>
    root.querySelector("[data-testid='timeline-empty-connect-agent']");

  it("에이전트가 한 명도 없는 워크스페이스의 소유자에게만 선다", () => {
    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory([member({ role: "owner" })]);
    const root = mountShell();
    expect(connect(root)?.textContent).toContain("에이전트 연결");
  });

  it("로스터가 정착하기 전에는 세우지 않는다", () => {
    directoryState.isPending = true;
    directoryState.directory = makeDirectory([member({ role: "owner" })]);
    expect(connect(mountShell())).toBeNull();
  });

  it("관리자가 아니면 세우지 않는다", () => {
    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory([member({ role: "member" })]);
    expect(connect(mountShell())).toBeNull();
  });

  it("활성 에이전트가 있으면 세우지 않는다", () => {
    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory([
      member({ role: "owner" }),
      member({ id: "agent-1", kind: "agent", handle: "kim-intern", displayName: "김인턴" }),
    ]);
    expect(connect(mountShell())).toBeNull();
  });
});

// #4912 (S3 묶음 검증 R3). 머리가 「… · 3명」인 DM의 소개가 「둘만 봅니다」라고 말하던 자리를, 화면 전체(ChatShell이 `dmGroupFacts`로
// 판정해 Timeline에 넘기는 길)로 잰다. 단위 시험은 `dmGroup`을 손으로 건네므로 이 연결이 끊겨도 빨개지지 않는다.
describe("그룹 DM의 소개 문구 (#4912)", () => {
  const OTHER = "00000000-0000-7000-8000-000000000102";
  const AGENT = "00000000-0000-7000-8000-000000000103";
  const roster = [
    member(),
    member({ id: OTHER, displayName: "정하윤", handle: "hayun" }),
    member({ id: AGENT, kind: "agent", displayName: "코메토", handle: "cometo" }),
  ];
  const dm = (memberIds: string[]): Channel => ({
    id: CHANNEL,
    workspaceId: WS,
    kind: "dm",
    muted: false,
    memberIds,
  });
  const settle = (channel: Channel) => {
    dmState.channel = channel;
    directoryState.isPending = false;
    directoryState.isFetching = false;
    directoryState.directory = makeDirectory(roster);
  };

  it("셋 이상이면 둘만 본다고 말하지 않고, 머리와 같은 인원을 말한다", () => {
    settle(dm([ME, OTHER, AGENT]));
    const intro = mountShell().querySelector("[data-testid='timeline-empty']");
    expect(intro?.querySelector("h2")?.textContent).toContain("3명");
    expect(intro?.textContent).toContain("여기 쓴 메시지는 이 대화에 있는 3명이 함께 봅니다.");
    expect(intro?.textContent).toContain("에이전트는 이 대화에 들어온 뒤에 쓴 글만 봅니다.");
    expect(intro?.textContent).not.toContain("둘만 봅니다");
    expect(intro?.textContent).not.toContain("이 둘로 고정");
  });

  it("두 사람 DM은 지금까지의 문장 그대로다", () => {
    settle(dm([ME, OTHER]));
    const intro = mountShell().querySelector("[data-testid='timeline-empty']");
    expect(intro?.textContent).toContain("여기 쓴 메시지는 둘만 봅니다. 참여자는 이 둘로 고정됩니다.");
  });
});
