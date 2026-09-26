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
import type { Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ChatShell } from "./ChatShell";
import { clearFreshSignup, markFreshSignup } from "@/features/welcome/freshSignup";
import {
  holdKickoffForFreshSignup,
  resetKickoffHoldForTests,
  settleKickoffHold,
} from "@/features/welcome/firstRunGate";
import {
  clearPhoneLinkCardForTests,
  markPhoneLinkCardPending,
} from "@/features/welcome/phoneLinkCardStore";

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";

const virtuoso = vi.hoisted(() => ({
  data: [] as { kind: string; key: string }[],
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

const shownChannel: Channel = {
  id: CHANNEL,
  workspaceId: WS,
  kind: "public",
  name: "general",
  muted: false,
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: { channels: [shownChannel], dms: [] },
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
let host: HTMLElement | null = null;

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
  shownChannel.name = "general";
  clearPhoneLinkCardForTests(WS);
  clearFreshSignup();
  resetKickoffHoldForTests();
  virtuoso.data = [];
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
  clearPhoneLinkCardForTests(WS);
  clearFreshSignup();
  resetKickoffHoldForTests();
});


// =============================================================================
// #2818 (ADR-0193 D7): ChatShell 이 「폰에서도」 카드를 어디에, 언제 세우는가.
// 첫 대화 채널(general)에서만, 킥오프가 끝난 뒤, 타임라인 아래·컴포저 위.
// =============================================================================

function order(root: HTMLElement, ids: string[]): number[] {
  const all = [...root.querySelectorAll("[data-testid]")].map((node) =>
    node.getAttribute("data-testid")
  );
  return ids.map((id) => all.indexOf(id));
}

describe("ChatShell 폰 연결 카드 (#2818)", () => {
  it("general 에서 pending 이면 타임라인 아래·컴포저 위에 선다", () => {
    markPhoneLinkCardPending(WS);
    const root = mountShell();
    expect(root.querySelector("[data-testid='phone-link-card']")).not.toBeNull();
    const [timeline, card, composer] = order(root, [
      "timeline-virtuoso",
      "phone-link-card",
      "composer-input",
    ]);
    expect(timeline).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(timeline!);
    expect(composer).toBeGreaterThan(card!);
    // 카드는 타임라인 안(가상 목록의 행)이 아니다: 오프너 행을 밀거나 덮지 않는다.
    const list = root.querySelector("[data-testid='timeline-virtuoso']");
    expect(list?.querySelector("[data-testid='phone-link-card']")).toBeNull();
  });

  it("다른 채널에는 서지 않는다", () => {
    shownChannel.name = "엔진";
    markPhoneLinkCardPending(WS);
    const root = mountShell();
    expect(root.querySelector("[data-testid='phone-link-card']")).toBeNull();
  });

  it("pending 이 없으면 서지 않는다", () => {
    const root = mountShell();
    expect(root.querySelector("[data-testid='phone-link-card']")).toBeNull();
    expect(
      root.querySelector("[data-testid='phone-link-card-collapsed']")
    ).toBeNull();
  });

  it("새 가입의 킥오프 홀드 동안은 서지 않고, 홀드가 풀리면 선다", () => {
    markPhoneLinkCardPending(WS);
    markFreshSignup({ workspaceId: WS, memberId: ME });
    holdKickoffForFreshSignup();
    const root = mountShell();
    expect(root.querySelector("[data-testid='phone-link-card']")).toBeNull();
    act(() => {
      clearFreshSignup();
      settleKickoffHold();
    });
    expect(root.querySelector("[data-testid='phone-link-card']")).not.toBeNull();
  });
});
