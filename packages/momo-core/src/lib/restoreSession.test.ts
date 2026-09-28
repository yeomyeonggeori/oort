import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installCoreHost, type SessionPort } from "../runtime/host";
import { refreshSessionOutcome, restoreSession } from "./api";

// 이 파일이 존재하는 이유 (RN-C3 워커 발견, 오케스트레이터 실측 확인):
//
// `refreshSession()` 은 서로 다른 두 가지에 같은 `false` 를 냈다 —
//   ① 서버가 거절했다(`markAuthExpired()`, 세션이 진짜 끝났다)
//   ② **아무도 답하지 않았다**(오프라인/도달 불가/데드라인 — 코드 주석이 스스로
//      "세션을 죽었다고 선언하지 않는다"고 적어둔 경우)
// 그런데 `restoreSession()` 은 그 `false` 를 "세션 사망"으로 읽고 `clearSession()`
// 했다. 결과: **네트워크 없이 앱을 한 번 여는 것만으로 리프레시 토큰이 지워져
// 영구 로그아웃**된다. 웹(라이브)과 모바일 양쪽에 있던 결함이다.
//
// 여기서 못박는 것은 "거절과 침묵은 다르게 취급된다" 하나다. 되돌리면 빨개진다.

const persisted = {
  userId: "u-1",
  email: "a@b.test",
  displayName: "성재",
  workspaceId: "w-1",
  memberId: "m-1",
  refreshToken: "refresh-1",
} as never;

function port(overrides: Partial<SessionPort> = {}) {
  const cleared = vi.fn();
  const marked = vi.fn();
  const base: SessionPort = {
    getAccessToken: () => "access-1",
    getRefreshToken: () => "refresh-1",
    getPersistedSession: () => persisted,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: marked,
    clearSession: cleared,
    ...overrides,
  };
  return { base, cleared, marked };
}

function install(session: SessionPort) {
  installCoreHost({
    apiBase: () => "http://server.test",
    publicOrigin: () => "http://server.test",
    buildMode: () => "test",
    session,
  } as never);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreSession — 침묵과 거절을 구분한다", () => {
  it("아무도 답하지 않으면 자격증명을 **지우지 않는다** (오프라인 시작)", async () => {
    const { base, cleared, marked } = port();
    install(base);
    // 네트워크 실패: fetch 가 던진다. 서버는 아무 말도 하지 않았다.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Load failed");
      })
    );

    await expect(restoreSession()).resolves.toBeNull();

    expect(cleared).not.toHaveBeenCalled(); // ← 되돌리면 여기가 빨개진다
    expect(marked).not.toHaveBeenCalled();
  });

  it("서버가 거절하면 지운다 (세션이 진짜 끝났다)", async () => {
    const { base, cleared, marked } = port();
    install(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    await expect(restoreSession()).resolves.toBeNull();

    expect(cleared).toHaveBeenCalled();
    expect(marked).toHaveBeenCalled();
  });
});

describe("refreshSessionOutcome — 세 결말이 구별된다", () => {
  it("도달 불가는 unreachable", async () => {
    install(port().base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Load failed");
      })
    );
    await expect(refreshSessionOutcome()).resolves.toBe("unreachable");
  });

  it("거절은 rejected", async () => {
    install(port().base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );
    await expect(refreshSessionOutcome()).resolves.toBe("rejected");
  });

  it("제시할 토큰이 없는 것은 네트워크 문제가 아니다 — rejected", async () => {
    install(port({ getRefreshToken: () => null }).base);
    await expect(refreshSessionOutcome()).resolves.toBe("rejected");
  });
});

describe("exclusiveRotation — 호스트의 탭 간 배타 구간 (#3067)", () => {
  it("회전은 호스트의 배타 구간 안에서, 그 안에서 다시 읽은 토큰으로 한다", async () => {
    let token = "refresh-stale";
    const order: string[] = [];
    const { base } = port({
      getRefreshToken: () => token,
      exclusiveRotation: async (work) => {
        order.push("lock");
        token = "refresh-reread"; // 호스트의 재읽기가 다른 탭의 회전 결과를 받아들였다
        try {
          return await work();
        } finally {
          order.push("release");
        }
      },
    });
    install(base);
    const presented: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        order.push("fetch");
        presented.push(JSON.parse(String(init?.body)).refreshToken);
        return new Response(JSON.stringify({ accessToken: "a-2", refreshToken: "r-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(presented).toEqual(["refresh-reread"]);
    expect(order).toEqual(["lock", "fetch", "release"]);
  });

  it("배타 구간을 얻지 못하면(락 대기 초과) unreachable — 세션은 지우지도 만료시키지도 않는다", async () => {
    const { base, cleared, marked } = port({
      exclusiveRotation: async () => {
        throw new Error("rotation lease wait timed out");
      },
    });
    install(base);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(restoreSession()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(cleared).not.toHaveBeenCalled();
    expect(marked).not.toHaveBeenCalled();
  });
});
