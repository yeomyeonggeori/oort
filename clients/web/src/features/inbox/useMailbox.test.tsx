// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { parseInboxPage } from "@momo/core/features/inbox/serverInbox";
import type { MailboxEntry, MailboxFilter } from "@momo/core/features/inbox/mailbox";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { useMailbox, useMailboxReadActions, type Mailbox } from "./useMailbox";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const BOT = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const DM = "00000000-0000-7000-8000-000000000401";

const api = vi.hoisted(() => ({
  fetchInbox: vi.fn(),
  fetchMessages: vi.fn(),
  fetchThreadReplies: vi.fn(),
  markInboxItemRead: vi.fn(),
  markInboxReadAll: vi.fn(),
  advertiseReadState: vi.fn(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchInbox: api.fetchInbox,
  fetchMessages: api.fetchMessages,
  fetchThreadReplies: api.fetchThreadReplies,
  markInboxItemRead: api.markInboxItemRead,
  markInboxReadAll: api.markInboxReadAll,
}));
vi.mock("@/features/chat/advertiseReadState", () => ({
  advertiseReadState: api.advertiseReadState,
}));

const channelsValue = {
  groups: {
    channels: [{ id: CH, name: "agent-lab" }],
    dms: [{ id: DM, name: null }],
  },
  isLoading: false,
  isError: false,
};
const readStatesValue = {
  byChannel: new Map(),
  data: [],
  isLoading: false,
  dataUpdatedAt: 0,
  refetch: () => undefined,
};
vi.mock("@/features/workspace/useWorkspace", () => ({
  useChannels: () => channelsValue,
  useReadStates: () => readStatesValue,
  applyReadStateToCache: () => undefined,
}));

const feedContext = {
  isLoading: false,
  directory: { members: [], byId: new Map() },
  labelFor: (id: string) => (id === CH ? "#agent-lab" : id.slice(0, 8)),
  actorFor: (id: string) =>
    id === BOT
      ? { name: "그록봇", handle: "grokbot", isAgent: true }
      : { name: "서연", isAgent: false },
};
const needsFeed = {
  items: [],
  isLoading: false,
  error: false,
  absent: false,
  updatedAtMs: 0,
  refetch: () => undefined,
};
const mentionResults = {
  messages: [],
  allFailed: false,
  isLoading: false,
  updatedAtMs: 0,
};
vi.mock("./useInbox", () => ({
  useFeedContext: () => feedContext,
  useNeedsAction: () => needsFeed,
  useMentionMessages: () => ({ results: mentionResults }),
}));

const wireItem = (id: string, readAt: string | null = null) => ({
  id,
  kind: "reply_to_me",
  reasons: ["reply_to_me"],
  channel: { id: CH, name: "agent-lab", kind: "public" },
  message: { id: `m-${id}`, seq: 4, authorMemberId: BOT, preview: "확인했어요", deleted: false },
  quotedMessage: { id: "q", authorMemberId: ME, preview: "배포?", deleted: false },
  actorMemberId: BOT,
  createdAt: "2026-10-11T04:07:12.123456Z",
  readAt,
});

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: Mailbox | null = null;
let actions: ReturnType<typeof useMailboxReadActions> | null = null;
let client: QueryClient;

function Probe({ filter }: { filter: MailboxFilter }) {
  latest = useMailbox(filter);
  actions = useMailboxReadActions();
  return null;
}

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "s" },
      realtimeWebSocketUrl: "wss://x/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function render(filter: MailboxFilter): Promise<void> {
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, { value: session() }, createElement(Probe, { filter }))
      )
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  latest = null;
  actions = null;
  api.fetchMessages.mockResolvedValue({ messages: [] });
  api.fetchThreadReplies.mockResolvedValue({ messages: [] });
  api.markInboxItemRead.mockResolvedValue({ id: "i1", readAtMs: 1, unreadCount: 2 });
  api.markInboxReadAll.mockResolvedValue({ marked: 3, unreadCount: 0 });
  api.advertiseReadState.mockResolvedValue({
    channelId: CH, lastReadSeq: 4, latestSeq: 4, unreadCount: 0, mentionCount: 0, markedUnreadBeforeSeq: null,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
});

const probeCalls = () =>
  api.fetchInbox.mock.calls.filter((c) => c[1]?.limit === 1);

