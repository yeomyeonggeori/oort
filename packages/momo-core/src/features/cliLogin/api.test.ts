import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../lib/http";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { approveCliConsent, denyCliConsent, previewCliConsent } from "./api";
import { CliLoginApiError } from "./consent";

// =============================================================================
// oort CLI 로그인 동의 REST 경로: 어떤 요청이 나가고(경로·메서드·헤더·본문), 서버의
// 거절이 어떤 오류로 올라오는가. 서버는 fetch 밖에 있으므로 fetch 만 대신한다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";

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
  vi.restoreAllMocks();
  resetCoreHost();
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[0];
  const init = (call?.[1] ?? {}) as RequestInit;
  return {
    url: String(call?.[0]),
    method: init.method ?? "GET",
    cache: init.cache,
    headers: new Headers(init.headers),
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe("previewCliConsent", () => {
  it("요청 봉투를 쿼리로 실어 GET 하고 사람 세션 Bearer 를 붙인다", async () => {
    installHost();
    const fetchMock = stubFetch(jsonResponse({ clientName: "oort CLI" }));
    const wire = await previewCliConsent(WS, "signed.env/elope+=");
    expect(wire).toEqual({ clientName: "oort CLI" });
    const call = lastCall(fetchMock);
    expect(call.url).toBe(
      `https://oort.test/v1/workspaces/${WS}/dev-access/authorization-requests/preview?request=signed.env%2Felope%2B%3D`
    );
    expect(call.method).toBe("GET");
    expect(call.headers.get("Authorization")).toBe("Bearer access-token");
    expect(call.headers.get("Accept")).toBe("application/json");
  });

  it("어느 응답도 브라우저 캐시에 들지 않게 no-store 로 보낸다", async () => {
    installHost();
    const fetchMock = stubFetch(jsonResponse({}));
    await previewCliConsent(WS, "x");
    expect(lastCall(fetchMock).cache).toBe("no-store");
  });
});

describe("approveCliConsent / denyCliConsent", () => {
  it("허용은 본문을 그대로 POST 한다(approvedScopes 가 없으면 키도 없다)", async () => {
    installHost();
    const fetchMock = stubFetch(
      jsonResponse({ redirectTo: "http://127.0.0.1:24681/callback?code=abc" })
    );
    const wire = await approveCliConsent(WS, {
      request: "signed.envelope",
      currentPassword: "correct horse",
    });
    expect(wire).toEqual({ redirectTo: "http://127.0.0.1:24681/callback?code=abc" });
    const call = lastCall(fetchMock);
    expect(call.url).toBe(
      `https://oort.test/v1/workspaces/${WS}/dev-access/authorization-requests/approve`
    );
    expect(call.method).toBe("POST");
    expect(call.cache).toBe("no-store");
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.body).toEqual({
      request: "signed.envelope",
      currentPassword: "correct horse",
    });
  });

  it("허용 본문의 approvedScopes 는 그대로 전달된다", async () => {
    installHost();
    const fetchMock = stubFetch(jsonResponse({ redirectTo: "x" }));
    await approveCliConsent(WS, {
      request: "r",
      currentPassword: "p",
      approvedScopes: ["dev:identity", "dev:messages:write"],
    });
    expect(lastCall(fetchMock).body.approvedScopes).toEqual([
      "dev:identity",
      "dev:messages:write",
    ]);
  });

  it("거절은 요청 봉투만 POST 한다", async () => {
    installHost();
    const fetchMock = stubFetch(jsonResponse({ redirectTo: "x" }));
    await denyCliConsent(WS, { request: "signed.envelope" });
    const call = lastCall(fetchMock);
    expect(call.url).toBe(
      `https://oort.test/v1/workspaces/${WS}/dev-access/authorization-requests/deny`
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ request: "signed.envelope" });
  });
});

