import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { searchMessages } from "./api";

// =============================================================================
// 검색 요청이 실제로 무엇을 보내는가 (BT-3 / #1931).
//
// 범위 어휘는 features/search/searchModel 이 쥐고 있고 그 규칙은 그 파일 옆에서
// 시험된다. 여기서 못 박는 것은 그 어휘가 **와이어에 닿는 마지막 한 칸**이다:
// `channel=` 이 붙는가, 안 붙는 경우에 정말 안 붙는가.
//
// 계약 원문: server-rust/bins/momo-server/src/routes/search.rs
// =============================================================================

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
const CHANNEL = "00000000-0000-7000-8000-000000000abc";

function stubEmptyPage(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  const [url] = fetchMock.mock.calls[0] as [string];
  return new URL(url);
}

describe("searchMessages 의 범위 파라미터", () => {
  it("범위를 주지 않으면 channel= 을 아예 붙이지 않는다", async () => {
    installHost();
    const fetchMock = stubEmptyPage();
    await searchMessages(WS, "배포");
    const url = requestedUrl(fetchMock);
    // 빈 문자열이 아니라 **부재**다. 서버는 둘을 같게 읽지만, 부재가 이 요청의
    // 참말이고 두 철자가 여기서 뭉개지면 커서 봉인 400을 진단할 수 없게 된다.
    expect(url.searchParams.has("channel")).toBe(false);
    expect(url.searchParams.get("q")).toBe("배포");
  });

  it("채널을 주면 그 id를 channel= 로 싣는다", async () => {
    installHost();
    const fetchMock = stubEmptyPage();
    await searchMessages(WS, "배포", { channelId: CHANNEL });
    expect(requestedUrl(fetchMock).searchParams.get("channel")).toBe(CHANNEL);
  });

  it("커서와 범위는 함께 실린다", async () => {
    installHost();
    const fetchMock = stubEmptyPage();
    await searchMessages(WS, "배포", { channelId: CHANNEL, cursor: "abc123" });
    const params = requestedUrl(fetchMock).searchParams;
    // 서버가 커서에 스코프를 봉인해 두었으므로 둘 중 하나만 보내면 400이다.
    // 「더 보기」가 범위를 흘리면 정확히 그 400을 받는다.
    expect(params.get("cursor")).toBe("abc123");
    expect(params.get("channel")).toBe(CHANNEL);
  });

  it("좁힌 검색에서 서버가 404로 답하면 그대로 올린다", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "channel not found" } }),
            { status: 404, headers: { "content-type": "application/json" } }
          )
      )
    );
    // 읽을 수 없는 채널은 빈 결과가 아니다. 여기서 빈 페이지로 삼키면 화면은
    // "이 채널에는 없습니다"라고 말하게 되고, 그건 서버가 하지 않은 말이다.
    await expect(
      searchMessages(WS, "배포", { channelId: CHANNEL })
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });
});
