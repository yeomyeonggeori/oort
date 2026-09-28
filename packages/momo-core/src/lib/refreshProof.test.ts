import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installCoreHost,
  resetCoreHost,
  type HostRefreshAnswer,
  type RefreshDeviceProof,
  type RefreshProofRequest,
  type SessionPort,
} from "../runtime/host";
import {
  BIND_RETRY_MS,
  login,
  logout,
  refreshRetry,
  refreshSessionOutcome,
  serverSkewMs,
} from "./api";

// #3106 — 모든 refresh에 refresh 키 증명(`momo.human.refresh_proof.v1`, #3079).
// 폰은 코어가 POST하고 호스트가 서명하며, 데스크탑은 셸이 POST까지 한다. 재시도
// 정책은 한 곳(코어)이다: stale → 서버 시각으로 재서명, replayed → 재서명, 증명한
// refresh의 일반 401 → 한 번만 재시도, required/invalid → 로그아웃.

const member = {
  id: "00000000-0000-0000-0000-000000000002",
  workspaceId: "00000000-0000-0000-0000-000000000001",
  handle: "sj",
  displayName: "성재",
  kind: "human",
  role: "owner",
};
const persisted = {
  refreshToken: "rt-0",
  realtimeWebSocketUrl: "wss://server.test/ws",
  member,
} as never;

interface Sent {
  path: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

type Reply = { status: number; body: unknown; date?: string };

function harness(options: { signer?: boolean; host?: (skew: number) => HostRefreshAnswer | null } = {}) {
  let refresh: string | null = "rt-0";
  let access: string | null = "at-0";
  const events: string[] = [];
  const proofs: RefreshProofRequest[] = [];
  let nonce = 0;
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () => (refresh ? persisted : null),
    applyLogin: (response) => {
      access = response.accessToken;
      refresh = response.refreshToken;
      events.push("login");
    },
    applyRotation: (a, r) => {
      access = a;
      refresh = r;
      events.push(`rotated ${r}`);
    },
    markAuthExpired: () => events.push("expired"),
    clearSession: () => {
      access = null;
      refresh = null;
      events.push("wipe");
    },
  };
  if (options.signer) {
    port.signRefreshProof = async (request): Promise<RefreshDeviceProof> => {
      proofs.push(request);
      nonce += 1;
      return {
        publicKey: "AnE1+k/ZOgnc6Yu/aBtL/PUOfA1jVOYq+wv/KjQpYXhl",
        nonce: `00000000-0000-0000-0000-00000000000${nonce}`,
        signedAtMs: request.signedAtMs,
        signature: `sig-${nonce}`,
      };
    };
  }
  const hostCalls: number[] = [];
  if (options.host) {
    const host = options.host;
    port.refreshThroughHost = async (request) => {
      hostCalls.push(request.skewMs);
      expect(request.workspaceId).toBe(member.workspaceId);
      expect(request.memberId).toBe(member.id);
      return host(request.skewMs);
    };
  }
  installCoreHost({
    apiBase: () => "http://server.test",
    absoluteApiBase: () => "http://server.test",
    buildMode: () => "test",
    session: port,
  });

  const sent: Sent[] = [];
  const replies: Reply[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sent.push({
        path: url.pathname,
        body,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      const reply = replies.shift() ?? { status: 200, body: { status: "ok" } };
      if (reply.status === 0) throw new TypeError("network down");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (reply.date) headers.Date = reply.date;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
    })
  );
  return {
    events,
    proofs,
    sent,
    hostCalls,
    port,
    reply: (...next: Reply[]) => replies.push(...next),
    refresh: () => refresh,
  };
}

const pair = (n: number): Reply => ({
  status: 200,
  body: { accessToken: `at-${n}`, refreshToken: `rt-${n}` },
});
const refused = (code?: string, date?: string): Reply => ({
  status: 401,
  body: { error: code ? { message: "no", code } : { message: "no" } },
  date,
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetCoreHost();
});