describe("서버의 거절", () => {
  it("상태와 error.code 를 오류에 싣는다", async () => {
    installHost();
    stubFetch(
      jsonResponse(
        { error: { message: "wrong password", code: "current_password_incorrect" } },
        403
      )
    );
    const error = await caught(
      approveCliConsent(WS, { request: "r", currentPassword: "p" })
    );
    expect(error).toBeInstanceOf(CliLoginApiError);
    expect((error as CliLoginApiError).status).toBe(403);
    expect((error as CliLoginApiError).code).toBe("current_password_incorrect");
    expect((error as CliLoginApiError).retryAfterSeconds).toBeUndefined();
  });

  it("429 의 Retry-After 초를 오류에 싣는다", async () => {
    installHost();
    stubFetch(
      jsonResponse({ error: { message: "rate limit exceeded" } }, 429, {
        "Retry-After": "17",
      })
    );
    const error = await caught(
      approveCliConsent(WS, { request: "r", currentPassword: "p" })
    );
    expect((error as CliLoginApiError).status).toBe(429);
    expect((error as CliLoginApiError).retryAfterSeconds).toBe(17);
  });

  it("헤더가 없으면 오류 본문이 실은 초를 읽고, 헤더가 있으면 헤더가 이긴다", async () => {
    installHost();
    stubFetch(jsonResponse({ error: { message: "slow down", retry_after_seconds: 8.2 } }, 429));
    const nested = await caught(approveCliConsent(WS, { request: "r", currentPassword: "p" }));
    expect((nested as CliLoginApiError).retryAfterSeconds).toBe(9);

    stubFetch(jsonResponse({ retry_after_seconds: 5 }, 429));
    const top = await caught(approveCliConsent(WS, { request: "r", currentPassword: "p" }));
    expect((top as CliLoginApiError).retryAfterSeconds).toBe(5);

    stubFetch(
      jsonResponse({ error: { retry_after_seconds: 99 } }, 429, { "Retry-After": "4" })
    );
    const both = await caught(approveCliConsent(WS, { request: "r", currentPassword: "p" }));
    expect((both as CliLoginApiError).retryAfterSeconds).toBe(4);

    stubFetch(jsonResponse({ error: { retry_after_seconds: "soon" } }, 429));
    const junk = await caught(approveCliConsent(WS, { request: "r", currentPassword: "p" }));
    expect((junk as CliLoginApiError).retryAfterSeconds).toBeUndefined();
  });

  it("503 의 Retry-After 도 싣고, 읽을 수 없는 값은 모른 척한다", async () => {
    installHost();
    stubFetch(
      jsonResponse({ error: { message: "busy" } }, 503, { "Retry-After": "2" })
    );
    const busy = await caught(previewCliConsent(WS, "r"));
    expect((busy as CliLoginApiError).retryAfterSeconds).toBe(2);

    for (const value of ["soon", "Wed, 21 Oct 2026 07:28:00 GMT", "-5", "0", ""]) {
      stubFetch(
        jsonResponse({ error: { message: "busy" } }, 503, { "Retry-After": value })
      );
      const error = await caught(previewCliConsent(WS, "r"));
      expect((error as CliLoginApiError).retryAfterSeconds).toBeUndefined();
    }
  });

  it("본문이 없거나 JSON 이 아니면 상태만 남기고, 코드는 비운다", async () => {
    installHost();
    stubFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await caught(previewCliConsent(WS, "r"));
    expect((error as CliLoginApiError).status).toBe(502);
    expect((error as CliLoginApiError).code).toBeUndefined();
    expect((error as CliLoginApiError).message).toBe("HTTP 502");
  });

  it("닿지 못하면 NetworkError 가 그대로 올라온다(서버의 답이 아니다)", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await caught(previewCliConsent(WS, "r"));
    expect(error).toBeInstanceOf(NetworkError);
  });

  it("실패해도 비밀번호나 요청 봉투를 콘솔에 남기지 않는다", async () => {
    installHost();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    stubFetch(jsonResponse({ error: { message: "nope", code: "dev_access_denied" } }, 403));
    await caught(
      approveCliConsent(WS, { request: "secret.envelope", currentPassword: "hunter2" })
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
