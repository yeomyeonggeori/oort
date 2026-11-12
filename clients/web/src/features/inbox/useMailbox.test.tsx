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
// 채널 읽음 위치 투영(`useReadStates`)의 가짜. 시험이 위치를 갈아 끼운다(#5345). 비어 있으면 「위치를 모른다」이다.
const readStatesValue = {
  byChannel: new Map<string, { lastReadSeq: number }>(),
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
  // 서버가 준 채널 사실(`wire`)이 둘째 인자로 오면 그 사실을 이름에 새긴다: 훅이 `wire`를 안 넘기면 시험이 RED가 된다(#5696).
  placeFor: (id: string, wire?: { name: string | null; kind: string }) =>
    wire !== undefined
      ? { kind: "channel", name: `wire:${wire.name}:${wire.kind}` }
      : id === CH
        ? { kind: "channel", name: "agent-lab" }
        : { kind: "dm", names: ["서연"] },
  actorFor: (id: string) =>
    id === BOT
      ? { name: "그록봇", handle: "grokbot", isAgent: true }
      : { name: "서연", isAgent: false },
};
const needsFeed = {
  items: [],
  // `isLoading`은 채널·디렉터리가 오는 중인 것까지 센다. 원장 자신의 첫 응답 대기는 `ledgerLoading`이다.
  isLoading: false,
  ledgerLoading: false,
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
/** 개인 채널 구독 손잡이(`subscribeInbox`)를 줄 때만 시험이 채운다. */
let realtimeHandle: SessionContextValue["realtime"] = null;

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
    realtime: realtimeHandle,
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
  readStatesValue.byChannel = new Map();
  realtimeHandle = null;
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

  it("서버 항목의 출처는 서버가 준 채널 사실(이름·종류)을 장소 판정에 넘겨 짓는다 (#5696)", async () => {
    await render("all");
    expect(latest?.entries[0]?.source).toEqual({
      kind: "place",
      place: { kind: "channel", name: "wire:agent-lab:public" },
    });
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
    const boom = new ApiError(500, "boom");
    api.fetchInbox.mockRejectedValue(boom);
    await render("all");
    expect(latest?.source).toBe("server");
    expect(latest?.error).toBe(true);
    // #5242: 화면이 원인 문장(오프라인 / 서버에 닿지 못함 / 그 밖)을 정하도록 서버 경로의 오류 객체를 그대로 내놓는다.
    expect(latest?.failure).toBe(boom);
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
    needsFeed.ledgerLoading = false;
    needsFeed.absent = false;
    needsFeed.updatedAtMs = 0;
  });

  // 승인이 섞이는 탭(전체·안 읽음·처리할 일)과 아닌 탭. 원장의 말(오류·로딩)은 앞의 셋에만 걸린다(#5116).
  const WITH_TASKS = ["all", "unread", "task"] as const;
  const WITHOUT_TASKS = ["mention", "reply", "dm", "thread"] as const;

  it("원장이 5xx이면 투영이 비어 있어도 서버 경로가 오류를 말한다", async () => {
    needsFeed.error = true;
    for (const filter of WITH_TASKS) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.entries, filter).toEqual([]);
      expect(latest?.error, filter).toBe(true);
    }
  });

  it("승인이 섞이지 않는 탭은 원장이 실패해도 오류를 말하지 않는다 (#5116)", async () => {
    needsFeed.error = true;
    for (const filter of WITHOUT_TASKS) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.error, filter).toBe(false);
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
    needsFeed.ledgerLoading = true;
    for (const filter of WITH_TASKS) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.isLoading, filter).toBe(true);
    }
  });

  it("승인이 섞이지 않는 탭은 원장을 기다리지 않는다 (#5116)", async () => {
    needsFeed.ledgerLoading = true;
    for (const filter of WITHOUT_TASKS) {
      await render(filter);
      expect(latest?.source, filter).toBe("server");
      expect(latest?.isLoading, filter).toBe(false);
    }
  });

  it("채널·디렉터리가 오는 중인 것은 세지 않는다: 원장이 답했으면 로딩이 아니다 (#5116)", async () => {
    needsFeed.isLoading = true; // 컨텍스트(채널·디렉터리)가 아직 온다. 원장 자신은 답했다.
    needsFeed.ledgerLoading = false;
    for (const filter of WITH_TASKS) {
      await render(filter);
      expect(latest?.isLoading, filter).toBe(false);
    }
  });

  it("원장이 답했다는 사실(ledgerAnswered)은 성공한 응답이 있을 때만 참이다 (#5116)", async () => {
    await render("all");
    expect(latest?.ledgerAnswered, "아직 한 번도 답하지 않음").toBe(false);

    needsFeed.updatedAtMs = 1_800_000_000_000;
    await render("all");
    expect(latest?.ledgerAnswered, "성공한 답이 있음").toBe(true);

    needsFeed.absent = true;
    await render("all");
    expect(latest?.ledgerAnswered, "미제공(404)이면 없음이 답이 아니다").toBe(false);
    needsFeed.absent = false;

    // 투영이 답하지 못해 목록 자체를 비운 동안: 승인이 목록에 없는 것은 원장의 답이 아니다.
    // (앞에서 받아 둔 투영 캐시가 목록을 살리지 않도록 새 캐시·새 루트로 다시 묻는다. 훅은 처음 만난
    // QueryClient를 붙들어서 Provider의 client만 바꿔서는 캐시가 바뀌지 않는다.)
    await act(async () => root?.unmount());
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host as HTMLElement);
    api.fetchInbox.mockRejectedValue(new ApiError(500, "boom"));
    await render("task");
    expect(latest?.error).toBe(true);
    expect(latest?.entries).toEqual([]);
    expect(latest?.ledgerAnswered, "목록을 비운 동안").toBe(false);
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
    // 구 서버 경로는 원천이 여럿이라 오류 객체 하나로 말할 수 없다(#5242): 화면은 기기 상태만으로 원인을 정한다.
    expect(latest?.failure).toBeNull();
    // 조합이 실제로 돈다: DM 채널의 최근 메시지를 읽는다.
    expect(api.fetchMessages).toHaveBeenCalledWith(WS, DM, { limit: 20 });
  });
});

