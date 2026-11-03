import { afterEach, describe, expect, it, vi } from "vitest";

import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import { probeAttachmentContent } from "./api";
import { NetworkError } from "./http";

// =============================================================================
// 영상을 열기 전의 인가 확인 `HEAD …/content` (#5208).
//
// 네이티브 플레이어는 `Authorization` 머리를 에셋을 만들 때 **고정**한다. 만료된 토큰으로 만든 소스는 첫 구간 읽기부터 401 이라,
// 소스를 만들기 직전에 토큰이 살아 있는지 확인해야 한다. 세션 규칙(단 한 번의 회전, 거절이면 만료 선언 한 번, 닿지 못함은 만료가
// 아니다)은 코어 `authedResponse` 의 것이다 — 이 시험은 그 규칙이 **이 확인에도** 서 있는지를 재고, 요청이 정말 본문 없는 `HEAD`
// 이며 베어러를 싣는지를 잰다. 세션 목은 상태를 가지고 선언 횟수를 센다(`expired > 0` 만 보면 한쪽이 지워져도 초록이다).
// =============================================================================

const WS = "019f9b10-0000-7000-8000-000000000001";
const CH = "019f9b10-0000-7000-8000-0000000000c1";
const ATT = "019f9b10-0000-7000-8000-0000000000a1";
const PATH = `/v1/workspaces/${WS}/channels/${CH}/attachments/${ATT}/content`;

interface Sent {
  path: string;
  method: string;
  bearer: string | null;
}

/** `body` 가 없으면 본문 없는 응답이다 — `HEAD` 의 답이 그렇다. */
const reply = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stage(script: Array<Response | "down">, options: { refresh?: string | null } = {}) {
  const session = {
    access: "access-old",
    refresh: options.refresh === undefined ? "refresh-1" : options.refresh,
    expired: 0,
  };
  const port: SessionPort = {
    getAccessToken: () => session.access,
    getRefreshToken: () => session.refresh,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: (access, refresh) => {
      session.access = access;
      session.refresh = refresh;
    },
    markAuthExpired: () => {
      session.expired += 1;
    },
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: port,
  });
  const sent: Sent[] = [];
  const queue = [...script];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: String(url).replace("https://oort.test", ""),
        method: init?.method ?? "GET",
        bearer: new Headers(init?.headers).get("Authorization"),
      });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${String(url)}`);
      if (next === "down") throw new TypeError("network down");
      return next;
    })
  );
  return { session, sent };
}

afterEach(() => {
  resetCoreHost();
  vi.unstubAllGlobals();
});

describe("probeAttachmentContent", () => {
  it("본문 없는 HEAD 로 content 길에 묻고, 베어러를 싣고, 상태 숫자만 돌려준다", async () => {
    const { sent, session } = stage([reply(200)]);
    expect(await probeAttachmentContent(WS, CH, ATT)).toBe(200);
    expect(sent).toEqual([{ path: PATH, method: "HEAD", bearer: "Bearer access-old" }]);
    expect(session.expired).toBe(0);
    // 상태를 해석하지 않는다 — 읽을 수 없는 파일은 던지지 않고 그 숫자를 돌려준다.
    stage([reply(404, { error: { message: "completed attachment not found" } })]);
    expect(await probeAttachmentContent(WS, CH, ATT)).toBe(404);
  });

  it("401 이면 단 한 번 회전하고 새 토큰으로 다시 묻는다 — 소스는 살아 있는 토큰으로 만들어진다", async () => {
    const { sent, session } = stage([
      reply(401, { error: { message: "unauthorized" } }),
      reply(200, { accessToken: "access-new", refreshToken: "refresh-2" }),
      reply(200),
    ]);
    expect(await probeAttachmentContent(WS, CH, ATT)).toBe(200);
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      `HEAD ${PATH}`,
      "POST /v1/auth/refresh",
      `HEAD ${PATH}`,
    ]);
    expect(sent[0]?.bearer).toBe("Bearer access-old");
    expect(sent[2]?.bearer).toBe("Bearer access-new");
    expect(session.expired).toBe(0);
  });

  it("갱신 토큰이 없으면 회전하지 않고, 401 이 남으면 만료를 정확히 한 번 선언한다", async () => {
    const { sent, session } = stage([reply(401, { error: { message: "unauthorized" } })], { refresh: null });
    expect(await probeAttachmentContent(WS, CH, ATT)).toBe(401);
    expect(sent).toHaveLength(1); // 회전 요청이 나가지 않았다
    expect(session.expired).toBe(1);
  });

  it("서버에 닿지 못하면 NetworkError 로 던지고 만료로 읽지 않는다", async () => {
    const { session } = stage(["down"]);
    const failure = await probeAttachmentContent(WS, CH, ATT).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(NetworkError);
    expect(session.expired).toBe(0);
  });
});
