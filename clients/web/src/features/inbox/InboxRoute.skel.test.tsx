// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import { SessionProvider, type SessionContextValue } from "@/app/session";
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

function entry(over: Partial<MailboxEntry> & { key: string; kind: MailboxEntry["kind"] }): MailboxEntry {
  return {
    channelId: CH,
    channelLabel: "서연",
    typeLabel: "DM · 서연",
    actor: "서연",
    actorIsAgent: false,
    preview: "회의 어때요",
    atMs: NOW,
    timeLabel: "방금",
    unread: true,
    unreadCount: 1,
    seq: 8,
    reason: "r",
    ...over,
  };
}

const state = {
  entries: [] as MailboxEntry[],
  isLoading: false,
  error: false,
};
const markRead = vi.fn((_entry: MailboxEntry) => Promise.resolve());
const markUnread = vi.fn((_entry: MailboxEntry) => Promise.resolve());
const mentionCount = { value: 0 };
const approvalItems = { value: [ITEM] as FeedItem[] };

vi.mock("./useMailbox", () => ({
  useMailbox: () => ({
    entries: state.entries,
    isLoading: state.isLoading,
    error: state.error,
    tasksAbsent: false,
    capped: false,
    updatedAtMs: NOW,
    refetch: () => undefined,
  }),
  useMailboxReadActions: () => ({ markRead, markUnread }),
}));

vi.mock("./useInbox", () => ({
  useNeedsAction: () => ({
    items: approvalItems.value,
    isLoading: false,
    error: false,
    absent: false,
    updatedAtMs: NOW,
    refetch: () => undefined,
  }),
  useFeedContext: () => ({
    directory: { members: [], byId: new Map() },
    labelFor: (id: string) => id,
    actorFor: () => ({ name: "x", isAgent: false }),
    isLoading: false,
  }),
  useMentionCount: () => mentionCount.value,
  useUnreadMentionChannels: () => [],
  useMarkRead: () => () => undefined,
  useInvalidateApprovals: () => () => undefined,
}));

vi.mock("@/features/timeline/MessageRow", () => ({
  Avatar: () => null,
}));

vi.mock("./InboxDetail", () => ({
  InboxDetail: ({ entry: e }: { entry: MailboxEntry }) =>
    createElement("section", { "data-testid": "inbox-detail", "data-key": e.key }, e.typeLabel),
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
  state.entries = [
    entry({ key: "dm:a", kind: "dm" }),
    entry({ key: "mention:m1", kind: "mention", typeLabel: "멘션 · #workbench", actor: "새벽봇" }),
    entry({ key: "dm:b", kind: "dm", unread: false, unreadCount: 0, typeLabel: "DM · 지민" }),
  ];
  state.isLoading = false;
  state.error = false;
  approvalItems.value = [ITEM];
  mentionCount.value = 0;
  markRead.mockClear();
  markUnread.mockClear();
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

describe("InboxRoute mailbox", () => {
  const rows = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('[data-testid="mailbox-row"]'));

  it("wraps the inbox list inside Skeleton (moving the list out turns this red)", async () => {
    const host = await mount();
    const list = host.querySelector('[data-testid="inbox-list"]');
    const skel = host.querySelector(
      '[data-testid="inbox-route"] [data-testid="skeleton"]'
    );
    expect(list).not.toBeNull();
    expect(skel?.contains(list)).toBe(true);
    expect(skel?.getAttribute("data-ready")).toBe("true");
    expect(rows(host)).toHaveLength(3);
  });

  it("stays data-ready=false while the inbox is loading (ready={true} turns this red)", async () => {
    state.entries = [];
    state.isLoading = true;
    const host = await mount();
    const skel = host.querySelector(
      '[data-testid="inbox-route"] [data-testid="skeleton"]'
    );
    expect(skel?.getAttribute("data-ready")).toBe("false");
  });

  it("탭: 전체·안 읽음·멘션·DM·스레드·처리할 일·나중에, 「에이전트」는 없고 활동으로 이어진다", async () => {
    const host = await mount();
    for (const id of ["all", "unread", "mention", "dm", "thread", "task", "reminders"]) {
      expect(host.querySelector(`[data-testid="inbox-tab-${id}"]`), id).not.toBeNull();
    }
    expect(host.querySelector('[data-testid="inbox-tab-agents"]')).toBeNull();
    expect(host.querySelector('[data-testid="inbox-activity-link"]')?.getAttribute("href")).toBe("/activity");
  });

  it("탭 배지는 그 종류의 안 읽음 수 (읽은 DM은 세지 않는다)", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-tab-all"]')?.textContent).toContain("2");
    expect(host.querySelector('[data-testid="inbox-tab-dm"]')?.textContent).toContain("1");
    expect(host.querySelector('[data-testid="inbox-tab-mention"]')?.textContent).toContain("1");
  });

  it("머리 수 = 승인 + 멘션 (레일 배지와 같은 단일 출처)", async () => {
    mentionCount.value = 2;
    approvalItems.value = [{ ...ITEM, approvalId: "ap-1" }];
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-needs-me-count"]')?.textContent).toBe("3");
  });

  it("필요한 일이 없으면 머리 수를 그리지 않는다", async () => {
    approvalItems.value = [];
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-needs-me-count"]')).toBeNull();
  });

  it("안 읽은 줄을 고르면 맥락 패널이 열리고 그 항목이 읽음 처리된다", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-detail"]')).toBeNull();
    await act(async () => {
      (rows(host)[0] as HTMLElement).click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key")).toBe("dm:a");
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[0]).toMatchObject({ key: "dm:a" });
  });

  it("이미 읽은 줄을 열어도 읽음 요청을 다시 보내지 않는다", async () => {
    const host = await mount();
    await act(async () => {
      (rows(host)[2] as HTMLElement).click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="inbox-detail"]')).not.toBeNull();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("고른 멘션이 서버 투영에서 사라져도 사용자가 다른 줄을 고를 때까지 남는다", async () => {
    const host = await mount();
    await act(async () => {
      (rows(host)[1] as HTMLElement).click();
      await Promise.resolve();
    });
    state.entries = state.entries.filter((e) => e.key !== "mention:m1");
    await act(async () => {
      await mountedRoot?.render(
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(MemoryRouter, { initialEntries: ["/inbox"] }, createElement(InboxRoute))
        )
      );
    });
    expect(rows(host).map((r) => r.getAttribute("data-kind"))).toContain("mention");
    expect(host.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key")).toBe("mention:m1");
  });

  it("필터를 바꾸면 고른 줄을 놓는다 (DM 필터에 멘션 줄이 남지 않는다)", async () => {
    const host = await mount();
    await act(async () => {
      (rows(host)[1] as HTMLElement).click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="inbox-detail"]')).not.toBeNull();
    await act(async () => {
      (host.querySelector('[data-testid="inbox-tab-dm"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="inbox-detail"]')).toBeNull();
    expect(rows(host).map((r) => r.getAttribute("data-kind"))).toEqual(["dm", "dm"]);
  });

  it("목록이 비면 비어 있다고 말한다 (실패가 아니라)", async () => {
    state.entries = [];
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="inbox-error"]')).toBeNull();
  });

  it("모든 원천이 실패하면 오류와 다시 시도", async () => {
    state.entries = [];
    state.error = true;
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-error"]')).not.toBeNull();
  });
});
