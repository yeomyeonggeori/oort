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
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsState,
    useDirectory: () => ({
      directory: makeDirectory(rosterMembers),
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => undefined,
    }),
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

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: [`/c/${DM_ID}`] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/c/:channelId",
          element: createElement(ChatShell),
        })
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
