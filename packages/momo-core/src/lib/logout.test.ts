import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installCoreHost, type SessionPort } from "../runtime/host";
import { logout } from "./api";

// #2677 — 로그아웃에는 「세션을 한 번 더 써야 하는」 정리가 있다.
//
// 폰은 로그아웃할 때 이 기기의 푸시 등록을 지워야 한다(ADR-0120 D4
// `DELETE …/devices/{id}`). 그 요청은 인증이 필요한데, `logout()` 은 로컬 세션을
// **먼저, 무조건** 지운다(느린 망이 사람을 세션 안에 가두지 못하게). 그래서 호스트가
// 바깥에서 부르면 늦다 — 저장소에 토큰이 없다. 서버 폐기 뒤에 부르면 더 늦다 —
// 그 토큰은 이미 죽었다. 쓸 수 있는 창은 「로컬 삭제 뒤, 서버 폐기 전」 하나뿐이고,
// `beforeRevoke` 가 그 창이다. 이 파일은 그 순서를 못박는다.

const persisted = {
  userId: "u-1",
  email: "a@b.test",
  displayName: "성재",
  workspaceId: "w-1",
  memberId: "m-1",
  refreshToken: "refresh-1",
} as never;

interface Seen {
  path: string;
  method: string;
  authorization: string | null;
  storeHadAccess: boolean;
}

function harness(access: string | null = "access-1") {
  let token: string | null = access;
  const events: string[] = [];
  const port: SessionPort = {
    getAccessToken: () => token,
    getRefreshToken: () => "refresh-1",
    getPersistedSession: () => persisted,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {
      events.push("wipe");
      token = null;
    },
  };
  installCoreHost({
    apiBase: () => "http://server.test",
    publicOrigin: () => "http://server.test",
    buildMode: () => "test",
    session: port,
  } as never);

  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        storeHadAccess: token !== null,
      });
      events.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return { events, seen };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logout — beforeRevoke 는 로컬 삭제와 서버 폐기 사이에서 돈다", () => {
  it("캡처한 access 토큰으로, 로컬 삭제 뒤·서버 폐기 전에 한 번 부른다", async () => {
    const { events } = harness();
    const hook = vi.fn(async (accessToken: string) => {
      events.push(`hook:${accessToken}`);
    });

    await logout({ beforeRevoke: hook });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith("access-1");
    // 순서가 계약이다: 사람은 먼저 나가고(wipe), 기기 정리는 토큰이 아직 살아
    // 있을 때(hook), 세션은 그 다음에 죽는다(POST /v1/auth/logout).
    expect(events).toEqual(["wipe", "hook:access-1", "POST /v1/auth/logout"]);
  });

  it("훅이 실패해도 서버 폐기는 일어난다 — 보조 정리가 로그아웃을 막지 못한다", async () => {
    const { seen } = harness();

    await logout({
      beforeRevoke: async () => {
        throw new Error("unreachable");
      },
    });

    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/auth/logout",
    ]);
    expect(seen[0]?.authorization).toBe("Bearer access-1");
  });

  it("들고 나갈 토큰이 없으면 훅도 요청도 없다", async () => {
    const { seen } = harness(null);
    const hook = vi.fn(async () => {});

    await logout({ beforeRevoke: hook });

    expect(hook).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("옵션 없이 부르는 쪽(웹)은 예전과 같다", async () => {
    const { events, seen } = harness();

    await logout();

    expect(events).toEqual(["wipe", "POST /v1/auth/logout"]);
    expect(seen[0]?.storeHadAccess).toBe(false);
    expect(seen[0]?.authorization).toBe("Bearer access-1");
  });
});