describe("useMailbox: 구 서버 경로의 출처 (#5696)", () => {
  const msgOf = (over: Record<string, unknown>) => ({
    id: "m-x",
    channelId: CH,
    seq: 3,
    hlcTs: 1,
    hlcCount: 0,
    type: "text",
    body: "본문",
    createdAtMs: Date.now() - 60_000,
    authorMemberId: ME,
    ...over,
  });
  beforeEach(() => {
    api.fetchInbox.mockRejectedValue(new ApiError(404, "not found"));
  });
  afterEach(() => {
    mentionResults.messages = [];
  });

  it("스레드 안(rootId)의 멘션은 「스레드 · #채널」, 루트 없는 멘션은 「#채널」로 선다", async () => {
    (mentionResults as { messages: unknown[] }).messages = [
      msgOf({ id: "m-in-thread", authorMemberId: BOT, rootId: "m-root", seq: 5 }),
      msgOf({ id: "m-plain", authorMemberId: BOT, seq: 6 }),
    ];
    await render("mention");
    const byId = Object.fromEntries((latest?.entries ?? []).map((e) => [e.messageId, e.source]));
    const place = { kind: "channel", name: "agent-lab" };
    expect(byId["m-in-thread"]).toEqual({ kind: "thread", place });
    expect(byId["m-plain"]).toEqual({ kind: "place", place });
  });

  it("스레드 줄과 DM 줄은 채널·DM 각자의 장소를 받는다", async () => {
    readStatesValue.byChannel = new Map([[CH, { lastReadSeq: 1, latestSeq: 9 }]]) as never;
    api.fetchMessages.mockImplementation((_ws: string, channelId: string) =>
      Promise.resolve({
        messages:
          channelId === CH
            ? [
                msgOf({
                  id: "m-root",
                  thread: { reply_count: 1, last_reply_seq: 9, last_reply_at: Date.now() - 1000 },
                }),
              ]
            : [msgOf({ id: "m-dm", channelId: DM, authorMemberId: BOT, seq: 4 })],
      })
    );
    await render("all");
    const byKey = Object.fromEntries((latest?.entries ?? []).map((e) => [e.key, e.source]));
    expect(byKey["thread:m-root"]).toEqual({
      kind: "thread",
      place: { kind: "channel", name: "agent-lab" },
    });
    expect(byKey[`dm:${DM}`]).toEqual({ kind: "place", place: { kind: "dm", names: ["서연"] } });
  });
});

