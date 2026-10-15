import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { ApiError, renameAgent } from "./api";

// ADR-0186 증보 V4 사람용 이름 변경(#3821 / #3729). 서버 규칙(소유자·admin, 충돌)은
// 서버 시험의 몫이고, 여기서는 와이어 계약과 오류 전달만 고정한다.

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

const WS = "00000000-0000-7000-8000-000000000001";
const AGENT = "00000000-0000-7000-8000-000000000202";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("renameAgent", () => {
  it("PATCHes agents/{agent} with only displayName and reads the member", async () => {
    installHost();
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        member: {
          id: AGENT,
          workspaceId: WS,
          kind: "agent",
          displayName: "그록",
          handle: "grok",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const member = await renameAgent(WS, AGENT, "그록");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://oort.test/v1/workspaces/${WS}/agents/${AGENT}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ displayName: "그록" });
    expect(member.displayName).toBe("그록");
  });

  it("surfaces a 409 collision as an ApiError carrying the server sentence", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { message: "display name is already in use" } }, 409)
        )
    );
    const error = await renameAgent(WS, AGENT, "kim").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
  });
});
