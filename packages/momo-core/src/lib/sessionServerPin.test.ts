import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "./http";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  activateDeviceLinkSession,
  authedResponse,
  claimOwnerPassword,
  joinWithInvite,
  login,
  logout,
  probeDeviceLinkAccess,
  redeemDeviceLink,
  refreshSessionOutcome,
  type LoginResponse,
} from "./api";

// #5816 — 두 불변식을 서버 주소가 바뀌는 순간에 걸쳐 잰다.
//   1. 인증 값(Authorization · refresh 값)이 실린 요청은 그 값을 내준 서버로만 간다.
//   2. 자격 증명이 실린 요청(로그인 · 가입 · 링크)의 답은 그 요청을 보낸 서버의 세션으로만 받아들인다.
// 서버 A의 값은 이름에 `-A`가 든다. 경우마다 요청이 나간 뒤(답을 붙잡아 둔 채) 저장된 서버를 바꾼다.

const A = "http://a.test";
const B = "http://b.test";
const C = "http://c.test";

const memberA = {
  id: "00000000-0000-0000-0000-00000000000a",
  workspaceId: "00000000-0000-0000-0000-000000000001",
  handle: "dohyeon",
  displayName: "김도현",
  kind: "human",
} as const;

const sessionOfA = {
  accessToken: "at-A0",
  refreshToken: "rt-A0",
  realtimeWebSocketUrl: "wss://a.test/ws",
  member: memberA,
};

interface Sent {
  origin: string;
  path: string;
  method: string;
  authorization: string | null;
  body: string;
}

type Reply = { status: number; body: unknown };

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function harness(signedIn = true) {
  let base = A;
  let access: string | null = signedIn ? "at-A0" : null;
  let refresh: string | null = signedIn ? "rt-A0" : null;
  let member: unknown = signedIn ? memberA : null;
  /** 저장소가 받아들인 세션과 그때의 서버. */
  const adopted: { server: string; refreshToken: string }[] = [];
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () =>
      refresh ? ({ refreshToken: refresh, realtimeWebSocketUrl: "wss://a.test/ws", member } as never) : null,
    applyLogin: (response) => {
      adopted.push({ server: base, refreshToken: response.refreshToken });
      access = response.accessToken;
      refresh = response.refreshToken;
      member = response.member;
    },
    applyRotation: (a, r) => {
      if (!refresh) return; // 지워진 저장소는 갱신된 짝을 받지 않는다(웹 저장소와 같다)
      access = a;
      refresh = r;
    },
    markAuthExpired: () => {},
    clearSession: () => {
      access = null;
      refresh = null;
      member = null;
    },
  };
  installCoreHost({ apiBase: () => base, absoluteApiBase: () => base, buildMode: () => "test", session: port });
  const sent: Sent[] = [];
  const handlers: { origin: string | null; path: string; fn: (s: Sent) => Reply | Promise<Reply> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const one: Sent = {
        origin: url.origin,
        path: url.pathname,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? String(init.body) : "",
      };
      sent.push(one);
      const at = handlers.findIndex((h) => (h.origin === null || h.origin === one.origin) && h.path === one.path);
      const fn = at >= 0 ? handlers.splice(at, 1)[0].fn : () => ({ status: 200, body: { status: "ok" } });
      const reply = await fn(one);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return {
    port,
    sent,
    adopted,
    setServer: (next: string) => {
      base = next;
    },
    stored: () => ({ access, refresh }),
    setStore: (a: string | null, r: string | null, m: unknown) => {
      access = a;
      refresh = r;
      member = m;
    },
    /** 다음에 맞는 요청 하나에 이 답을(한 번만). */
    once: (origin: string | null, path: string, fn: (s: Sent) => Reply | Promise<Reply>) => {
      handlers.push({ origin, path, fn });
    },
  };
}

/** A가 내준 값이 A 밖으로 실려 간 요청. */
function leaksOfA(sent: Sent[]): string[] {
  return sent
    .filter((s) => s.origin !== A && (/-A\d/.test(s.authorization ?? "") || /-A\d/.test(s.body)))
    .map((s) => `${s.origin}${s.path}`);
}

const logoutsAt = (sent: Sent[], origin: string) =>
  sent.filter((s) => s.origin === origin && s.path === "/v1/auth/logout");

