// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { login, logout } from "@momo/core/lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "@momo/core/runtime/host";

import { expressionHttpTransport } from "./transport";

// #5816 — 표현 그림을 나르는 요청도 401 뒤에는 그 요청을 시작한 세션으로만 다시 보낸다.

const WS = "00000000-0000-0000-0000-000000000001";
const dohyeon = { id: "00000000-0000-0000-0000-0000000000d1", workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" };
const seoyeon = { id: "00000000-0000-0000-0000-0000000000e1", workspaceId: WS, kind: "human", displayName: "이서연", handle: "seoyeon" };

afterEach(() => {
  resetCoreHost();
  vi.unstubAllGlobals();
});

describe("표현 그림 요청의 401", () => {
  it("다른 세션이 저장돼 있으면 그 자격으로 갱신하지도 다시 받지도 않는다", async () => {
    let access: string | null = "at-D0";
    let refresh: string | null = "rt-D0";
    let member: unknown = dohyeon;
    let expired = 0;
    const port: SessionPort = {
      getAccessToken: () => access,
      getRefreshToken: () => refresh,
      getPersistedSession: () => (refresh ? ({ refreshToken: refresh, realtimeWebSocketUrl: "wss://x.test/ws", member } as never) : null),
      applyLogin: (r) => {
        access = r.accessToken;
        refresh = r.refreshToken;
        member = r.member;
      },
      applyRotation: (a, r) => {
        access = a;
        refresh = r;
      },
      markAuthExpired: () => {
        expired += 1;
      },
      clearSession: () => {
        access = null;
        refresh = null;
        member = null;
      },
    };
    installCoreHost({ apiBase: () => "http://oort.test", absoluteApiBase: () => "http://oort.test", buildMode: () => "test", session: port });
    const sent: { path: string; authorization: string | null; body: string }[] = [];
    let answerImage = () => {};
    const imageAnswered = new Promise<void>((resolve) => {
      answerImage = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        sent.push({ path, authorization: new Headers(init?.headers).get("Authorization"), body: typeof init?.body === "string" ? init.body : "" });
        if (path === "/v1/auth/login") {
          return new Response(JSON.stringify({ accessToken: "at-S1", refreshToken: "rt-S1", realtimeWebSocketUrl: "wss://x.test/ws", member: seoyeon }), { status: 200 });
        }
        if (path.endsWith("/image")) {
          await imageAnswered;
          return new Response("{}", { status: 401 });
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      })
    );

    const image = expressionHttpTransport.image(`/v1/workspaces/${WS}/expressions/e1/image`).then(
      () => "fetched",
      () => "failed"
    );
    await vi.waitFor(() => expect(sent.some((s) => s.path.endsWith("/image"))).toBe(true));
    void logout();
    await login("seoyeon@example.test", "pw");
    answerImage();

    expect(await image).toBe("failed");
    expect(sent.filter((s) => /-S1/.test(s.authorization ?? "") || /-S1/.test(s.body)).map((s) => s.path)).toEqual([]);
    expect(sent.filter((s) => s.path.endsWith("/image"))).toHaveLength(1);
    expect(expired).toBe(0);
  });
});
