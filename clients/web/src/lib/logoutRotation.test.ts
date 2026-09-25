import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";

// =============================================================================
// #2677 리뷰 M1 — 웹·데스크톱에서 본 같은 수리.
//
// `@momo/core` 의 `logout()` 이 진행 중인 refresh 회전에 합류하도록 바뀌었다. 웹과
// 데스크톱(Tauri, 같은 번들)은 인자 없이 `logout()` 을 부르고 푸시 등록도 없으므로,
// 달라지는 것은 하나다: 회전이 도는 중에 로그아웃하면, 이미 쓰인 P1 대신 그 회전이
// 발급한 P2 로 서버 세션을 끝낸다. 예전에는 P2 가 서버에서 30일 살았다.
//
// 이 파일은 실제 웹 세션 저장소(`./session`)와 실제 호스트 배선(`./coreHost`)으로
// 그것을 잰다. 저장소는 로그아웃 뒤 비어 있어야 한다 — 늦게 온 회전 결과가
// 세션을 되살리거나(웹 저장소) 키체인에 새 refresh 토큰을 쓰면(데스크톱) 안 된다.
// =============================================================================

const mocks = vi.hoisted(() => ({
  desktop: false,
  keychain: {
    available: vi.fn(async () => true),
    load: vi.fn(async (): Promise<string | null> => null),
    store: vi.fn(async () => true),
    clear: vi.fn(async () => true),
  },
}));

vi.mock("./tauri", () => ({
  isDesktop: () => mocks.desktop,
  desktopKeychain: mocks.keychain,
}));

const WEB_KEY = "momo.web.session.v1";
const DESKTOP_KEY = "momo.desktop.session.v1";

const login: LoginResponse = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  realtimeWebSocketUrl: "wss://oort.example.com/connection/websocket",
  member: {
    id: "0199aaaa-0000-7000-8000-000000000001",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
};

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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface WireCall {
  path: string;
  authorization: string | null;
  body: string | null;
}

let storage: Map<string, string>;
let answerRotation: (() => void) | null = null;

/** Fresh modules against a fresh fake localStorage, wired like `main.tsx`. */
async function loadApp() {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  vi.resetModules();
  const session = await import("./session");
  const serverBase = await import("./serverBase");
  await import("./coreHost");
  const api = await import("@momo/core/lib/api");
  serverBase.setServerBase("https://oort.example.com");
  await session.initSessionStore();
  return { session, api };
}

/** A server that has already rotated when the refresh arrives; its answer is late. */
function stubServer() {
  const calls: WireCall[] = [];
  const rotation = deferred<void>();
  answerRotation = () => rotation.resolve();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.pathname === "/v1/auth/refresh") {
        await rotation.promise;
        return jsonResponse({ accessToken: "access-token-2", refreshToken: "refresh-token-2" });
      }
      return jsonResponse({ status: "ok", revokedAccess: true, revokedRefresh: true });
    })
  );
  return {
    calls,
    revocation: () => calls.find((call) => call.path === "/v1/auth/logout"),
  };
}

/** Lets the serialised keychain work queued by the store run to completion. */
const flush = () => new Promise((settle) => setTimeout(settle, 0));

beforeEach(() => {
  mocks.desktop = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  answerRotation?.();
  answerRotation = null;
  await flush();
  vi.unstubAllGlobals();
});

describe("웹 로그아웃 — 진행 중인 회전에 합류한다 (#2677 리뷰 M1)", () => {
  it("회전이 도는 중이면 그 회전이 발급한 pair 로 서버 세션을 끝내고, 저장소는 비어 있다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const server = stubServer();

    const rotation = api.refreshSessionOutcome();
    const leaving = api.logout(); // 웹은 인자 없이 부른다
    expect(session.getAccessToken()).toBeNull(); // 사람은 즉시 나간다
    answerRotation?.();
    await Promise.all([rotation, leaving]);

    expect({
      authorization: server.revocation()?.authorization,
      body: JSON.parse(server.revocation()?.body ?? "null"),
    }).toEqual({
      authorization: "Bearer access-token-2",
      body: { refreshToken: "refresh-token-2" },
    });
    expect(session.getAccessToken()).toBeNull();
    expect(session.getPersistedSession()).toBeNull();
    expect(storage.has(WEB_KEY)).toBe(false);
  });

  it("회전이 없으면 예전과 같다 — 들고 있던 pair 로 한 번", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const server = stubServer();

    await api.logout();

    expect(server.calls.map((call) => call.path)).toEqual(["/v1/auth/logout"]);
    expect(server.revocation()?.authorization).toBe("Bearer access-token-1");
    expect(JSON.parse(server.revocation()?.body ?? "null")).toEqual({
      refreshToken: "refresh-token-1",
    });
  });
});

describe("데스크톱(키체인) 로그아웃 — 같은 합류, 키체인에는 아무것도 새로 쓰지 않는다", () => {
  beforeEach(() => {
    mocks.desktop = true;
  });

  it("늦게 온 회전 결과는 키체인에 쓰이지 않고, 서버 폐기는 그 결과로 간다", async () => {
    const { session, api } = await loadApp();
    expect(session.getSessionStorageMode()).toBe("keychain");
    session.applyLogin(login);
    await flush();
    const server = stubServer();

    const rotation = api.refreshSessionOutcome();
    const leaving = api.logout();
    answerRotation?.();
    await Promise.all([rotation, leaving]);
    await flush();

    expect(server.revocation()?.authorization).toBe("Bearer access-token-2");
    expect(mocks.keychain.store).not.toHaveBeenCalledWith("refresh-token-2");
    expect(mocks.keychain.clear).toHaveBeenCalled();
    expect(storage.has(DESKTOP_KEY)).toBe(false);
    expect(session.hasPersistedSession()).toBe(false);
  });
});