/** 요청이 실제로 나갔을 때 풀린다. */
function sentTo(h: { sent: Sent[] }, path: string): Promise<void> {
  return vi.waitFor(() => expect(h.sent.some((s) => s.path === path)).toBe(true));
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetCoreHost();
  vi.unstubAllGlobals();
});

describe("인증 값이 실린 요청은 그 값을 내준 서버로만 간다", () => {
  it("로그아웃의 beforeRevoke와 폐기는 시작한 서버로 간다", async () => {
    const h = harness();
    const done = logout({
      // 폰의 푸시 등록 폐기와 같은 모양: 건네받은 서버로 보낸다.
      beforeRevoke: async (accessToken, server) => {
        await tick();
        await fetch(`${server}/v1/workspaces/w/devices/d`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      },
    });
    h.setServer(B);
    await done;
    expect(h.sent.map((s) => `${s.method} ${s.origin}${s.path}`)).toEqual([
      `DELETE ${A}/v1/workspaces/w/devices/d`,
      `POST ${A}/v1/auth/logout`,
    ]);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("합류한 로그아웃의 beforeRevoke는 시작한 서버를 받는다", async () => {
    const h = harness();
    const refreshAnswer = gate();
    h.once(null, "/v1/auth/refresh", async () => {
      await refreshAnswer.opened;
      return { status: 200, body: { accessToken: "at-A1", refreshToken: "rt-A1" } };
    });
    const rotating = refreshSessionOutcome();
    await sentTo(h, "/v1/auth/refresh");
    const handed: string[] = [];
    const done = logout({
      beforeRevoke: async (accessToken, server) => {
        handed.push(`${server} ${accessToken}`);
      },
    });
    h.setServer(B);
    refreshAnswer.open();
    await done;
    await rotating;
    expect(handed).toEqual([`${A} at-A1`]);
    expect(logoutsAt(h.sent, A)).toHaveLength(1);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("코어가 직접 폐기할 때도 시작한 서버로 간다(두 번 바뀌어도)", async () => {
    const h = harness();
    h.port.revokeThroughHost = async () => {
      await tick();
      h.setServer(C);
      return false;
    };
    const done = logout();
    h.setServer(B);
    await done;
    expect(logoutsAt(h.sent, A)).toHaveLength(1);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("401 뒤 갱신과 그에 합류한 로그아웃은 시작한 서버로 가고, 원래 요청은 다시 보내지 않는다", async () => {
    const h = harness();
    const refreshAnswer = gate();
    h.once(A, "/v1/workspaces/w/channels", () => ({ status: 401, body: { error: { message: "expired" } } }));
    h.once(null, "/v1/auth/refresh", async () => {
      await refreshAnswer.opened;
      return { status: 200, body: { accessToken: "at-A1", refreshToken: "rt-A1" } };
    });
    const request = authedResponse("/v1/workspaces/w/channels").then(
      (res) => `status ${res.status}`,
      (error: unknown) => (error instanceof NetworkError ? "unreachable" : "other")
    );
    await sentTo(h, "/v1/auth/refresh");
    const done = logout();
    h.setServer(B);
    refreshAnswer.open();
    await done;
    expect(await request).toBe("unreachable");
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([
      `${A}/v1/workspaces/w/channels`,
      `${A}/v1/auth/refresh`,
      `${A}/v1/auth/logout`,
    ]);
    expect(logoutsAt(h.sent, A)[0].authorization).toBe("Bearer at-A1");
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("합류한 갱신이 짝을 받지 못해도 로그아웃은 시작한 서버로 간다", async () => {
    const h = harness();
    const refreshAnswer = gate();
    h.once(null, "/v1/auth/refresh", async () => {
      await refreshAnswer.opened;
      return { status: 503, body: { error: { message: "busy" } } };
    });
    const rotating = refreshSessionOutcome();
    await sentTo(h, "/v1/auth/refresh");
    const done = logout(); // 진행 중인 갱신에 합류한다
    h.setServer(B);
    refreshAnswer.open();
    await done;
    await expect(rotating).resolves.toBe("unreachable");
    const logouts = logoutsAt(h.sent, A);
    expect(logouts).toHaveLength(1);
    expect(logouts[0].authorization).toBe("Bearer at-A0");
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("갱신의 답이 닿기 전에 서버가 바뀌면 그 짝을 저장하지 않고 낸 서버에서 끝낸다", async () => {
    const h = harness();
    const refreshAnswer = gate();
    h.once(null, "/v1/auth/refresh", async () => {
      await refreshAnswer.opened;
      return { status: 200, body: { accessToken: "at-A1", refreshToken: "rt-A1" } };
    });
    const restoring = refreshSessionOutcome();
    await sentTo(h, "/v1/auth/refresh");
    h.setServer(B);
    refreshAnswer.open();
    await expect(restoring).resolves.toBe("rejected");
    expect(h.stored()).toEqual({ access: null, refresh: null });
    await vi.waitFor(() => expect(logoutsAt(h.sent, A)).toHaveLength(1));
    expect(logoutsAt(h.sent, A)[0].authorization).toBe("Bearer at-A1");
    // 그 뒤 앱이 보내는 요청에는 A의 값이 없다.
    await authedResponse("/v1/workspaces/w/channels").catch(() => {});
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("아무도 쥐지 않은 갱신의 짝은 갱신을 보낸 서버에서 폐기한다", async () => {
    const h = harness();
    const refreshAnswer = gate();
    h.once(null, "/v1/auth/refresh", async () => {
      await refreshAnswer.opened;
      return { status: 200, body: { accessToken: "at-A1", refreshToken: "rt-A1" } };
    });
    const rotating = refreshSessionOutcome();
    await sentTo(h, "/v1/auth/refresh");
    h.setStore("at-B0", "rt-B0", { ...memberA, id: "00000000-0000-0000-0000-00000000000b" });
    h.setServer(B);
    refreshAnswer.open();
    await expect(rotating).resolves.toBe("unreachable");
    await vi.waitFor(() => expect(logoutsAt(h.sent, A)).toHaveLength(1));
    expect(logoutsAt(h.sent, A)[0].authorization).toBe("Bearer at-A1");
    expect(h.stored()).toEqual({ access: "at-B0", refresh: "rt-B0" });
    expect(leaksOfA(h.sent)).toEqual([]);
  });
});

/** 서버 A가 내준 세션 답. */
const answerOfA = (extra: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ...sessionOfA, ...extra } });

describe("자격 증명이 실린 요청의 답은 그 요청을 보낸 서버의 세션으로만 받아들인다", () => {
  /**
   * 답이 오기 전에 서버를 바꾸고, 답은 서버 A의 세션이다. 받아들인 세션 0, A 밖으로 간 A의 값 0, A에서 그 짝의 폐기 1.
   * `moves`는 답을 풀기 전에 차례로 저장하는 서버들이다.
   */
  async function signInWhileServerMoves(
    path: string,
    signIn: () => Promise<unknown>,
    answer: Reply,
    moves: string[] = [B]
  ) {
    const h = harness(false);
    h.port.signRefreshProof = async () => null; // 폰처럼 증명하는 호스트: 받아들였다면 bind 갱신이 곧바로 나간다
    const answered = gate();
    h.once(A, path, async () => {
      await answered.opened;
      return answer;
    });
    const outcome = signIn().then(
      () => "adopted",
      (error: unknown) => (error instanceof NetworkError ? "refused" : `other: ${String(error)}`)
    );
    await sentTo(h, path);
    for (const next of moves) h.setServer(next);
    answered.open();
    const result = await outcome;
    await tick();
    await tick();
    return { h, result };
  }

  async function expectRefused(path: string, signIn: () => Promise<unknown>, answer: Reply = answerOfA()) {
    const { h, result } = await signInWhileServerMoves(path, signIn, answer);
    expect(result).toBe("refused");
    expect(h.adopted).toEqual([]);
    expect(h.stored()).toEqual({ access: null, refresh: null });
    expect(leaksOfA(h.sent)).toEqual([]);
    await vi.waitFor(() => expect(logoutsAt(h.sent, A)).toHaveLength(1));
    expect(logoutsAt(h.sent, A)[0].authorization).toBe("Bearer at-A0");
    expect(logoutsAt(h.sent, A)[0].body).toBe(JSON.stringify({ refreshToken: "rt-A0" }));
  }

  it("로그인 답", async () => {
    await expectRefused("/v1/auth/login", () => login("dohyeon@example.test", "pw"));
  });

  it("초대 가입 답", async () => {
    await expectRefused(
      "/v1/join",
      () => joinWithInvite("CODE-1", "dohyeon@example.test", "pw"),
      answerOfA({ createdMember: true })
    );
  });

  it("첫 주인·재설정 링크의 답", async () => {
    await expectRefused("/v1/claim", () => claimOwnerPassword("claim-token", "pw"));
  });

  it("기기 연결 링크의 답(곧바로 받아들이는 경우)", async () => {
    await expectRefused(
      "/v1/auth/device-link/redeem",
      () => redeemDeviceLink("voucher", { name: "도현 폰", platform: "ios" }),
      answerOfA({ pendingSas: false })
    );
  });

  it("기기 연결 링크의 답(확인 번호를 기다리는 경우)도 바뀐 서버 아래로 넘기지 않는다", async () => {
    await expectRefused(
      "/v1/auth/device-link/redeem",
      () => redeemDeviceLink("voucher", { name: "도현 폰", platform: "ios" }),
      answerOfA({ pendingSas: true, sas: "1234" })
    );
  });

  it("두 번 바뀌어도 받아들이지 않는다", async () => {
    const { h, result } = await signInWhileServerMoves(
      "/v1/auth/login",
      () => login("dohyeon@example.test", "pw"),
      answerOfA(),
      [B, C]
    );
    expect(result).toBe("refused");
    expect(h.adopted).toEqual([]);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("바뀌었다가 보낸 서버로 돌아왔으면 그 서버의 세션으로 받아들인다", async () => {
    const { h, result } = await signInWhileServerMoves(
      "/v1/auth/login",
      () => login("dohyeon@example.test", "pw"),
      answerOfA(),
      [B, A]
    );
    expect(result).toBe("adopted");
    expect(h.adopted).toEqual([{ server: A, refreshToken: "rt-A0" }]);
    expect(logoutsAt(h.sent, A)).toEqual([]);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("서버가 그대로면 예전처럼 받아들인다", async () => {
    const { h, result } = await signInWhileServerMoves(
      "/v1/auth/login",
      () => login("dohyeon@example.test", "pw"),
      answerOfA(),
      []
    );
    expect(result).toBe("adopted");
    expect(h.adopted).toEqual([{ server: A, refreshToken: "rt-A0" }]);
  });
});

describe("확인 번호를 기다리는 기기 연결 세션은 그 세션을 내준 서버에만 묻고, 그 서버 아래에서만 켠다", () => {
  const held: LoginResponse = { ...sessionOfA };

  it("기다리는 동안 서버가 바뀌어도 확인 요청은 내준 서버로 간다", async () => {
    const h = harness(false);
    h.setServer(B);
    await expect(probeDeviceLinkAccess(held.accessToken, memberA.workspaceId, A)).resolves.toBe("active");
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([
      `${A}/v1/workspaces/${memberA.workspaceId}/channels`,
    ]);
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("켜는 순간 서버가 바뀌어 있으면 받아들이지 않고 내준 서버에서 폐기한다", async () => {
    const h = harness(false);
    h.setServer(B);
    expect(() => activateDeviceLinkSession(held, A)).toThrow(NetworkError);
    expect(h.adopted).toEqual([]);
    await vi.waitFor(() => expect(logoutsAt(h.sent, A)).toHaveLength(1));
    expect(leaksOfA(h.sent)).toEqual([]);
  });

  it("내준 서버를 가리키는 동안이면 켠다", () => {
    const h = harness(false);
    activateDeviceLinkSession(held, A);
    expect(h.adopted).toEqual([{ server: A, refreshToken: "rt-A0" }]);
  });

  it("링크를 받은 서버를 결과에 적어 둔다", async () => {
    const h = harness(false);
    h.once(A, "/v1/auth/device-link/redeem", () => answerOfA({ pendingSas: true, sas: "1234" }));
    const result = await redeemDeviceLink("voucher", { name: "도현 폰", platform: "ios" });
    expect(result.server).toBe(A);
    expect(h.adopted).toEqual([]);
  });
});