describe("refreshRetry — the one policy both hosts use", () => {
  it("re-signs stale and replayed, signs out on required/invalid, retries a plain 401 once", () => {
    expect(refreshRetry(401, "refresh_proof_stale", true, false)).toBe("re-sign-with-server-time");
    expect(refreshRetry(401, "refresh_proof_replayed", true, false)).toBe("re-sign");
    expect(refreshRetry(401, "refresh_proof_required", false, false)).toBe("sign-out");
    expect(refreshRetry(401, "refresh_proof_invalid", true, false)).toBe("sign-out");
    expect(refreshRetry(401, undefined, true, false)).toBe("re-sign");
    expect(refreshRetry(401, undefined, true, true)).toBe("sign-out");
    // No proof, no retry: a browser's refresh is exactly what it was.
    expect(refreshRetry(401, undefined, false, false)).toBe("sign-out");
    expect(refreshRetry(403, undefined, true, false)).toBe("sign-out");
  });

  it("reads the server's clock from Date", () => {
    expect(serverSkewMs("Mon, 28 Sep 2026 00:10:00 GMT", Date.parse("2026-09-28T00:00:00Z"))).toBe(
      600_000
    );
    expect(serverSkewMs("not a date", 0)).toBeNull();
    expect(serverSkewMs(null, 0)).toBeNull();
  });
});

describe("phone: the core POSTs, the host signs", () => {
  it("every refresh carries the proof for the presented token", async () => {
    const h = harness({ signer: true });
    h.reply(pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.proofs).toEqual([
      {
        refreshToken: "rt-0",
        workspaceId: member.workspaceId,
        memberId: member.id,
        signedAtMs: expect.any(Number),
      },
    ]);
    expect(h.sent[0].body).toEqual({
      refreshToken: "rt-0",
      deviceProof: {
        publicKey: "AnE1+k/ZOgnc6Yu/aBtL/PUOfA1jVOYq+wv/KjQpYXhl",
        nonce: "00000000-0000-0000-0000-000000000001",
        signedAtMs: h.proofs[0].signedAtMs,
        signature: "sig-1",
      },
    });
  });

  // Sabotage: map `refresh_proof_stale` to "sign-out" — the person is signed
  // out over a clock, this goes RED.
  it("stale is not a sign-out: re-signs on the server's clock", async () => {
    const h = harness({ signer: true });
    const server = Date.now() + 10 * 60 * 1000;
    h.reply(refused("refresh_proof_stale", new Date(server).toUTCString()), pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.events).not.toContain("expired");
    expect(h.sent).toHaveLength(2);
    const corrected = h.proofs[1].signedAtMs;
    expect(Math.abs(corrected - server)).toBeLessThan(2_000);
    // Sabotage: reuse the first proof on the retry — the retry must carry a
    // fresh one (new nonce, new time).
    expect(h.sent[1].body.deviceProof).not.toEqual(h.sent[0].body.deviceProof);
  });

  it("replayed is not a sign-out: re-signs with a fresh nonce", async () => {
    const h = harness({ signer: true });
    h.reply(refused("refresh_proof_replayed"), pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    const nonces = h.sent.map((s) => (s.body.deviceProof as RefreshDeviceProof).nonce);
    expect(new Set(nonces).size).toBe(2);
    expect(h.events).toEqual(["rotated rt-1"]);
  });

  // MUST 2 (#3079): a proved refresh's plain 401 — two recoveries racing —
  // gets one retry with a new proof before any sign-out.
  it("a plain 401 on a proved refresh is retried once, then signs out", async () => {
    const h = harness({ signer: true });
    h.reply(refused(), pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].body.deviceProof).toBeDefined();

    const again = harness({ signer: true });
    again.reply(refused(), refused(), pair(9));
    await expect(refreshSessionOutcome()).resolves.toBe("rejected");
    expect(again.sent).toHaveLength(2);
    expect(again.events).toContain("expired");
  });

  // Review M1: out of attempts while the server still says "sign again" is
  // not a sign-out. Sabotage: return null (sign-out) after the loop — RED.
  it("stale to the last attempt keeps the session (unreachable), never signs out", async () => {
    const h = harness({ signer: true });
    h.reply(refused("refresh_proof_stale"), refused("refresh_proof_stale"), refused("refresh_proof_stale"));
    await expect(refreshSessionOutcome()).resolves.toBe("unreachable");
    expect(h.sent).toHaveLength(3);
    expect(h.events).toEqual([]);
    expect(h.refresh()).toBe("rt-0");
  });

  it("an unknown 401 code on a proved refresh gets the one retry, not two", async () => {
    const h = harness({ signer: true });
    h.reply(refused("something_new"), refused("something_new"), pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rejected");
    expect(h.sent).toHaveLength(2);
  });

  it("required and invalid sign out at once, as before", async () => {
    for (const code of ["refresh_proof_required", "refresh_proof_invalid"]) {
      const h = harness({ signer: true });
      h.reply(refused(code), pair(1));
      await expect(refreshSessionOutcome()).resolves.toBe("rejected");
      expect(h.sent).toHaveLength(1);
      expect(h.events).toEqual(["expired"]);
    }
  });

  it("a lost answer keeps the presented token for the next, proved, attempt", async () => {
    const h = harness({ signer: true });
    h.reply({ status: 0, body: null });
    await expect(refreshSessionOutcome()).resolves.toBe("unreachable");
    expect(h.refresh()).toBe("rt-0");
    expect(h.events).toEqual([]);
    h.reply(pair(3));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent[1].body).toMatchObject({ refreshToken: "rt-0", deviceProof: expect.any(Object) });
  });

  it("a signer that fails still refreshes, without a proof", async () => {
    const h = harness({ signer: true });
    h.port.signRefreshProof = async () => {
      throw new Error("enclave");
    };
    h.reply(pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent[0].body).toEqual({ refreshToken: "rt-0" });
  });
});

