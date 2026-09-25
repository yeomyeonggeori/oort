import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installCoreHost, type SessionPort } from "../runtime/host";
import { logout, refreshSessionOutcome } from "./api";

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

// =============================================================================
// #2677 리뷰 R1 — 로그아웃이 기다려야 하는 두 가지.
//
// M1: refresh 회전이 도는 중에 로그아웃하면, 들고 있던 pair(P1)는 서버에서 이미
// 쓰였다. 그 pair로 보낸 logout 은 `revokedRefresh:false` 를 받고 세션(계보)을
// 끝내지 못한다. 회전이 막 발급한 P2 는 클라이언트가 버리지만(`applyRotation` 은
// 지운 뒤라 아무것도 쓰지 않는다) 서버에서는 30일 산다. QR 연결 폰은 회전이 P1 의
// access 까지 죽였으므로 폰의 DELETE 도 401 이다. 그래서 로그아웃은 진행 중인
// 회전에 합류하고, 그 회전이 발급한 pair 로 훅과 서버 폐기를 보낸다.
//
// L4: 훅은 「기다린다」가 계약이다. 호출 순서만 보는 시험은 `await` 를 빼도
// 초록이었다(리뷰 SP1). 훅이 풀리기 전에는 서버 폐기가 없어야 한다.
// =============================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface WireCall {
  path: string;
  authorization: string | null;
  body: string | null;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let answerOutstandingRotation: (() => void) | null = null;

afterEach(async () => {
  answerOutstandingRotation?.();
  answerOutstandingRotation = null;
  // One macrotask: the rotation settles and its `finally` clears the flight.
  await new Promise((settle) => setTimeout(settle, 0));
});

/**
 * A store that behaves like the real hosts' (`applyRotation` drops a pair that
 * lands after the wipe) and a server whose refresh answer the test releases.
 */
function rotatingHarness(start: { access: string | null; refresh: string }) {
  let access = start.access;
  let refresh: string | null = start.refresh;
  let stored: unknown = { ...(persisted as object), refreshToken: start.refresh };
  const events: string[] = [];
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () => stored as never,
    applyLogin: () => {},
    applyRotation: (nextAccess, nextRefresh) => {
      if (stored === null) {
        events.push("rotation-dropped");
        return;
      }
      access = nextAccess;
      refresh = nextRefresh;
      events.push(`rotated:${nextAccess}`);
    },
    markAuthExpired: () => {},
    clearSession: () => {
      events.push("wipe");
      access = null;
      refresh = null;
      stored = null;
    },
  };
  installCoreHost({
    apiBase: () => "http://server.test",
    publicOrigin: () => "http://server.test",
    buildMode: () => "test",
    session: port,
  } as never);

  const rotationAnswer = deferred<() => Response>();
  // The single flight is module state: a test that fails before answering must
  // not leave the next test joining its rotation (the afterEach above answers it).
  answerOutstandingRotation = () =>
    rotationAnswer.resolve(() => jsonResponse({ error: { message: "test over" } }, 401));
  const calls: WireCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      events.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v1/auth/refresh") return (await rotationAnswer.promise)();
      return jsonResponse({ status: "ok" });
    })
  );
  return {
    events,
    calls,
    answerRotation: (answer: () => Response) => rotationAnswer.resolve(answer),
    revocation: () => calls.find((call) => call.path === "/v1/auth/logout"),
  };
}

const ROTATED = { accessToken: "access-2", refreshToken: "refresh-2" };

describe("logout — 진행 중인 회전에 합류한다 (#2677 리뷰 M1)", () => {
  it("회전이 도는 중에 로그아웃하면, 그 회전이 발급한 pair 로 훅과 서버 폐기를 보낸다", async () => {
    const wire = rotatingHarness({ access: "access-1", refresh: "refresh-1" });
    const hook = vi.fn(async (accessToken: string) => {
      wire.events.push(`hook:${accessToken}`);
    });

    const rotation = refreshSessionOutcome(); // 어딘가의 401 이 시작한 회전
    const leaving = logout({ beforeRevoke: hook });
    // 사람은 기다리지 않는다: 회전 결과를 보기 전에 로컬 세션은 이미 비었다.
    // (soft: 여기서 멈추지 않고 아래의 토큰 단정까지 모두 보고한다.)
    expect.soft(wire.events).toEqual(["POST /v1/auth/refresh", "wipe"]);

    wire.answerRotation(() => jsonResponse(ROTATED));
    await Promise.all([rotation, leaving]);

    expect(hook).toHaveBeenCalledTimes(1);
    expect.soft(hook).toHaveBeenCalledWith("access-2");
    expect.soft(wire.revocation()?.authorization).toBe("Bearer access-2");
    expect.soft(JSON.parse(wire.revocation()?.body ?? "null")).toEqual({
      refreshToken: "refresh-2",
    });
    // 지운 저장소는 회전 결과로 되살아나지 않는다.
    expect(wire.events).toEqual([
      "POST /v1/auth/refresh",
      "wipe",
      "rotation-dropped",
      "hook:access-2",
      "POST /v1/auth/logout",
    ]);
  });

  it("access 가 아직 없는(부팅 회전 중) 로그아웃도 회전이 발급한 세션을 서버에서 끝낸다", async () => {
    const wire = rotatingHarness({ access: null, refresh: "refresh-1" });

    const rotation = refreshSessionOutcome();
    const leaving = logout();
    wire.answerRotation(() => jsonResponse(ROTATED));
    await Promise.all([rotation, leaving]);

    expect(wire.revocation()?.authorization).toBe("Bearer access-2");
    expect(JSON.parse(wire.revocation()?.body ?? "null")).toEqual({
      refreshToken: "refresh-2",
    });
  });

  it.each([
    ["거절(401)", () => jsonResponse({ error: { message: "revoked" } }, 401)],
    [
      "망 실패",
      () => {
        throw new TypeError("Network request failed");
      },
    ],
  ])("회전이 %s로 끝나면 들고 있던 pair 로 폐기한다 — 예전과 같다", async (_label, answer) => {
    const wire = rotatingHarness({ access: "access-1", refresh: "refresh-1" });
    const hook = vi.fn(async () => {});

    const rotation = refreshSessionOutcome();
    const leaving = logout({ beforeRevoke: hook });
    wire.answerRotation(answer);
    await Promise.all([rotation, leaving]);

    expect(hook).toHaveBeenCalledWith("access-1");
    expect(wire.revocation()?.authorization).toBe("Bearer access-1");
    expect(JSON.parse(wire.revocation()?.body ?? "null")).toEqual({
      refreshToken: "refresh-1",
    });
  });
});

describe("logout — 훅을 기다린다 (#2677 리뷰 L4)", () => {
  it("훅이 풀리기 전에는 POST /v1/auth/logout 이 없다", async () => {
    const { seen } = harness();
    const gate = deferred<void>();
    const hook = vi.fn(() => gate.promise);

    const leaving = logout({ beforeRevoke: hook });
    // 매크로태스크 한 번: 그 사이 쌓인 마이크로태스크는 모두 돈다.
    await new Promise((settle) => setTimeout(settle, 0));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(seen.map((call) => call.path)).toEqual([]);

    gate.resolve();
    await leaving;
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/auth/logout",
    ]);
  });
});
