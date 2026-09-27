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
import { hasLocalCardHost, openLocalCardIn } from "./localCards";
import { clearFreshSignup } from "@/features/welcome/freshSignup";
import {
  resetKickoffHoldForTests,
} from "@/features/welcome/firstRunGate";
import {
  clearPhoneLinkCardForTests,
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
      components?: { Footer?: () => ReactElement | null };
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
      [
        ...props.data.map((item, index) =>
          createElement("div", { key: item.key }, props.itemContent(index, item))
        ),
        props.components?.Footer
          ? createElement(props.components.Footer, { key: "footer" })
          : null,
      ]
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

// #2780: 헤더 도크 판정은 호스트 목록(React Query)을 읽는다. 이 파일은 도크를
// 재지 않으므로 호스트 없음(셀프호스트 기본)으로 고정한다.
vi.mock("@/features/capabilities/useSurfaceProvided", () => ({
  useSurfaceProvided: () => false,
  useSurfaceProvidedPredicate: () => () => false,
  useWorkHostPresence: () => "absent",
}));

vi.mock("@/features/work/TerminalDock", () => ({
  TerminalDock: () => null,
}));

vi.mock("@/features/timeline/ThreadPanel", () => ({
  ThreadPanel: () => null,
}));

// 카드 본체의 흐름은 AiConnectCard.test.tsx가 잰다. 여기서는 자리·수명만 본다.
vi.mock("./AiConnectCard", () => ({
  AiConnectCard: (props: { line: string | null; focusNonce: number; onClose: () => void }) =>
    createElement(
      "div",
      {
        "data-testid": "ai-connect-card",
        "data-line": props.line ?? "all",
        "data-nonce": String(props.focusNonce),
      },
      createElement("button", { "data-testid": "stub-close", onClick: props.onClose }, "닫기")
    ),
  // 제안 카드(#2948)는 ChatShell이 자리만 건넨다. 본체는 MessageRow.commandSuggest.test가 잰다.
  AiConnectSuggestion: () => null,
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
// #2944 GC-3: 로컬 연결 카드의 자리와 수명 (brief §3.2 · Q1).
// 타임라인 꼬리(virtuoso Footer), 목록 데이터 밖, 채널당 한 장, 닫으면 컴포저로.
// =============================================================================

describe("ChatShell 로컬 연결 카드 (#2944)", () => {
  it("채널이 서면 카드 자리를 등록하고, 부탁하면 타임라인 꼬리에 선다", () => {
    const root = mountShell();
    expect(hasLocalCardHost(CHANNEL)).toBe(true);
    expect(root.querySelector("[data-testid='ai-connect-card']")).toBeNull();

    let opened = false;
    act(() => {
      opened = openLocalCardIn(CHANNEL, "ai.connect", { line: "team" });
    });
    expect(opened).toBe(true);
    const card = root.querySelector("[data-testid='ai-connect-card']");
    expect(card?.getAttribute("data-line")).toBe("team");
    // 꼬리 행: 타임라인(virtuoso) 안, 목록 데이터에는 들어가지 않는다.
    const list = root.querySelector("[data-testid='timeline-virtuoso']");
    expect(list?.querySelector("[data-testid='timeline-tail'] [data-testid='ai-connect-card']")).not.toBeNull();
    expect(virtuoso.data.some((item) => item.kind === "local-card")).toBe(false);
  });

  it("다시 부르면 새로 쌓지 않고 같은 카드의 초점만 옮긴다", () => {
    const root = mountShell();
    act(() => void openLocalCardIn(CHANNEL, "ai.connect", {}));
    act(() => void openLocalCardIn(CHANNEL, "ai.connect", { line: "claude" }));
    const cards = root.querySelectorAll("[data-testid='ai-connect-card']");
    expect(cards).toHaveLength(1);
    expect(Number(cards[0]?.getAttribute("data-nonce"))).toBeGreaterThan(1);
    expect(cards[0]?.getAttribute("data-line")).toBe("claude");
  });

  it("닫으면 사라지고 초점이 컴포저로 돌아간다", () => {
    const root = mountShell();
    act(() => void openLocalCardIn(CHANNEL, "ai.connect", {}));
    const close = root.querySelector<HTMLButtonElement>("[data-testid='stub-close']");
    act(() => close?.click());
    expect(root.querySelector("[data-testid='ai-connect-card']")).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-input");
  });

  it("화면이 내려가면(채널 이동·새로고침) 자리도 카드도 없다", () => {
    mountShell();
    act(() => void openLocalCardIn(CHANNEL, "ai.connect", {}));
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(hasLocalCardHost(CHANNEL)).toBe(false);
    expect(openLocalCardIn(CHANNEL, "ai.connect", {})).toBe(false);
    // 다시 서도 카드는 없다: 카드는 이 화면 메모리에만 있었다.
    host?.remove();
    host = null;
    const root = mountShell();
    expect(root.querySelector("[data-testid='ai-connect-card']")).toBeNull();
  });
});
