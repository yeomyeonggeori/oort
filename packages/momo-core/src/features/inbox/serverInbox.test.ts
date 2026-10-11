import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { ApiError, fetchInbox, isInboxAbsent, markInboxItemRead, markInboxReadAll } from "../../lib/api";
import {
  asInboxEvent,
  inboxQueryString,
  parseInboxItem,
  parseInboxPage,
  parseInboxTimeMs,
  readStateRailChannelName,
} from "./serverInbox";
import { matchesMailboxFilter, mailboxCounts, serverEntry } from "./mailbox";

const ME = "00000000-0000-7000-8000-000000000101";
const BOT = "00000000-0000-7000-8000-000000000301";

// E2 응답 모양 그대로(camelCase, 시각은 마이크로초 Z).
const WIRE_ITEM = {
  id: "00000000-0000-7000-8000-0000000009a1",
  kind: "reply_to_me",
  reasons: ["reply_to_me", "mention"],
  channel: { id: "00000000-0000-7000-8000-000000000201", name: "agent-lab", kind: "public" },
  message: {
    id: "00000000-0000-7000-8000-0000000008a1",
    seq: 41,
    authorMemberId: BOT,
    preview: "배포 로그 확인했어요",
    deleted: false,
  },
  quotedMessage: {
    id: "00000000-0000-7000-8000-0000000008a0",
    authorMemberId: ME,
    preview: "배포 어떻게 됐어?",
    deleted: false,
  },
  actorMemberId: BOT,
  createdAt: "2026-10-11T04:07:12.123456Z",
  readAt: null,
};

describe("시각: 마이크로초를 밀리초로 자른 뒤 읽는다", () => {
  it("6자리 소수부를 밀리초까지만 쓴다", () => {
    expect(parseInboxTimeMs("2026-10-11T04:07:12.123456Z")).toBe(
      Date.UTC(2026, 9, 11, 4, 7, 12, 123)
    );
    expect(parseInboxTimeMs("2026-10-11T04:07:12.9Z")).toBe(
      Date.UTC(2026, 9, 11, 4, 7, 12, 900)
    );
    expect(parseInboxTimeMs("nope")).toBeNull();
  });
});

describe("parseInboxItem / parseInboxPage", () => {
  it("서버 종류를 화면 종류로 옮기고 안 읽음은 readAt이 비었는지로 정한다", () => {
    const item = parseInboxItem(WIRE_ITEM);
    expect(item?.kind).toBe("reply_to_me");
    expect(item?.readAtMs).toBeNull();
    const entry = serverEntry(item!, {
      channelLabel: "#agent-lab",
      actor: { name: "그록봇", handle: "grokbot", isAgent: true },
      nowMs: Date.UTC(2026, 9, 11, 4, 8, 12),
    });
    expect(entry.kind).toBe("reply");
    expect(entry.itemId).toBe(WIRE_ITEM.id);
    expect(entry.unread).toBe(true);
    expect(entry.typeLabel).toBe("답글 · #agent-lab");
    expect(entry.actor).toBe("@grokbot");
    expect(entry.quotedPreview).toBe("배포 어떻게 됐어?");
    expect(entry.timeLabel).toBe("1분 전");
  });

  it("읽은 항목은 항목으로 남고 안 읽음이 아니다", () => {
    const read = parseInboxItem({ ...WIRE_ITEM, readAt: "2026-10-11T04:09:00.000001Z" })!;
    const entry = serverEntry(read, {
      channelLabel: "#agent-lab",
      actor: { name: "그록봇", isAgent: false },
      nowMs: Date.UTC(2026, 9, 11, 5),
    });
    expect(entry.unread).toBe(false);
  });

  it("삭제된 메시지와 빈 미리보기는 자리표시 문장으로 말한다", () => {
    const del = parseInboxItem({
      ...WIRE_ITEM,
      message: { ...WIRE_ITEM.message, preview: "", deleted: true },
    })!;
    const entry = serverEntry(del, {
      channelLabel: "#x",
      actor: { name: "a", isAgent: false },
      nowMs: 0,
    });
    expect(entry.preview).toBe("삭제된 메시지예요.");
  });

  it("모양이 깨진 줄만 버리고 모르는 종류는 받지 않는다", () => {
    const page = parseInboxPage({
      items: [WIRE_ITEM, { id: "x" }, { ...WIRE_ITEM, kind: "task" }],
      nextCursor: "abc",
      unreadCount: 3,
    });
    expect(page?.items).toHaveLength(1);
    expect(page?.nextCursor).toBe("abc");
    expect(page?.unreadCount).toBe(3);
    expect(parseInboxPage({ nope: true })).toBeNull();
    expect(parseInboxPage({ items: [], nextCursor: null, unreadCount: 0 })?.nextCursor).toBeNull();
  });

  it("필터는 종류가 아니라 사유로 건다(멘션이기도 한 답글은 멘션 탭에도 있다)", () => {
    const entry = serverEntry(parseInboxItem(WIRE_ITEM)!, {
      channelLabel: "#a",
      actor: { name: "a", isAgent: false },
      nowMs: 0,
    });
    expect(matchesMailboxFilter(entry, "reply")).toBe(true);
    expect(matchesMailboxFilter(entry, "mention")).toBe(true);
    expect(matchesMailboxFilter(entry, "thread")).toBe(false);
    expect(mailboxCounts([entry]).mention).toBe(1);
    expect(mailboxCounts([entry]).reply).toBe(1);
    expect(mailboxCounts([entry]).all).toBe(1);
  });
});

