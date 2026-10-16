import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginInstallVerdict } from "../features/capabilities/serverSurfaces";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { probePluginWriteRoutes } from "./api";
import { NetworkError } from "./http";

// 「앱 설치」 탐지 (#3860, ADR-0113 증보 P3). 이 프로브의 값은 **바꾸는 것이 없다**는
// 데 있다: 서 있는 설치 경로에 쓰기 동사를 보내면 실제로 설치된다. 그래서 여기서
// 못으로 박는 것은 판정보다 먼저 「GET 둘, 본문 없음, 경로 둘」이다.

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
const PLUGIN = "com.momo.plugins.github";
const ROOT = `https://oort.test/v1/workspaces/${WS}/plugins/${PLUGIN}`;

function answer(status: number): Response {
  return new Response(JSON.stringify({ error: { code: "x", message: "x" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 경로 끝(install, grants)마다 다른 상태를 돌려주는 서버. */
function server(byLeaf: Record<string, number>) {
  return vi.fn(async (url: string) => {
    const leaf = String(url).split("/").pop() ?? "";
    return answer(byLeaf[leaf] ?? 404);
  });
}

describe("probePluginWriteRoutes", () => {
  it("GET만 둘 보낸다: 설치 경로와 권한 경로, 본문 없이", async () => {
    installHost();
    const fetchMock = server({ install: 405, grants: 405 });
    vi.stubGlobal("fetch", fetchMock);
    await probePluginWriteRoutes(WS, PLUGIN);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url).sort()).toEqual([`${ROOT}/grants`, `${ROOT}/install`]);
    for (const [, init] of calls) {
      // 쓰기 동사가 한 번이라도 나가면 서 있는 경로는 실제로 실행된다.
      expect((init.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init.body).toBeUndefined();
    }
  });

  it("서 있는 서버(405, 405)는 상태 코드 둘을 돌려주고 판정은 present다", async () => {
    installHost();
    vi.stubGlobal("fetch", server({ install: 405, grants: 405 }));
    const statuses = await probePluginWriteRoutes(WS, PLUGIN);
    expect(statuses).toEqual([405, 405]);
    expect(pluginInstallVerdict(statuses)).toBe("present");
  });

  it("경로가 없는 서버(404, 404)는 absent다: 오늘의 Rust 서버가 이렇다", async () => {
    installHost();
    vi.stubGlobal("fetch", server({}));
    const statuses = await probePluginWriteRoutes(WS, PLUGIN);
    expect(statuses).toEqual([404, 404]);
    expect(pluginInstallVerdict(statuses)).toBe("absent");
  });

  it("반쪽만 선 서버는 absent다", async () => {
    installHost();
    vi.stubGlobal("fetch", server({ install: 405 }));
    expect(pluginInstallVerdict(await probePluginWriteRoutes(WS, PLUGIN))).toBe("absent");
  });

  it("경로에 대한 진술이 아닌 답(403)은 unknown이다: 닫힌 채 둔다", async () => {
    installHost();
    vi.stubGlobal("fetch", server({ install: 403, grants: 405 }));
    expect(pluginInstallVerdict(await probePluginWriteRoutes(WS, PLUGIN))).toBe("unknown");
  });

  it("아무도 답하지 않은 것은 상태 코드로 접지 않고 그대로 던진다", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(probePluginWriteRoutes(WS, PLUGIN)).rejects.toBeInstanceOf(NetworkError);
  });

  it("워크스페이스와 앱 id를 경로에 인코딩해서 싣는다", async () => {
    installHost();
    const fetchMock = server({ install: 405, grants: 405 });
    vi.stubGlobal("fetch", fetchMock);
    await probePluginWriteRoutes(WS, "com.example/odd id");
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls).toContain(
      `https://oort.test/v1/workspaces/${WS}/plugins/com.example%2Fodd%20id/install`
    );
  });
});
