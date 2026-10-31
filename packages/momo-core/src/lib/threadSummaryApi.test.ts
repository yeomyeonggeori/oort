import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  sendMessage,
  sendThreadReply,
  threadRollup,
  type Message,
} from "./api";
import { payloadToMessage, type MessageNewEvent } from "./realtimeEvents";

// #4877 (스레드 요약의 참여자) · #4887 (대화에도 보내기) — 코어가 와이어를 읽고 쓰는 모양.
// 서버 쪽 정본은 ADR-0148 증보 2026-10-31이고, 서버 시험이 같은 키를 단정한다.

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
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

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) throw new Error("fetch was not called");
  const init = call[1];
  if (typeof init !== "object" || init === null || !("body" in init)) {
    throw new Error("fetch init has no body");
  }
  if (typeof init.body !== "string") throw new Error("fetch body is not a string");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function created(): Response {
  const message = {
    id: "m-1",
    channelId: "c-1",
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: "a-1",
    type: "text",
    createdAtMs: 1,
  };
  return new Response(JSON.stringify(message), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function rootWith(thread: Message["thread"]): Message {
  return {
    id: "root",
    channelId: "c-1",
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: "a-1",
    type: "text",
    createdAtMs: 1,
    ...(thread === undefined ? {} : { thread }),
  };
}

describe("threadRollup — 답글 단 사람 (#4877)", () => {
  it("서버가 준 순서(최근 먼저)와 수를 그대로 옮긴다 — 수는 얼굴 수가 아니다", () => {
    const rollup = threadRollup(
      rootWith({
        reply_count: 9,
        last_reply_seq: 40,
        last_reply_at: 1_700_000_000_000,
        participant_ids: ["new", "mid", "old"],
        participant_count: 5,
      })
    );
    expect(rollup).toEqual({
      replyCount: 9,
      lastReplySeq: 40,
      lastReplyAtMs: 1_700_000_000_000,
      participantIds: ["new", "mid", "old"],
      participantCount: 5,
    });
  });

  it("옛 서버는 두 키를 안 보낸다 — 얼굴 없음(빈 목록·0)이지 롤업 없음이 아니다", () => {
    const rollup = threadRollup(
      rootWith({ reply_count: 2, last_reply_seq: 7, last_reply_at: 1 })
    );
    expect(rollup).not.toBeNull();
    expect(rollup?.replyCount).toBe(2);
    expect(rollup?.participantIds).toEqual([]);
    expect(rollup?.participantCount).toBe(0);
  });

  it("수 키만 없으면 얼굴 수로 채우고, 문자열이 아닌 항목은 그 한 건만 버린다", () => {
    const rollup = threadRollup(
      rootWith({
        reply_count: 3,
        last_reply_seq: 9,
        last_reply_at: 1,
        participant_ids: ["a", 12 as unknown as string, "b"],
      })
    );
    expect(rollup?.participantIds).toEqual(["a", "b"]);
    expect(rollup?.participantCount).toBe(2);
  });

  it("답글이 없는 롤업은 여전히 null이다(배지의 부재가 「스레드 없음」)", () => {
    expect(
      threadRollup(
        rootWith({
          reply_count: 0,
          last_reply_seq: 0,
          last_reply_at: 0,
          participant_ids: ["a"],
          participant_count: 1,
        })
      )
    ).toBeNull();
    expect(threadRollup(rootWith(undefined))).toBeNull();
  });
});

describe("대화에도 보내기 (#4887) — 보내는 쪽", () => {
  it("스레드 답글을 켜면 alsoInChannel: true 가 rootId 와 함께 간다", async () => {
    installHost();
    const fetchMock = vi.fn(async () => created());
    vi.stubGlobal("fetch", fetchMock);
    await sendThreadReply("ws", "c-1", "root", "client-1", "함께 보내요", {
      alsoInChannel: true,
    });
    const body = sentBody(fetchMock);
    expect(body.rootId).toBe("root");
    expect(body.alsoInChannel).toBe(true);
  });

  it("끄거나 없으면 키 자체가 빠진다 — 옛 서버의 닫힌 요청이 400 내지 않게", async () => {
    installHost();
    for (const options of [undefined, {}, { alsoInChannel: false }]) {
      const fetchMock = vi.fn(async () => created());
      vi.stubGlobal("fetch", fetchMock);
      await sendThreadReply("ws", "c-1", "root", "client-1", "스레드에만", options);
      expect(Object.keys(sentBody(fetchMock))).not.toContain("alsoInChannel");
    }
  });

  it("sendMessage 는 rootId 가 없는 전송이라 alsoInChannel 을 어떤 모양으로도 싣지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async () => created());
    vi.stubGlobal("fetch", fetchMock);
    // 타입이 이미 막는다(`SendMessageOptions` 에 그 필드가 없다). 런타임에 억지로 넣어도 키는 안 간다.
    await sendMessage("ws", "c-1", "client-2", "본류 글", {
      alsoInChannel: true,
    } as never);
    expect(Object.keys(sentBody(fetchMock))).not.toContain("alsoInChannel");
  });
});

describe("대화에도 보내기 (#4887) — 받는 쪽(실시간 프레임)", () => {
  function frame(extra: Record<string, unknown>): MessageNewEvent["payload"] {
    return {
      id: "m-2",
      channel_id: "c-1",
      seq: 5,
      type: "text",
      body: "답글",
      author_member_id: "a-1",
      hlc_ts: 1,
      hlc_count: 0,
      root_id: "root",
      ...extra,
    };
  }

  it("also_in_channel: true 만 alsoInChannel 이 된다", () => {
    expect(payloadToMessage(frame({ also_in_channel: true })).alsoInChannel).toBe(true);
  });

  it("키가 없거나 true 가 아니면 필드를 만들지 않는다 — 침묵은 「꺼짐」이다", () => {
    for (const extra of [{}, { also_in_channel: false }, { also_in_channel: "true" }]) {
      const message = payloadToMessage(frame(extra));
      expect("alsoInChannel" in message).toBe(false);
    }
  });
});