describe("읽음 처리: 서버 항목은 PUT, 구 서버 항목은 채널 커서", () => {
  const base: MailboxEntry = {
    key: "k", kind: "mention", channelId: CH, channelLabel: "#a", typeLabel: "멘션",
    source: { kind: "place", place: { kind: "channel", name: "a" } }, actor: "서연", actorIsAgent: false, preview: "p", atMs: 0, timeLabel: "방금",
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

  // 메뉴 막대 「모두 읽음 처리」(#5195). 인박스의 read-all은 항목만 읽음으로 하고 채널 위치와 `mention_count`를 그대로 두어서
  // (ADR-0199 D3) 독 배지와 메뉴 막대의 점이 안 꺼진다. 그래서 채널마다 읽음 위치를 올린다 — 사유는 「읽음 처리」 메뉴와 같다.
  it("채널마다 읽음 위치를 올리고, 한 채널의 실패는 나머지를 멈추지 않으며 실패를 센다. 동시에 4개까지다", async () => {
    await render("all");
    let inFlight = 0;
    let peak = 0;
    api.advertiseReadState.mockImplementation(async (_ws: string, channelId: string, seq: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      if (channelId === "ch-bad") throw new Error("down");
      return { channelId, lastReadSeq: seq, latestSeq: seq, unreadCount: 0, mentionCount: 0, markedUnreadBeforeSeq: null };
    });
    const targets = [
      ...Array.from({ length: 7 }, (_, i) => ({ channelId: `ch-${i}`, seq: 10 + i })),
      { channelId: "ch-bad", seq: 3 },
    ];
    let result: { marked: number; failed: number } | undefined;
    await act(async () => {
      result = await actions?.markChannelsRead(targets);
    });
    expect(api.advertiseReadState.mock.calls.map((c) => [c[1], c[2], c[3]]).sort()).toEqual(
      targets.map((t) => [t.channelId, t.seq, "mark_read_menu"]).sort()
    );
    expect(result).toEqual({ marked: 7, failed: 1 });
    expect(peak).toBe(4);
    // 인박스 항목만 읽는 길이 아니다: 그 길은 점을 못 끈다.
    expect(api.markInboxReadAll).not.toHaveBeenCalled();
    expect(api.markInboxItemRead).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 점은 항목 읽음과 채널 읽음 위치를 합쳐 정한다 (#5345, #5331의 웹 판). 규칙은 코어 `isServerItemUnread`다.
//
// 서버는 위치가 전진하는 트랜잭션에서 그 채널의 `seq <= 위치` 항목을 읽음으로 채우지만 그 일은 서버 안에서 끝나서, 이미 받아 둔
// 목록은 그 전 스냅샷으로 남는다(대화를 읽고 15초 안에 받은함으로 돌아오거나 다른 기기가 대화를 읽는 경우). 아래 시험의 가짜 서버는
// 그 스냅샷을 `snapshot()`으로 돌려주고, 위치는 `readStatesValue`로 갈아 끼운다.
// =============================================================================
describe("useMailbox: 점은 항목 읽음과 채널 읽음 위치를 합쳐 정한다 (#5345)", () => {
  // 대문자 id: 서버 응답의 채널 id 와 읽음 위치 투영의 열쇠(`idKey` = 소문자)가 글자 크기만 다를 수 있다.
  const HEX = "0000000a-0000-7000-8000-00000000abcd";
  const OTHER = "0000000b-0000-7000-8000-00000000abcd";
  const dm = (id: string, seq: number, readAt: string | null = null, channelId = HEX) => ({
    id,
    kind: "dm",
    reasons: ["dm"],
    channel: { id: channelId.toUpperCase(), name: null, kind: "dm" },
    message: { id: `m-${id}`, seq, authorMemberId: ME, preview: `dm ${seq}`, deleted: false },
    actorMemberId: ME,
    createdAt: "2026-10-11T04:07:12.123456Z",
    readAt,
  });
  const at = (channelId: string, lastReadSeq: number) => {
    readStatesValue.byChannel = new Map([[channelId, { lastReadSeq }]]);
  };
  const listCalls = () => api.fetchInbox.mock.calls.filter((c) => c[1]?.limit !== 1);
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  };
  const unreadOf = () => Object.fromEntries((latest?.entries ?? []).map((e) => [e.itemId, e.unread]));
  /** 가짜 서버가 이번 읽기에 돌려줄 목록. 시험이 호출 횟수로 갈라 쓴다. */
  let snapshot: (nth: number) => { items: object[]; unreadCount: number } = () => ({ items: [], unreadCount: 0 });

  beforeEach(() => {
    // 목록 읽기는 한 틱 늦게 답한다: 날아가는 동안(`isFetching`)이 한 번은 그려져야 「읽는 중이면 기다린다」와 「같은 낡음은 한 번만」
    // 가드가 실제 네트워크처럼 시험된다(즉시 풀리는 가짜는 읽는 중 상태가 렌더되지 않아 되풀이가 일어날 길이 없다).
    api.fetchInbox.mockImplementation((_ws: string, q: { limit?: number }) => {
      const page = parseInboxPage(
        q.limit === 1
          ? { items: [], nextCursor: null, unreadCount: 0 }
          : { ...snapshot(listCalls().length), nextCursor: null }
      );
      return q.limit === 1 ? Promise.resolve(page) : new Promise((resolve) => setTimeout(() => resolve(page), 10));
    });
  });

  it("위치가 항목에 닿았으면 점이 없고, 못 미치면 남고, 위치를 모르면 항목의 readAt만 본다 (같은 대화의 항목 셋 · 읽은 항목은 점이 다시 켜지지 않는다)", async () => {
    snapshot = () => ({
      items: [
        dm("i3", 3),
        dm("i2", 2),
        dm("i1", 1),
        dm("done", 9, "2026-10-11T04:09:00.000001Z"),
        dm("other", 5, null, OTHER),
      ],
      unreadCount: 4,
    });
    await render("all");
    expect(unreadOf(), "위치를 모른다").toEqual({ i3: true, i2: true, i1: true, done: false, other: true });

    at(HEX, 2);
    await render("all");
    expect(unreadOf(), "위치 2: seq 2 는 닿았고 seq 3 은 못 미쳤다. 위치 밖의 읽은 항목·다른 채널은 그대로").toEqual({
      i3: true,
      i2: false,
      i1: false,
      done: false,
      other: true,
    });
  });

  it("낡은 항목이 있으면 목록을 한 번만 다시 읽고, 서버가 읽음으로 답하면 수도 서버를 따른다", async () => {
    snapshot = (nth) =>
      nth <= 1
        ? { items: [dm("i3", 3), dm("i2", 2), dm("other", 5, null, OTHER)], unreadCount: 3 }
        : {
            items: [
              dm("i3", 3, "2026-10-11T04:09:00.000001Z"),
              dm("i2", 2, "2026-10-11T04:09:00.000001Z"),
              dm("other", 5, null, OTHER),
            ],
            unreadCount: 1,
          };
    at(HEX, 3);
    await render("all");
    await settle();
    expect(listCalls(), "처음 읽기 + 낡은 항목을 알아챈 뒤의 다시 읽기, 그 뒤로는 없다").toHaveLength(2);
    expect(unreadOf()).toEqual({ i3: false, i2: false, other: true });
    expect(latest?.serverUnreadCount).toBe(1);
  });

  it("서버가 다시 읽은 답에서도 안 읽음이라 하면 같은 낡음으로는 더 읽지 않는다 (수는 점을 따라간다) · 위치가 더 전진하면 그때 다시 읽는다", async () => {
    snapshot = () => ({
      items: [dm("i4", 4), dm("i3", 3), dm("i2", 2), dm("other", 5, null, OTHER)],
      unreadCount: 4,
    });
    at(HEX, 3);
    await render("all");
    await settle();
    expect(listCalls(), "같은 낡음(i2·i3)으로는 한 번만").toHaveLength(2);
    expect(unreadOf(), "점은 위치를 따른다: i4(seq 4)와 다른 채널만 남는다").toEqual({ i4: true, i3: false, i2: false, other: true });
    expect(latest?.serverUnreadCount, "서버가 센 4 에서 점이 꺼진 낡은 항목 둘을 뺀다").toBe(2);

    at(HEX, 4);
    await render("all");
    await settle();
    expect(listCalls(), "낡은 항목이 늘었다(i4): 그때 한 번 더").toHaveLength(3);
    expect(latest?.serverUnreadCount).toBe(1);
  });

  it("마운트 재조회가 오는 중이면 그 답을 기다린다: 받아 둔 낡은 목록이 있어도 읽기를 끊고 다시 시작하지 않는다", async () => {
    const cached = parseInboxPage({ items: [dm("i2", 2), dm("i1", 1)], nextCursor: null, unreadCount: 2 });
    // `STALE_MS`(15초)를 넘긴 목록: 마운트가 다시 읽는다.
    client.setQueryData(["inbox", WS, "all"], { pages: [cached], pageParams: [undefined] }, { updatedAt: Date.now() - 60_000 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.fetchInbox.mockImplementation((_ws: string, q: { limit?: number }) =>
      q.limit === 1
        ? Promise.resolve(parseInboxPage({ items: [], nextCursor: null, unreadCount: 0 }))
        : gate.then(() =>
            parseInboxPage({
              items: [dm("i2", 2, "2026-10-11T04:09:00.000001Z"), dm("i1", 1, "2026-10-11T04:09:00.000001Z")],
              nextCursor: null,
              unreadCount: 0,
            })
          )
    );
    at(HEX, 2);
    await render("all");
    await settle();
    expect(listCalls(), "마운트의 읽기 하나가 날아가는 중").toHaveLength(1);
    expect(unreadOf(), "받아 둔 목록도 위치를 따라 이미 점이 없다").toEqual({ i2: false, i1: false });
    await act(async () => { release(); });
    await settle();
    expect(listCalls(), "그 답이 오면 더 읽을 것이 없다").toHaveLength(1);
    expect(latest?.serverUnreadCount).toBe(0);
  });

  // 안 맞던 길이 아니다: 다른 기기가 항목 하나만 읽음으로 누르면 서버가 `inbox_item.read`를 내고 웹은 이미 그 신호로 목록을 다시 읽는다.
  // 같은 규칙으로 다루지 않으니 이 길이 바뀌지 않았음을 고정한다.
  it("다른 기기가 항목 하나만 읽음으로 누른 신호(inbox_item.read)를 받으면 목록을 다시 읽는다 (원래 맞던 길)", async () => {
    let onEvent: (event: { type: string; itemId?: string }) => void = () => undefined;
    realtimeHandle = {
      subscribeInbox: (_memberId: string, handlers: { onEvent: typeof onEvent }) => {
        onEvent = handlers.onEvent;
        return () => undefined;
      },
    } as unknown as SessionContextValue["realtime"];
    snapshot = (nth) => ({
      items: [dm("only", 7, nth <= 1 ? null : "2026-10-11T04:09:00.000001Z")],
      unreadCount: nth <= 1 ? 1 : 0,
    });
    await render("all");
    expect(unreadOf()).toEqual({ only: true });
    await act(async () => { onEvent({ type: "inbox_item.read", itemId: "only" }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await settle();
    expect(listCalls()).toHaveLength(2);
    expect(unreadOf()).toEqual({ only: false });
    expect(latest?.serverUnreadCount).toBe(0);
  });
});
