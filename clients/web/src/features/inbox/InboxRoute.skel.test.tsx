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
  source: "composed" as "composed" | "server" | "probing",
  serverUnreadCount: null as number | null,
  hasMore: false,
};
const fetchMore = vi.fn();
const markAllRead = vi.fn((_filter: string) =>
  Promise.resolve({ marked: 2, unreadCount: 0 })
);
const markRead = vi.fn((_entry: MailboxEntry) => Promise.resolve());
const markUnread = vi.fn((_entry: MailboxEntry) => Promise.resolve());
const mentionCount = { value: 0 };
const approvalItems = { value: [ITEM] as FeedItem[] };

vi.mock("./useMailbox", () => ({
  useMailbox: () => ({
    source: state.source,
    serverUnreadCount: state.serverUnreadCount,
    hasMore: state.hasMore,
    isFetchingMore: false,
    moreError: false,
    fetchMore,
    entries: state.entries,
    isLoading: state.isLoading,
    error: state.error,
    tasksAbsent: false,
    capped: false,
    updatedAtMs: NOW,
    refetch: () => undefined,
  }),
  useMailboxReadActions: () => ({ markRead, markUnread, markAllRead }),
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

async function mount(path = "/inbox"): Promise<HTMLElement> {
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
  state.source = "composed";
  state.serverUnreadCount = null;
  state.hasMore = false;
  fetchMore.mockClear();
  markAllRead.mockClear();
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

  it("구 서버 경로: 답글 탭이 없고, 앞선 메시지까지 읽음이 된다고 말하며, 멘션만 모두 읽음", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-tab-reply"]')).toBeNull();
    expect(host.textContent).toContain("같은 채널의 앞선 메시지까지 함께 읽음으로 바꿔요");
    expect(host.querySelector('[data-testid="mark-all-read"]')?.textContent).toBe(
      "멘션 모두 읽음 처리"
    );
    expect(host.querySelector('[data-testid="inbox-load-more"]')).toBeNull();
  });
});

describe("InboxRoute mailbox: 서버 투영 경로", () => {
  const rows = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('[data-testid="mailbox-row"]'));

  beforeEach(() => {
    state.source = "server";
    state.serverUnreadCount = 7;
    state.hasMore = true;
    state.entries = [
      entry({
        key: "inbox:1",
        itemId: "i-1",
        kind: "reply",
        typeLabel: "답글 · #agent-lab",
        actor: "@grokbot",
      }),
      entry({
        key: "inbox:2",
        itemId: "i-2",
        kind: "mention",
        typeLabel: "멘션 · #workbench",
        unread: false,
        unreadCount: 0,
      }),
    ];
  });

  it("답글 탭이 서고, 배지는 서버가 센 전체 안 읽음만 쓴다(종류별 수를 지어내지 않는다)", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="inbox-tab-reply"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="inbox-tab-all"]')?.textContent).toContain("7");
    expect(host.querySelector('[data-testid="inbox-tab-unread"]')?.textContent).toContain("7");
    expect(host.querySelector('[data-testid="inbox-tab-mention"]')?.textContent).not.toMatch(/\d/);
  });

  it("읽은 항목이 목록에 남는다", async () => {
    const host = await mount();
    expect(rows(host).map((r) => r.getAttribute("data-unread"))).toEqual(["true", "false"]);
  });

  it("앞선 메시지까지 읽음이라는 문장이 없고 채널 위치는 그대로라고 말한다", async () => {
    const host = await mount();
    expect(host.textContent).not.toContain("앞선 메시지까지");
    expect(host.textContent).toContain("채널의 읽음 위치는 그대로예요");
  });

  it("더 보기가 다음 쪽을 부른다", async () => {
    const host = await mount();
    await act(async () => {
      (host.querySelector('[data-testid="inbox-load-more"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(fetchMore).toHaveBeenCalledTimes(1);
  });

  it("모두 읽음은 확인 문구에서 채널 위치가 바뀌지 않는다고 말하고 read-all을 현재 탭 필터로 보낸다", async () => {
    const host = await mount();
    await act(async () => {
      (host.querySelector('[data-testid="mark-all-read"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="mark-all-text"]')?.textContent).toContain(
      "채널의 읽음 위치는 바뀌지 않아요"
    );
    await act(async () => {
      (host.querySelector('[data-testid="mark-all-confirm"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(markAllRead).toHaveBeenCalledWith("all");
  });
});

// 「처리할 일」 탭의 내용은 승인 원장 하나다(#5092 D2·D3). 서버 투영에 다른 종류의 줄이 있는 순간 전체
// 항목 수로 로딩·오류를 가르면 그 탭이 원장의 실패와 로딩을 가리고 「지금 처리할 일이 없어요」라고
// 말한다. 게이트의 투영 스텁은 비어 있어서 이 경우를 못 잡는다 — 여기서 투영에 줄을 둔 채 잰다.
describe("InboxRoute mailbox: 처리할 일 탭은 원장의 실패와 로딩을 가리지 않는다 (#5092)", () => {
  beforeEach(() => {
    state.source = "server";
    state.serverUnreadCount = 1;
    state.entries = [
      entry({
        key: "inbox:1",
        itemId: "i-1",
        kind: "mention",
        typeLabel: "멘션 · #workbench",
      }),
    ];
  });

  it("원장이 실패하면 투영에 줄이 있어도 「없어요」 대신 오류와 다시 시도를 말한다", async () => {
    state.error = true;
    const host = await mount("/inbox?filter=task");
    expect(host.querySelector('[data-testid="inbox-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="inbox-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="inbox-error"] button')?.textContent).toBe("다시 시도");
    if (mountedRoot) act(() => mountedRoot?.unmount());
    mountedHost?.remove();

    // 대조: 같은 실패라도 보여 줄 줄이 있는 탭은 있는 만큼 그린다(부분 실패는 오류가 아니다).
    const all = await mount("/inbox?filter=all");
    expect(all.querySelector('[data-testid="inbox-error"]')).toBeNull();
    expect(all.querySelectorAll('[data-testid="mailbox-row"]')).toHaveLength(1);
  });

  it("원장이 첫 응답을 기다리는 동안은 투영에 줄이 있어도 「없어요」 대신 로딩 막대를 말한다", async () => {
    state.isLoading = true;
    const host = await mount("/inbox?filter=task");
    const skel = host.querySelector('[data-testid="inbox-route"] [data-testid="skeleton"]');
    expect(skel?.getAttribute("data-ready")).toBe("false");
    expect(host.querySelector('[data-testid="inbox-empty"]')).toBeNull();
  });
});
