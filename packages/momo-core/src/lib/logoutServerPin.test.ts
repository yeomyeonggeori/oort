import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installCoreHost,
  resetCoreHost,
  type HostRevokeRequest,
  type RefreshDeviceProof,
  type SessionPort,
} from "../runtime/host";
import { logout, pendingLogout, refreshSessionOutcome } from "./api";

// #5785 — 로그아웃·갱신 요청은 「그 요청을 시작한 때의 서버」로만 간다.
//
// 이 기기가 붙을 서버는 저장된 선택이고, 로그인 화면이 그 선택을 바꿀 수 있다. 그래서 자격(접근 토큰·refresh 값)을
// 읽은 뒤 무엇이든 기다렸다가 보내는 요청은, 자격과 같은 순간에 읽은 서버로 가야 한다. 아래 경우마다 보내기 전에
// 기다림이 하나씩 있다(기다림이 없으면 고치기 전 코드도 통과해서 이 시험이 아무것도 못 막는다).

const START = "http://start.test";
const NEXT = "http://next.test";

const member = {
  id: "00000000-0000-0000-0000-000000000002",
  workspaceId: "00000000-0000-0000-0000-000000000001",
  handle: "dohyeon",
  displayName: "김도현",
  kind: "human",
  role: "owner",
};

interface Sent {
  origin: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

type Reply = { status: number; body: unknown };

function harness() {
  let base = START;
  let access: string | null = "at-0";
  let refresh: string | null = "rt-0";
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () =>
      refresh ? ({ refreshToken: refresh, realtimeWebSocketUrl: "wss://start.test/ws", member } as never) : null,
    applyLogin: () => {},
    applyRotation: (a, r) => {
      access = a;
      refresh = r;
    },
    markAuthExpired: () => {},
    clearSession: () => {
      access = null;
      refresh = null;
    },
  };
  installCoreHost({
    apiBase: () => base,
    absoluteApiBase: () => base,
    buildMode: () => "test",
    session: port,
  });
  const sent: Sent[] = [];
  const replies: Reply[] = [];
  let onSend: ((sent: Sent) => void) | null = null;
  let hold: Promise<void> | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const one: Sent = {
        origin: url.origin,
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      sent.push(one);
      onSend?.(one);
      if (hold) await hold;
      const reply = replies.shift() ?? { status: 200, body: { status: "ok" } };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return {
    port,
    sent,
    /** 저장된 서버를 바꾼다(로그인 화면이 하는 일). */
    switchServer: () => {
      base = NEXT;
    },
    reply: (...next: Reply[]) => replies.push(...next),
    whenSent: (fn: (sent: Sent) => void) => {
      onSend = fn;
    },
    holdReplies: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetCoreHost();
  vi.unstubAllGlobals();
});

describe("logout은 시작할 때의 서버로만 보낸다", () => {
  it("호스트가 폐기를 맡지 않고(false) 돌아온 뒤에도 폐기 요청은 시작한 서버로 간다", async () => {
    const h = harness();
    h.port.revokeThroughHost = async () => false;
    const done = logout();
    h.switchServer(); // 같은 틱에 로그인 화면이 다른 서버를 저장한다
    await done;
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([`${START}/v1/auth/logout`]);
    expect(h.sent[0].authorization).toBe("Bearer at-0");
    expect(h.sent[0].body).toEqual({ refreshToken: "rt-0" });
  });

  it("beforeRevoke를 기다린 뒤에도 시작한 서버로 간다", async () => {
    const h = harness();
    const done = logout({ beforeRevoke: async () => {} });
    h.switchServer();
    await done;
    expect(h.sent.map((s) => s.origin)).toEqual([START]);
    expect(h.sent[0].authorization).toBe("Bearer at-0");
  });

  it("호스트 폐기에도 시작한 서버를 건넨다", async () => {
    const h = harness();
    const seen: HostRevokeRequest[] = [];
    h.port.revokeThroughHost = async (request) => {
      seen.push(request);
      return true;
    };
    const done = logout({ beforeRevoke: async () => {} });
    h.switchServer();
    await done;
    expect(seen.map((r) => r.apiBase)).toEqual([START]);
    expect(h.sent).toEqual([]);
  });

  it("접근 토큰이 만료돼 401이면, 그 뒤 갱신과 두 번째 폐기도 시작한 서버로 간다", async () => {
    const h = harness();
    h.reply(
      { status: 401, body: { error: { message: "expired" } } },
      { status: 200, body: { accessToken: "at-1", refreshToken: "rt-1" } },
      { status: 200, body: { status: "ok" } }
    );
    // 첫 폐기의 401이 오는 사이에 서버가 바뀐다.
    h.whenSent((one) => {
      if (one.path === "/v1/auth/logout") h.switchServer();
    });
    await logout();
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([
      `${START}/v1/auth/logout`,
      `${START}/v1/auth/refresh`,
      `${START}/v1/auth/logout`,
    ]);
    expect(h.sent[1].body).toEqual({ refreshToken: "rt-0" });
    expect(h.sent[2].authorization).toBe("Bearer at-1");
  });

  it("진행 중인 갱신에 합류하면, 그 갱신이 받은 짝은 갱신을 보낸 서버에서 폐기한다", async () => {
    const h = harness();
    let sign = () => {};
    const signed = new Promise<void>((resolve) => {
      sign = resolve;
    });
    h.port.signRefreshProof = async (request): Promise<RefreshDeviceProof> => {
      await signed;
      return {
        publicKey: "AnE1+k/ZOgnc6Yu/aBtL/PUOfA1jVOYq+wv/KjQpYXhl",
        nonce: "00000000-0000-0000-0000-000000000001",
        signedAtMs: request.signedAtMs,
        signature: "sig-1",
      };
    };
    h.reply(
      { status: 200, body: { accessToken: "at-1", refreshToken: "rt-1" } },
      { status: 200, body: { status: "ok" } }
    );
    const rotating = refreshSessionOutcome(); // 시작한 서버에서 갱신이 서명을 기다린다
    await Promise.resolve();
    h.switchServer();
    const done = logout(); // 그 갱신에 합류한다
    sign();
    await done;
    await rotating;
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([
      `${START}/v1/auth/refresh`,
      `${START}/v1/auth/logout`,
    ]);
    expect(h.sent[1].authorization).toBe("Bearer at-1");
  });

  it("끝나기 전에는 pendingLogout()이 서고, 끝나면 null이다", async () => {
    const h = harness();
    const release = h.holdReplies();
    const done = logout();
    const pending = pendingLogout();
    expect(pending).not.toBeNull();
    let settled = false;
    void pending?.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(settled).toBe(false);
    release();
    await done;
    await pending;
    expect(settled).toBe(true);
    expect(pendingLogout()).toBeNull();
  });
});

describe("갱신은 토큰을 읽은 때의 서버로만 보낸다", () => {
  it("증명 서명을 기다리는 사이 서버가 바뀌어도 refresh 요청은 원래 서버로 간다", async () => {
    const h = harness();
    h.port.signRefreshProof = async (request): Promise<RefreshDeviceProof> => {
      h.switchServer();
      return {
        publicKey: "AnE1+k/ZOgnc6Yu/aBtL/PUOfA1jVOYq+wv/KjQpYXhl",
        nonce: "00000000-0000-0000-0000-000000000001",
        signedAtMs: request.signedAtMs,
        signature: "sig-1",
      };
    };
    h.reply({ status: 200, body: { accessToken: "at-1", refreshToken: "rt-1" } });
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent.map((s) => `${s.origin}${s.path}`)).toEqual([`${START}/v1/auth/refresh`]);
  });

  it("셸이 나르는 갱신이 다시 서명해 두 번째로 갈 때도 토큰을 읽은 때의 서버를 건넨다", async () => {
    const h = harness();
    const bases: string[] = [];
    h.port.refreshThroughHost = async (request) => {
      bases.push(request.apiBase);
      if (bases.length === 1) {
        // 첫 시도의 답이 오는 사이에 서버가 바뀐다.
        h.switchServer();
        return { status: 401, code: "refresh_proof_replayed", proved: true };
      }
      return { status: 200, accessToken: "at-1", refreshToken: "shell:abc", proved: true };
    };
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(bases).toEqual([START, START]);
  });
});
