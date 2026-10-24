import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { fetchReadStates, touchChannelViewing, updateReadState } from "./api";

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

// ADR-0177 D6/D8/D9 (#4227): two fields join the `GET read-state` rows. The contract the client
// slices (#4228, #4229) lean on is that the parser keeps THREE states apart for `closedAtSeq`:
// a number (closed at), `null` (the GET said "not closed") and `undefined` (this response did not
// say - an older server, the `PUT read-state` response, the realtime frame). If `undefined` ever
// collapsed into `null`, applying a response that merely lacks the field would reopen every closed
// DM; if `null` collapsed into `undefined`, a DM could never be seen as reopened.
describe("read-state wire: DM closure fields (ADR-0177)", () => {
  const withClosure = {
    ...WIRE,
    latest_readable_seq: 8,
    closed_at_seq: 7,
  };

  it("숫자는 숫자로 옮긴다: 닫은 워터마크와 읽을 메시지의 끝", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ read_states: [withClosure] }))
    );
    const [state] = await fetchReadStates("ws");
    expect(state?.closedAtSeq).toBe(7);
    expect(state?.latestReadableSeq).toBe(8);
    // 옛 필드는 그대로다.
    expect(state?.latestSeq).toBe(10);
    expect(state?.markedUnreadBeforeSeq).toBe(3);
  });

  it("GET 이 null 을 주면 null 이다: 닫지 않았다고 말한 것이다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          read_states: [{ ...WIRE, latest_readable_seq: 0, closed_at_seq: null }],
        })
      )
    );
    const [state] = await fetchReadStates("ws");
    expect(state?.closedAtSeq).toBeNull();
    expect(state).toHaveProperty("closedAtSeq", null);
    // 0 은 「읽을 메시지가 아직 없다」는 값이지 「모름」이 아니다.
    expect(state?.latestReadableSeq).toBe(0);
  });

  it("키가 없으면 undefined 이고 키 자체가 생기지 않는다: 응답이 말하지 않은 것을 null 로 만들지 않는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ read_states: [WIRE] }))
    );
    const [state] = await fetchReadStates("ws");
    expect(state?.closedAtSeq).toBeUndefined();
    expect(state?.latestReadableSeq).toBeUndefined();
    expect(state).not.toHaveProperty("closedAtSeq");
    expect(state).not.toHaveProperty("latestReadableSeq");
  });

  it("PUT read-state 응답도 같다: 두 필드를 싣지 않으므로 undefined 로 읽힌다", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(WIRE)));
    const state = await updateReadState("ws", "c-1", 10);
    expect(state).not.toHaveProperty("closedAtSeq");
    expect(state).not.toHaveProperty("latestReadableSeq");
  });

  it("망가진 값은 undefined 다: 닫혔다는 말도 열렸다는 말도 아니다", async () => {
    installHost();
    const broken = [
      { closed_at_seq: -1, latest_readable_seq: -1 },
      { closed_at_seq: 1.5, latest_readable_seq: 2.5 },
      { closed_at_seq: "7", latest_readable_seq: "8" },
      { closed_at_seq: true, latest_readable_seq: true },
      { closed_at_seq: {}, latest_readable_seq: [] },
    ];
    for (const extra of broken) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ read_states: [{ ...WIRE, ...extra }] }))
      );
      const [state] = await fetchReadStates("ws");
      expect(state?.channelId, JSON.stringify(extra)).toBe("c-1");
      expect(state, JSON.stringify(extra)).not.toHaveProperty("closedAtSeq");
      expect(state, JSON.stringify(extra)).not.toHaveProperty("latestReadableSeq");
    }
  });

  it("두 필드는 항목마다 독립이다: 한 응답 안에서 닫은 DM, 닫지 않은 DM, 옛 모양이 섞여도 각자 제 것을 가진다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          read_states: [
            { ...WIRE, channel_id: "closed", latest_readable_seq: 5, closed_at_seq: 5 },
            { ...WIRE, channel_id: "open", latest_readable_seq: 9, closed_at_seq: null },
            { ...WIRE, channel_id: "old" },
          ],
        })
      )
    );
    const states = await fetchReadStates("ws");
    expect(states.map((s) => [s.channelId, s.closedAtSeq, s.latestReadableSeq])).toEqual([
      ["closed", 5, 5],
      ["open", null, 9],
      ["old", undefined, undefined],
    ]);
  });
});

describe("touchChannelViewing", () => {
  it("PUT .../channels/{ch}/viewing 를 본문 없이 보낸다", async () => {
    installHost();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await touchChannelViewing("w 1", "c/1");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "https://oort.test/v1/workspaces/w%201/channels/c%2F1/viewing"
    );
    expect(call[1].method).toBe("PUT");
    expect(call[1].body ?? undefined).toBeUndefined();
  });

  it("404는 ApiError(status 404)로 던진다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "nf" } }, 404))
    );
    await expect(touchChannelViewing("w", "c")).rejects.toMatchObject({
      status: 404,
    });
  });
});
