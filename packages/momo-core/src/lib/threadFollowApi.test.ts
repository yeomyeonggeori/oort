import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { ApiError, fetchThreadReplies, followThread, markThreadRead, unfollowThread } from "./api";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const URL_OF_FOLLOW = "https://oort.test/v1/workspaces/w-1/channels/c-1/messages/m-1/follow";

describe("스레드 따라가기 경로 (ADR-0206 증보 1 F8, #4889)", () => {
  it("따라가기는 본문 없는 PUT …/follow 이고 효과값 following 을 돌려준다", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ following: true }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await followThread("w-1", "c-1", "m-1");
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(URL_OF_FOLLOW);
    expect(call?.[1]?.method).toBe("PUT");
    expect(call?.[1]?.body).toBeUndefined();
    expect(result).toEqual({ following: true });
  });

  it("그만 따라가기는 같은 경로의 본문 없는 DELETE 이고 false 를 돌려준다", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ following: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await unfollowThread("w-1", "c-1", "m-1");
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(URL_OF_FOLLOW);
    expect(call?.[1]?.method).toBe("DELETE");
    expect(call?.[1]?.body).toBeUndefined();
    expect(result).toEqual({ following: false });
  });

  it("서버가 following 을 true 로 말하지 않으면 따라가는 것으로 읽지 않는다", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ following: "yes" })));
    expect(await followThread("w-1", "c-1", "m-1")).toEqual({ following: false });
  });

  it("id 는 경로 조각으로 인코딩된다", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ following: true }));
    vi.stubGlobal("fetch", fetchMock);
    await followThread("w/1", "c 1", "m?1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://oort.test/v1/workspaces/w%2F1/channels/c%201/messages/m%3F1/follow"
    );
  });

  it.each([
    [400, "thread_follow_not_applicable"],
    [403, "not a member of this channel"],
    [404, "thread root not found"],
  ])("%s 는 ApiError(status)로 던진다 - 호출부가 갈라 읽는다", async (status, message) => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: message }, status)));
    const caught = await followThread("w-1", "c-1", "m-1").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(status);
  });

  it("스레드 열기 응답의 following 은 그대로 오고, 옛 서버가 키를 안 주면 비어 있다", async () => {
    installHost();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [], following: true }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const withField = await fetchThreadReplies("w-1", "c-1", "m-1");
    expect(withField.following).toBe(true);
    const old = await fetchThreadReplies("w-1", "c-1", "m-1");
    expect(old.following).toBeUndefined();
    expect(old.following ?? false).toBe(false);
  });
});

const URL_OF_READ = "https://oort.test/v1/workspaces/w-1/channels/c-1/messages/m-1/read";

describe("스레드 읽음 신호 (#4889 2단계)", () => {
  it("PUT …/read 에 읽은 위치를 snake_case 본문으로 싣고, 효과값을 camelCase 로 돌려준다", async () => {
    installHost();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ following: true, last_read_reply_seq: 41, unread_reply_count: 2 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await markThreadRead("w-1", "c-1", "m-1", 41);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(URL_OF_READ);
    expect(call?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ last_read_reply_seq: 41 });
    expect(result).toEqual({ following: true, lastReadReplySeq: 41, unreadReplyCount: 2 });
  });

  it("따라가지 않는 스레드는 following: false 이고 두 수가 없다 — 호출부가 먼저 알 필요가 없다", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ following: false })));
    const result = await markThreadRead("w-1", "c-1", "m-1", 7);
    expect(result).toEqual({ following: false });
    expect(result).not.toHaveProperty("unreadReplyCount");
    expect(result).not.toHaveProperty("lastReadReplySeq");
  });

  it("깨진 수(음수·문자열)는 버리고 following 만 읽는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ following: true, last_read_reply_seq: -3, unread_reply_count: "x" })
      )
    );
    expect(await markThreadRead("w-1", "c-1", "m-1", 7)).toEqual({ following: true });
  });

  it("옛 서버의 404 는 ApiError 로 올라온다 — 호출부가 「기능 없음」으로 읽는다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "not found" } }, 404))
    );
    await expect(markThreadRead("w-1", "c-1", "m-1", 7)).rejects.toBeInstanceOf(ApiError);
  });
});