describe("쿼리·실시간 이름", () => {
  it("all은 생략하고 나머지만 싣는다", () => {
    expect(inboxQueryString({})).toBe("");
    expect(inboxQueryString({ filter: "all" })).toBe("");
    expect(inboxQueryString({ filter: "reply", cursor: "a b", limit: 30 })).toBe(
      "?filter=reply&cursor=a+b&limit=30"
    );
  });

  it("개인 채널 접미사는 대문자고 인박스 신호만 거른다", () => {
    expect(readStateRailChannelName("ab-cd")).toBe("user:read-state#AB-CD");
    expect(
      asInboxEvent({ type: "inbox_item.created", v: 1, payload: { item_id: "X1" } })
    ).toEqual({ type: "inbox_item.created", itemId: "X1" });
    expect(asInboxEvent({ type: "inbox.read_all", payload: { marked: 2 } })).toEqual({
      type: "inbox.read_all",
    });
    expect(asInboxEvent({ type: "read_state.updated" })).toBeNull();
    expect(asInboxEvent("x")).toBeNull();
  });
});

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "t",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API 클라이언트", () => {
  it("GET /inbox, PUT read, POST read-all의 경로·메서드", async () => {
    installHost();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [WIRE_ITEM], nextCursor: "n", unreadCount: 1 }))
      .mockResolvedValueOnce(
        json({ id: WIRE_ITEM.id, readAt: "2026-10-11T04:10:00.000001Z", unreadCount: 0 })
      )
      .mockResolvedValueOnce(json({ marked: 4, unreadCount: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchInbox("ws-1", { filter: "unread", limit: 30 });
    expect(page.items).toHaveLength(1);
    const read = await markInboxItemRead("ws-1", WIRE_ITEM.id);
    expect(read.unreadCount).toBe(0);
    const all = await markInboxReadAll("ws-1", { filter: "mention" });
    expect(all.marked).toBe(4);

    const calls = fetchMock.mock.calls.map((c) => [String(c[0]), c[1]?.method ?? "GET"]);
    expect(calls).toEqual([
      ["https://oort.test/v1/workspaces/ws-1/inbox?filter=unread&limit=30", "GET"],
      [`https://oort.test/v1/workspaces/ws-1/inbox/${WIRE_ITEM.id}/read`, "PUT"],
      ["https://oort.test/v1/workspaces/ws-1/inbox/read-all?filter=mention", "POST"],
    ]);
  });

  it("404만 구 서버다: 5xx는 장애이므로 후퇴하지 않는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: { message: "not found" } }, 404))
        .mockResolvedValueOnce(json({ error: { message: "boom" } }, 500))
    );
    const absent = await fetchInbox("ws-1").catch((e: unknown) => e);
    expect(isInboxAbsent(absent)).toBe(true);
    const outage = await fetchInbox("ws-1").catch((e: unknown) => e);
    expect(outage).toBeInstanceOf(ApiError);
    expect(isInboxAbsent(outage)).toBe(false);
    expect(isInboxAbsent(new TypeError("network"))).toBe(false);
  });
});
