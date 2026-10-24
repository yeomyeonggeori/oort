import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { ApiError, closeDm, reopenDm } from "./api";

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

describe("DM 닫기 경로 (ADR-0177 D7, #4227)", () => {
  it("닫기는 PUT …/closure 에 seenSeq 를 싣는다", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await closeDm("w-1", "c-1", 42);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("https://oort.test/v1/workspaces/w-1/channels/c-1/closure");
    expect(call?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ seenSeq: 42 });
  });

  it("다시 열기는 같은 경로의 DELETE 이고 본문이 없다", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await reopenDm("w-1", "c-1");
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("https://oort.test/v1/workspaces/w-1/channels/c-1/closure");
    expect(call?.[1]?.method).toBe("DELETE");
    expect(call?.[1]?.body).toBeUndefined();
  });

  it("404 는 ApiError(status 404)로 던진다 - 호출부가 항목별로 갈라 읽는다", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "dm not found" }, 404)));
    const caught = await closeDm("w-1", "c-1", 1).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
  });
});