describe("useMailbox: 서버 투영이 정본", () => {
  beforeEach(() => {
    // fetchInbox 자리에 E2 와이어를 넣고 실제 파서를 통과시킨다.
    api.fetchInbox.mockImplementation((_ws: string, q: { cursor?: string; limit?: number }) =>
      Promise.resolve(
        parseInboxPage(
          q.limit === 1
            ? { items: [], nextCursor: null, unreadCount: 0 }
            : q.cursor === "c1"
              ? { items: [wireItem("i2", "2026-10-11T04:09:00.000001Z")], nextCursor: null, unreadCount: 5 }
              : { items: [wireItem("i1")], nextCursor: "c1", unreadCount: 5 }
        )
      )
    );
  });

  it("서버 항목을 그리고, 읽은 항목은 남고, 구 서버 조합은 한 건도 부르지 않는다", async () => {
    await render("all");
    expect(latest?.source).toBe("server");
    expect(latest?.entries.map((e) => [e.itemId, e.kind, e.unread])).toEqual([["i1", "reply", true]]);
    expect(latest?.serverUnreadCount).toBe(5);
    expect(latest?.hasMore).toBe(true);
    expect(api.fetchMessages).not.toHaveBeenCalled();
  });

  it("더 보기는 서버가 준 커서를 그대로 보내고 읽은 항목을 이어 붙인다", async () => {
    await render("all");
    await act(async () => {
      latest?.fetchMore();
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(api.fetchInbox).toHaveBeenCalledWith(WS, expect.objectContaining({ cursor: "c1", filter: "all" }));
    expect(latest?.entries.map((e) => [e.itemId, e.unread])).toEqual([["i1", true], ["i2", false]]);
    expect(latest?.hasMore).toBe(false);
  });

  it("필터를 바꿔도 판별은 다시 하지 않는다: 서버 필터로 목록만 다시 묻는다", async () => {
    await render("all");
    await render("reply");
    await render("mention");
    await render("all");
    expect(probeCalls()).toHaveLength(1);
    const filters = api.fetchInbox.mock.calls.filter((c) => c[1]?.limit !== 1).map((c) => c[1].filter);
    expect(filters).toEqual(["all", "reply", "mention"]);
  });

  it("5xx는 구 서버가 아니라 장애다: 후퇴하지 않고 오류를 말한다", async () => {
    api.fetchInbox.mockRejectedValue(new ApiError(500, "boom"));
    await render("all");
    expect(latest?.source).toBe("server");
    expect(latest?.error).toBe(true);
    expect(api.fetchMessages).not.toHaveBeenCalled();
  });
});

// 처리할 일(승인)은 투영에 저장되지 않아 승인 원장은 투영과 **따로** 오고 따로 실패하고 따로 늦다(#5092
// D2·D3). 투영만 비어 있고 원장이 실패했거나 늦다면 「비어 있어요」는 대기 중인 승인을 모르는 채 하는 말이다.
describe("useMailbox: 승인 원장은 투영과 따로 실패하고 따로 늦는다 (#5092)", () => {
  beforeEach(() => {
    api.fetchInbox.mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
  });
  afterEach(() => {
    needsFeed.error = false;
    needsFeed.isLoading = false;
    needsFeed.absent = false;
  });

  it("원장이 5xx이면 투영이 비어 있어도 서버 경로가 오류를 말한다", async () => {
    needsFeed.error = true;
    for (const filter of ["all", "unread", "task"] as const) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.entries, filter).toEqual([]);
      expect(latest?.error, filter).toBe(true);
    }
  });

  it("원장 404(미제공)는 장애가 아니다: 오류가 아니라 tasksAbsent로 말한다", async () => {
    needsFeed.error = true;
    needsFeed.absent = true;
    await render("task");
    expect(latest?.error).toBe(false);
    expect(latest?.tasksAbsent).toBe(true);
  });

  it("원장이 첫 응답을 기다리는 동안은 투영이 이미 답했어도 서버 경로가 로딩이다", async () => {
    needsFeed.isLoading = true;
    for (const filter of ["all", "unread", "task"] as const) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.isLoading, filter).toBe(true);
    }
  });
});

describe("useMailbox: 구 서버(404) 후퇴", () => {
  beforeEach(() => {
    api.fetchInbox.mockRejectedValue(new ApiError(404, "not found"));
  });

  it("판별은 한 번만 하고(탭을 오가도 /inbox는 1회), 클라이언트 조합이 DM을 읽는다", async () => {
    await render("all");
    await render("mention");
    await render("dm");
    await render("all");
    expect(api.fetchInbox).toHaveBeenCalledTimes(1);
    expect(latest?.source).toBe("composed");
    expect(latest?.hasMore).toBe(false);
    // 조합이 실제로 돈다: DM 채널의 최근 메시지를 읽는다.
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, DM, { limit: 20 });
  });
});

describe("읽음 처리: 서버 항목은 PUT, 구 서버 항목은 채널 커서", () => {
  const base: MailboxEntry = {
    key: "k", kind: "mention", channelId: CH, channelLabel: "#a", typeLabel: "멘션",
    actor: "서연", actorIsAgent: false, preview: "p", atMs: 0, timeLabel: "방금",
    unread: true, unreadCount: 0, seq: 4, reason: "r",
  };

  beforeEach(() => {
    api.fetchInbox.mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it("itemId가 있으면 PUT read만 보내고 채널 읽음 위치는 건드리지 않는다", async () => {
    await render("all");
    await act(async () => {
      await actions?.markRead({ ...base, itemId: "i1" });
    });
    expect(api.markInboxItemRead).toHaveBeenCalledWith(WS, "i1");
    expect(api.advertiseReadState).not.toHaveBeenCalled();
  });

  it("itemId가 없으면 채널 커서를 올린다(구 서버)", async () => {
    await render("all");
    await act(async () => {
      await actions?.markRead(base);
    });
    expect(api.advertiseReadState).toHaveBeenCalledWith(WS, CH, 4, "mark_read_menu");
    expect(api.markInboxItemRead).not.toHaveBeenCalled();
  });

  it("모두 읽음은 read-all에 현재 탭의 서버 필터를 보낸다", async () => {
    await render("all");
    await act(async () => {
      await actions?.markAllRead("reply");
    });
    expect(api.markInboxReadAll).toHaveBeenCalledWith(WS, { filter: "reply" });
  });
});