describe("a browser: unchanged", () => {
  it("no proof, no retry, no bind refresh after sign-in", async () => {
    const h = harness();
    h.reply(refused());
    await expect(refreshSessionOutcome()).resolves.toBe("rejected");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toEqual({ refreshToken: "rt-0" });

    const signIn = harness();
    signIn.reply({
      status: 200,
      body: {
        accessToken: "at-L",
        refreshToken: "rt-L",
        member,
        realtimeWebSocketUrl: "wss://server.test/ws",
      },
    });
    await login("a@b.test", "pw");
    await Promise.resolve();
    expect(signIn.sent.map((s) => s.path)).toEqual(["/v1/auth/login"]);
  });
});

describe("the bind refresh (MUST 1): right after sign-in", () => {
  const loginReply: Reply = {
    status: 200,
    body: {
      accessToken: "at-L",
      refreshToken: "rt-L",
      member,
      realtimeWebSocketUrl: "wss://server.test/ws",
    },
  };

  // Sabotage: drop `bindRefreshKey` from `adoptSignIn` — no refresh follows
  // the sign-in, the server never binds the key, RED.
  it("a host with a refresh key refreshes once, with a proof, at once", async () => {
    const h = harness({ signer: true });
    h.reply(loginReply, pair(1));
    await login("a@b.test", "pw");
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent[1].path).toBe("/v1/auth/refresh");
    expect(h.sent[1].body).toMatchObject({ refreshToken: "rt-L", deviceProof: expect.any(Object) });
    await vi.waitFor(() => expect(h.refresh()).toBe("rt-1"));
  });

  it("a bind nothing answered is retried while the first token is still stored", async () => {
    vi.useFakeTimers();
    const h = harness({ signer: true });
    h.reply(loginReply, { status: 0, body: null }, pair(1));
    await login("a@b.test", "pw");
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS);
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    expect(h.sent[2].body).toMatchObject({ refreshToken: "rt-L", deviceProof: expect.any(Object) });
    await vi.waitFor(() => expect(h.refresh()).toBe("rt-1"));
  });
});

