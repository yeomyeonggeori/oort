import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { fetchReadStates, updateReadState } from "./api";

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

function putBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) throw new Error("fetch was not called");
  const init = call[1];
  if (typeof init !== "object" || init === null) {
    throw new Error("fetch init is missing");
  }
  const body = "body" in init ? init.body : undefined;
  if (typeof body !== "string") throw new Error("fetch body is not a string");
  return JSON.parse(body) as unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WIRE = {
  channel_id: "c-1",
  last_read_seq: 10,
  latest_seq: 10,
  unread_count: 0,
  mention_count: 0,
  marked_unread_before_seq: 3,
};

describe("read-state wire (ADR-0178 / PR #1961 snake_case)", () => {
  it("GET 항목의 marked_unread_before_seq 를 도메인 필드로 옮긴다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ read_states: [WIRE] }))
    );
    const states = await fetchReadStates("ws");
    expect(states).toEqual([
      {
        channelId: "c-1",
        lastReadSeq: 10,
        latestSeq: 10,
        unreadCount: 0,
        mentionCount: 0,
        markedUnreadBeforeSeq: 3,
      },
    ]);
  });

  it("키는 있고 값이 null 이면 마크가 없는 것이다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          read_states: [{ ...WIRE, marked_unread_before_seq: null }],
        })
      )
    );
    const [state] = await fetchReadStates("ws");
    expect(state?.markedUnreadBeforeSeq).toBeNull();
  });

  it("옛 서버가 키를 생략해도 항목을 버리지 않고 마크 없음으로 읽는다", async () => {
    installHost();
    const { marked_unread_before_seq: _drop, ...legacy } = WIRE;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ read_states: [legacy] }))
    );
    const [state] = await fetchReadStates("ws");
    expect(state?.channelId).toBe("c-1");
    expect(state?.markedUnreadBeforeSeq).toBeNull();
  });

  it("explicit_open 광고는 read_intent 를 싣고 mark 키는 싣지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ...WIRE, marked_unread_before_seq: null })
    );
    vi.stubGlobal("fetch", fetchMock);
    await updateReadState("ws", "c-1", 15, { readIntent: "explicit_open" });
    expect(putBody(fetchMock)).toEqual({
      last_read_seq: 15,
      read_intent: "explicit_open",
    });
  });

  it("도착 중 플러시는 read_intent 를 생략한다 (background)", async () => {
    installHost();
    const fetchMock = vi.fn(async () => jsonResponse(WIRE));
    vi.stubGlobal("fetch", fetchMock);
    await updateReadState("ws", "c-1", 15);
    expect(putBody(fetchMock)).toEqual({ last_read_seq: 15 });
    expect(putBody(fetchMock)).not.toHaveProperty("read_intent");
  });

  it("여기부터 안 읽음은 mark_unread_before_seq 만 싣고 read_intent 는 생략한다", async () => {
    installHost();
    const fetchMock = vi.fn(async () => jsonResponse(WIRE));
    vi.stubGlobal("fetch", fetchMock);
    await updateReadState("ws", "c-1", 10, { markUnreadBeforeSeq: 3 });
    expect(putBody(fetchMock)).toEqual({
      last_read_seq: 10,
      mark_unread_before_seq: 3,
    });
    expect(putBody(fetchMock)).not.toHaveProperty("read_intent");
  });
});
