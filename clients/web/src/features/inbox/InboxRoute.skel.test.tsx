// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "@momo/core/features/inbox/model";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import { NetworkError } from "@momo/core/lib/http";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { InboxRoute } from "./InboxRoute";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const NOW = 1_800_000_000_000;

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

/** 오프라인 띠 시험(#5307 L4)이 켠다. 나머지 시험은 늘 온라인이다. */
const offlineFlag = { value: false };
vi.mock("@/features/common/useOffline", () => ({
  useOffline: () => offlineFlag.value,
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
  /** 서버 경로가 답하지 못한 그 오류 객체(원인 문장을 정한다). 구 서버 경로는 null (#5242). */
  failure: null as unknown,
  moreError: false,
  source: "composed" as "composed" | "server" | "probing",
  serverUnreadCount: null as number | null,
  hasMore: false,
  ledgerAnswered: false,
};
const fetchMore = vi.fn();
const refetchMailbox = vi.fn();
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
    moreError: state.moreError,
    failure: state.failure,
    fetchMore,
    entries: state.entries,
    isLoading: state.isLoading,
    error: state.error,
    tasksAbsent: false,
    ledgerAnswered: state.ledgerAnswered,
    capped: false,
    updatedAtMs: NOW,
    refetch: refetchMailbox,
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

/** `korean`은 사전 문장을 단정하는 시험만 켠다(공급자가 없으면 번들된 영어로 물러난다). 켜면 뿌리가 달라지므로 다시 그리는 시험은 쓰지 않는다. */
async function mount(path = "/inbox", options: { korean?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const page = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(InboxRoute)
    )
  );
  const tree: ReactElement = options.korean ? createElement(LocaleProvider, { locale: ko, children: page }) : page;
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
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
  state.failure = null;
  state.moreError = false;
  refetchMailbox.mockClear();
  state.source = "composed";
  state.serverUnreadCount = null;
  state.hasMore = false;
  state.ledgerAnswered = false;
  offlineFlag.value = false;
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
    const host = await mount("/inbox?filter=task", { korean: true });
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

// 원장이 대기에서 뺀 승인은 고른 줄로 남지 않는다(#5116). 이 클라이언트가 방금 결정했든 다른 기기에서
// 결정됐든 같은 길이다: 원장이 답했는데 목록에 없는 승인은 더 이상 결정을 기다리지 않는다. 컨트롤이 서는
// 패널은 닫히고, 줄은 선택(`aria-current`)에서 풀리고, 초점은 디자인 시스템 규칙대로 이웃 줄로 간다.
describe("InboxRoute mailbox: 원장이 뺀 승인은 선택된 채 남지 않는다 (#5116)", () => {
  const rows = (host: HTMLElement) =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-testid="mailbox-row"]'));
  const keys = (host: HTMLElement) => rows(host).map((r) => r.getAttribute("data-entry-key"));
  const task = (id: string) =>
    entry({
      key: `approval:${id}`,
      kind: "task",
      typeLabel: "처리할 일 · 승인 요청",
      actor: "김인턴",
      actorIsAgent: true,
      preview: `허가 요청 ${id}`,
      task: { ...ITEM, key: `approval:${id}`, approvalId: `ap-${id}` },
    });

  async function rerender(): Promise<void> {
    await act(async () => {
      mountedRoot?.render(
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(MemoryRouter, { initialEntries: ["/inbox"] }, createElement(InboxRoute))
        )
      );
      await Promise.resolve();
    });
  }
  async function open(host: HTMLElement, key: string): Promise<void> {
    const row = rows(host).find((r) => r.getAttribute("data-entry-key") === key);
    await act(async () => {
      row?.click();
      await Promise.resolve();
    });
    row?.focus();
  }
  /** 원장이 다시 답했다: 그 답에 이 승인들이 없다. */
  async function ledgerDrops(...gone: string[]): Promise<void> {
    state.entries = state.entries.filter((e) => !gone.includes(e.key));
    await rerender();
  }

  beforeEach(() => {
    state.source = "server";
    state.ledgerAnswered = true;
    state.entries = [task("a"), task("b"), entry({ key: "dm:a", kind: "dm" })];
  });

  it("고른 승인이 원장에서 빠지면 패널이 닫히고 줄은 선택에서 풀리며 초점은 다음 줄로 간다", async () => {
    const host = await mount();
    await open(host, "approval:a");
    expect(host.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key")).toBe("approval:a");
    expect(rows(host)[0]?.getAttribute("aria-current")).toBe("true");

    await ledgerDrops("approval:a");

    expect(host.querySelector('[data-testid="inbox-detail"]')).toBeNull();
    expect(keys(host)).toEqual(["approval:b", "dm:a"]);
    expect(rows(host).filter((r) => r.getAttribute("aria-current") === "true")).toHaveLength(0);
    // 초점은 줄에 앉을 뿐 줄을 대신 열지 않는다: 다음 승인의 결정 컨트롤이 방금 누른 자리에 서면 안 된다.
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-entry-key")).toBe("approval:b");
    expect(host.querySelector('[data-testid="inbox-detail"]')).toBeNull();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("다음 줄이 없으면 앞 줄로, 줄이 하나도 없으면 목록 자체로 초점이 간다", async () => {
    state.entries = [task("a"), task("b")];
    const host = await mount();
    await open(host, "approval:b");
    await ledgerDrops("approval:b");
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-entry-key")).toBe("approval:a");

    await open(host, "approval:a");
    await ledgerDrops("approval:a");
    expect(host.querySelector('[data-testid="inbox-empty"]')).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="inbox-list-pane"]'));
  });

  it("초점이 이미 다른 곳에 있으면 뺏지 않는다", async () => {
    const host = await mount();
    await open(host, "approval:a");
    const tab = host.querySelector<HTMLElement>('[data-testid="inbox-tab-dm"]');
    tab?.focus();
    await ledgerDrops("approval:a");
    expect(document.activeElement).toBe(tab);
  });

  it("원장이 아직 답하지 않았으면 목록에 없어도 줄을 놓지 않는다(없음이 답이 아니다)", async () => {
    const host = await mount();
    await open(host, "approval:a");
    state.ledgerAnswered = false;
    await ledgerDrops("approval:a");
    expect(host.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key")).toBe("approval:a");
    expect(keys(host)).toContain("approval:a");
  });

  it("승인이 아닌 줄은 원장이 답해도 그대로 남는다(읽은 멘션을 손 밑에서 치우지 않는다)", async () => {
    state.entries = [task("a"), entry({ key: "mention:m1", kind: "mention", typeLabel: "멘션 · #workbench" })];
    const host = await mount();
    await open(host, "mention:m1");
    await ledgerDrops("mention:m1");
    expect(host.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key")).toBe("mention:m1");
    expect(keys(host)).toContain("mention:m1");
  });
});

// #5242: 인박스를 불러오지 못했을 때. 옛 「인박스를 불러오지 못했어요.」 배너는 원인 상자고, 「더 보기」가 실패하면 받아 둔 항목은
// 그대로 둔 채 그 아래 한 줄만 원인과 함께 말한다.
describe("InboxRoute: 불러오기 실패 (#5242)", () => {
  // 지키는 것: 목록이 비면 상자(제목 + 이유 + 다시 시도). 이유는 훅이 준 오류 객체의 원인을 따라가고, 다시 시도가 목록을 다시 읽는다.
  it("읽지 못하면 원인 상자가 서고 이유가 원인을 따라가며 다시 시도가 목록을 다시 읽는다", async () => {
    const cases: [unknown, boolean, string, string][] = [
      [new NetworkError("unreachable", 15_000), false, "deviceOffline", "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
      [new NetworkError("unreachable", 15_000), true, "serverUnreachable", "서버에 닿지 못했어요."],
      [null, true, "", "문제가 생겼어요."],
    ];
    for (const [failure, online, cause, reason] of cases) {
      vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(online);
      state.entries = [];
      state.error = true;
      state.failure = failure;
      refetchMailbox.mockClear();
      const host = await mount("/inbox", { korean: true });
      const box = host.querySelector<HTMLElement>('[data-testid="inbox-error"]');
      expect(box, cause).not.toBeNull();
      expect(box?.getAttribute("role")).toBe("alert");
      expect(box?.getAttribute("data-cause") ?? "").toBe(cause);
      expect(box?.textContent).toContain("인박스를 불러오지 못했어요");
      expect(box?.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      expect(box?.textContent).not.toMatch(/\d{3}/);
      await act(async () => {
        box?.querySelector("button")?.click();
        await Promise.resolve();
      });
      expect(refetchMailbox).toHaveBeenCalledTimes(1);
      act(() => mountedRoot?.unmount());
      mountedHost?.remove();
      mountedRoot = null;
      mountedHost = null;
      vi.restoreAllMocks();
    }
  });

  // 지키는 것: 다음 쪽만 실패하면 받아 둔 항목은 그대로 있고 상자는 없다. 한 줄이 원인과 함께 「이미 받은 항목은 그대로」라고 말한다.
  it("더 보기가 실패하면 받아 둔 항목은 그대로 두고 아래 한 줄이 원인과 함께 말한다", async () => {
    vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(true);
    state.source = "server";
    state.hasMore = true;
    state.moreError = true;
    state.failure = new NetworkError("unreachable", 15_000);
    const host = await mount("/inbox", { korean: true });
    expect(host.querySelector('[data-testid="inbox-error"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="mailbox-row"]').length).toBeGreaterThan(0);
    const line = host.querySelector<HTMLElement>('[data-testid="inbox-more-error"]');
    expect(line?.textContent).toBe(
      "다음 항목을 불러오지 못했어요. 이미 받은 항목은 그대로예요. 서버에 닿지 못했어요."
    );
    expect(host.querySelector('[data-testid="inbox-load-more"]')?.textContent).toBe("다시 시도");
    vi.restoreAllMocks();
  });
});

describe("InboxRoute: 오프라인 띠는 아래에 받아 둔 목록이 있을 때만 「그때의 상태」라고 말한다 (#5307 L4)", () => {
  const band = (host: HTMLElement) => host.querySelector('[data-testid="inbox-offline"]')?.textContent ?? "";
  const NEVER = "아직 이 목록을 한 번도 받지 못했어요";
  const STALE_TAIL = "아래는 그때의 상태예요";

  beforeEach(() => {
    offlineFlag.value = true;
  });

  it("스켈레톤이 아래에 서 있으면 「한 번도 받지 못했어요」라고 말하고 「그때의 상태」는 말하지 않는다", async () => {
    // 목록은 한 번도 안 왔는데(스켈레톤) 시각 값은 있다(승인 원장이 갱신된 시각이 섞인다): 옛 띠는 「마지막 동기화 방금. 아래는 그때의 상태예요」였다.
    state.entries = [];
    state.isLoading = true;
    const host = await mount("/inbox", { korean: true });
    expect(host.querySelector('[data-testid="skeleton"]')?.getAttribute("data-ready")).toBe("false");
    expect(band(host)).toContain(NEVER);
    expect(band(host)).not.toContain(STALE_TAIL);
    expect(band(host)).not.toContain("마지막 동기화");
  });

  it("오류 상자가 아래에 서 있어도 같다", async () => {
    state.entries = [];
    state.error = true;
    const host = await mount("/inbox", { korean: true });
    expect(host.querySelector('[data-testid="inbox-error"]')).not.toBeNull();
    expect(band(host)).toContain(NEVER);
    expect(band(host)).not.toContain(STALE_TAIL);
  });

  it("받아 둔 목록이 아래에 있으면 마지막 동기화 시각과 「그때의 상태」를 말한다", async () => {
    const host = await mount("/inbox", { korean: true });
    expect(host.querySelectorAll('[data-testid="mailbox-row"]').length).toBeGreaterThan(0);
    expect(band(host)).toContain("마지막 동기화");
    expect(band(host)).toContain(STALE_TAIL);
    expect(band(host)).not.toContain(NEVER);
  });

  it("받아 둔 목록이 비어 있어도(받은 적은 있다) 마지막 동기화를 말한다", async () => {
    state.entries = [];
    const host = await mount("/inbox", { korean: true });
    expect(host.querySelector('[data-testid="inbox-empty"]')).not.toBeNull();
    expect(band(host)).toContain("마지막 동기화");
    expect(band(host)).not.toContain(NEVER);
  });
});