describe("desktop: the shell carries the refresh", () => {
  it("rotates to the shell's handle and never POSTs the token itself", async () => {
    const h = harness({
      host: () => ({ status: 200, accessToken: "at-1", refreshToken: "shell:abc", proved: true }),
    });
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual(["rotated shell:abc"]);
  });

  it("the same policy: stale re-signs with the server's clock through the shell", async () => {
    const date = new Date(Date.now() + 600_000).toUTCString();
    const answers: HostRefreshAnswer[] = [
      { status: 401, code: "refresh_proof_stale", date, proved: true },
      { status: 200, accessToken: "at-1", refreshToken: "shell:abc", proved: true },
    ];
    const h = harness({ host: () => answers.shift() ?? null });
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.hostCalls[0]).toBe(0);
    expect(Math.abs(h.hostCalls[1] - 600_000)).toBeLessThan(2_000);
  });

  // Review M3: the bind refresh tells the host it is one, so a host that
  // cannot prove right now defers (rejects) instead of letting the core spend
  // the first token without a proof.
  it("the bind refresh is marked, and a host that defers it keeps the first token", async () => {
    vi.useFakeTimers();
    const seen: Array<boolean | undefined> = [];
    const h = harness({ host: () => null });
    h.port.refreshThroughHost = async (request) => {
      seen.push(request.bind);
      if (seen.length === 1) throw new Error("keychain not confirmed yet");
      return { status: 200, accessToken: "at-1", refreshToken: "shell:abc", proved: true };
    };
    h.reply({
      status: 200,
      body: {
        accessToken: "at-L",
        refreshToken: "rt-L",
        member,
        realtimeWebSocketUrl: "wss://server.test/ws",
      },
    });
    await login("a@b.test", "pw");
    await vi.waitFor(() => expect(seen).toEqual([true]));
    expect(h.sent.map((s) => s.path)).toEqual(["/v1/auth/login"]);
    expect(h.refresh()).toBe("rt-L");
    await vi.advanceTimersByTimeAsync(BIND_RETRY_MS);
    await vi.waitFor(() => expect(h.refresh()).toBe("shell:abc"));
    expect(seen).toEqual([true, true]);
    // An ordinary rotation is not a bind.
    await refreshSessionOutcome();
    expect(seen[2]).toBeUndefined();
  });

  it("a shell that cannot carry it now falls back to the core's own POST", async () => {
    const h = harness({ host: () => null });
    h.reply(pair(1));
    await expect(refreshSessionOutcome()).resolves.toBe("rotated");
    expect(h.sent[0].body).toEqual({ refreshToken: "rt-0" });
  });

  it("logout revokes through the shell, which holds the token", async () => {
    const h = harness({
      host: () => ({ status: 200, accessToken: "at-1", refreshToken: "shell:abc", proved: true }),
    });
    const revokes: unknown[] = [];
    h.port.revokeThroughHost = async (request) => {
      revokes.push(request);
      return true;
    };
    await logout();
    expect(revokes).toEqual([
      {
        accessToken: "at-0",
        refreshToken: "rt-0",
        workspaceId: member.workspaceId,
        memberId: member.id,
      },
    ]);
    expect(h.sent).toEqual([]);
  });
});

describe("logout on the phone", () => {
  // The access token expired: the leftover refresh half is rotated WITH a
  // proof (under `require` an unproven one would be refused and the lineage
  // would live on for 30 days) and the minted pair revoked.
  it("rotates an expired session with a proof before revoking it", async () => {
    const h = harness({ signer: true });
    h.reply(refused(), pair(5), { status: 200, body: { status: "ok" } });
    await logout();
    expect(h.sent.map((s) => s.path)).toEqual([
      "/v1/auth/logout",
      "/v1/auth/refresh",
      "/v1/auth/logout",
    ]);
    expect(h.sent[1].body).toMatchObject({ refreshToken: "rt-0", deviceProof: expect.any(Object) });
    expect(h.sent[2].body).toEqual({ refreshToken: "rt-5" });
    expect(h.sent[2].authorization).toBe("Bearer at-5");
  });
});
