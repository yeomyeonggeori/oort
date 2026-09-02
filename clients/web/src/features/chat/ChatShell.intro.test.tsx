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
      groups: { channels: [engineChannel], dms: [] },
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

vi.mock("@/features/timeline/useTimeline", () => ({
  useTimeline: () => ({
    state: { messages: [], oldestSeq: null, newestSeq: null },
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
