import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPort } from "@momo/core/runtime/host";

// #5816 — 저장된 세션은 그것을 낸 서버의 것이다. 세션이 저장된 채 서버 주소가 바뀌면, 그 세션을 먼저 낸 서버에서 끝내고
// 바꾼다: 그 세션의 값은 다음 서버로 한 번도 가지 않는다.

const OLD = "https://old.oort.test";
const NEXT = "https://next.oort.test";

interface Sent {
  origin: string;
  path: string;
  authorization: string | null;
  body: string;
}

let sent: Sent[];
let store: Map<string, string>;

async function setup(signedIn: boolean) {
  store = new Map([["momo.web.server.v1", OLD]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.resetModules();
  const serverBase = await import("./serverBase");
  let access: string | null = signedIn ? "at-old" : null;
  let refresh: string | null = signedIn ? "rt-old" : null;
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {
      access = null;
      refresh = null;
    },
  };
  const host = await import("@momo/core/runtime/host");
  host.installCoreHost({ apiBase: serverBase.apiBase, absoluteApiBase: serverBase.apiBase, buildMode: () => "test", session: port });
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      sent.push({
        origin: url.origin,
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    })
  );
  return { serverBase, stored: () => ({ access, refresh }), resetHost: host.resetCoreHost };
}

let reset: (() => void) | null = null;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  reset?.();
  reset = null;
  vi.unstubAllGlobals();
});

describe("세션이 저장된 채 서버 주소를 바꾸면", () => {
  it("그 세션을 낸 서버에서 먼저 끝내고, 다음 서버로는 아무 값도 보내지 않는다", async () => {
    const t = await setup(true);
    reset = t.resetHost;
    t.serverBase.setServerBase(NEXT);
    expect(t.stored()).toEqual({ access: null, refresh: null });
    expect(t.serverBase.apiBase()).toBe(NEXT);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      origin: OLD,
      path: "/v1/auth/logout",
      authorization: "Bearer at-old",
      body: JSON.stringify({ refreshToken: "rt-old" }),
    });
    expect(sent.filter((s) => s.origin === NEXT)).toEqual([]);
  });

  it("같은 주소를 다시 고르면 아무것도 하지 않는다", async () => {
    const t = await setup(true);
    reset = t.resetHost;
    t.serverBase.setServerBase(OLD);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(t.stored()).toEqual({ access: "at-old", refresh: "rt-old" });
  });

  it("세션이 없으면 주소만 바뀐다", async () => {
    const t = await setup(false);
    reset = t.resetHost;
    t.serverBase.setServerBase(NEXT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    expect(t.serverBase.apiBase()).toBe(NEXT);
  });
});
