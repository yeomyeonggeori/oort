// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import type { Feed } from "./useInbox";
import { InboxRoute } from "./InboxRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => false,
}));

vi.mock("@/features/reminders/useReminders", () => ({
  useReminders: () => ({
    isLoading: false,
    isError: false,
    data: { reminders: [] },
    dataUpdatedAt: NOW,
    refetch: () => undefined,
  }),
}));

const ITEM: FeedItem = {
  key: "row-1",
  kind: "approval",
  tone: "warn",
  actor: "김인턴",
  actorIsAgent: true,
  predicate: "세션을 마치려고 합니다.",
  outcome: null,
  outcomeTone: "muted",
  channelId: CH,
  channelLabel: "엔진",
  timeLabel: "방금",
  sortAtMs: NOW,
  pending: true,
  reason: "실행 허가",
};

const listFeed: Feed = {
  items: [ITEM],
  isLoading: false,
  error: false,
  absent: false,
  updatedAtMs: NOW,
  refetch: () => undefined,
};

const emptyFeed: Feed = {
  items: [],
  isLoading: false,
  error: false,
  absent: false,
  updatedAtMs: NOW,
  refetch: () => undefined,
};

vi.mock("./useInbox", () => ({
  useNeedsAction: () => listFeed,
  useMentions: () => emptyFeed,
  useAgentFeed: () => emptyFeed,
  useMentionCount: () => 0,
  useUnreadMentionChannels: () => [],
  useMarkRead: () => () => undefined,
  useInvalidateApprovals: () => () => undefined,
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
        id: MEMBER_ID,
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
      { initialEntries: ["/inbox"] },
      createElement(InboxRoute)
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
  listFeed.items = [ITEM];
  listFeed.isLoading = false;
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

describe("InboxRoute skeleton host", () => {
  it("wraps the inbox list inside Skeleton (moving the list out turns this red)", async () => {
    const host = await mount();
    const list = host.querySelector('[data-testid="inbox-list"]');
    const skel = host.querySelector(
      '[data-testid="inbox-route"] [data-testid="skeleton"]'
    );
    expect(list).not.toBeNull();
    expect(skel).not.toBeNull();
    expect(skel?.contains(list)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(skel?.querySelector(".skel-content")).toBeTruthy();
  });

  it("stays data-ready=false while the inbox is loading (ready={true} turns this red)", async () => {
    listFeed.items = [];
    listFeed.isLoading = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="inbox-route"] [data-testid="skeleton"]'
    );
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });
});
