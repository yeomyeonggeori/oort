// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";

// =============================================================================
// #3067 — 탭·창 간 refresh 회전 조율의 단위 시험.
//
// 다중 탭의 **결과**(동시 회전 시 서버 재사용 0회, 로그아웃 전파)는 실제 브라우저
// 여러 페이지로 gates/gate-refresh-tabs.mjs 가 잰다. 여기서 재는 것은 그 게이트가
// 구분하지 못하는 부품들이다:
//   - 락 안의 **재읽기**. 브라우저에서는 storage 이벤트가 보통 먼저 도착해 메모리를
//     고쳐 두므로, 재읽기를 지워도 게이트는 초록이다. 이벤트가 늦거나 오지 않을 때
//     (백그라운드 탭, 이벤트 경합) 막아 주는 것은 재읽기 하나뿐이라 따로 잰다.
//   - 데스크톱(키체인) 분기. 토큰이 localStorage 에 없으므로 재읽기는 키체인에서
//     하고, 회전 소식은 표지 키로 전한다. 실제 Tauri 다중 창은 runtime-unverified.
//   - 락이 끝내 풀리지 않을 때. 세션은 지워지지 않고 `unreachable` 이어야 한다.
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
const ROTATED_KEY = "momo.desktop.session.rotated.v1";

const member = {
  id: "0199aaaa-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human" as const,
  displayName: "곽성재",
  handle: "seongjae",
};

const login: LoginResponse = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  realtimeWebSocketUrl: "wss://oort.example.com/connection/websocket",
  member,
};

function stored(refreshToken: string, who = member) {
  return JSON.stringify({
    refreshToken,
    realtimeWebSocketUrl: login.realtimeWebSocketUrl,
    member: who,
  });
}

/** What a sibling tab's write looks like to this tab. */
function fromOtherTab(key: string, newValue: string | null) {
  if (newValue === null) localStorage.removeItem(key);
  else localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

async function loadApp() {
  vi.resetModules();
  const session = await import("./session");
  const serverBase = await import("./serverBase");
  await import("./coreHost");
  const api = await import("@momo/core/lib/api");
  serverBase.setServerBase("https://oort.example.com");
  await session.initSessionStore();
  return { session, api };
}

/** Records every refresh token presented; answers with the next pair. */
function stubServer() {
  const presented: string[] = [];
  let serial = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/auth/refresh") {
        presented.push(JSON.parse(String(init?.body)).refreshToken);
        serial += 1;
        return new Response(
          JSON.stringify({ accessToken: `access-token-${serial}`, refreshToken: `refresh-token-${serial}` }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
  return presented;
}

const flush = () => new Promise((settle) => setTimeout(settle, 0));

// Every fresh module graph (loadApp) installs its own `storage` listener on the
// one jsdom window. Drop them after each test so an earlier test's store cannot
// answer a later test's event.
const installed: EventListenerOrEventListenerObject[] = [];
const realAdd = window.addEventListener.bind(window);

beforeEach(() => {
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === "storage") installed.push(listener);
    realAdd(type, listener, options);
  }) as typeof window.addEventListener);
  mocks.desktop = false;
  vi.clearAllMocks();
  mocks.keychain.load.mockImplementation(async () => null);
  localStorage.clear();
});

afterEach(() => {
  for (const listener of installed.splice(0)) window.removeEventListener("storage", listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("웹 — 락 안에서 저장소를 다시 읽는다", () => {
  it("다른 탭이 이미 회전했으면(이벤트가 아직 안 왔어도) 저장된 새 토큰을 낸다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const presented = stubServer();

    // 다른 탭의 회전 결과가 저장소에는 있고, 이 탭에는 이벤트가 아직 없다.
    localStorage.setItem(WEB_KEY, stored("refresh-token-from-tab-b"));
    expect(session.getRefreshToken()).toBe("refresh-token-1");

    expect(await api.refreshSessionOutcome()).toBe("rotated");
    expect(presented).toEqual(["refresh-token-from-tab-b"]);
    expect(JSON.parse(localStorage.getItem(WEB_KEY) ?? "null").refreshToken).toBe("refresh-token-2");
  });

  it("락을 기다리는 동안 다른 탭이 로그아웃했으면 아무 토큰도 내지 않는다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const presented = stubServer();

    localStorage.removeItem(WEB_KEY); // 이벤트 없이
    expect(await api.refreshSessionOutcome()).toBe("rejected");
    expect(presented).toEqual([]);
    expect(session.hasPersistedSession()).toBe(false);
  });
});

describe("웹 — storage 이벤트", () => {
  it("다른 탭의 회전 토큰을 받아들이고, 이 탭의 access 토큰은 그대로 둔다", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);
    const heard = vi.fn();
    session.subscribeSession(heard);

    fromOtherTab(WEB_KEY, stored("refresh-token-9"));

    expect(session.getRefreshToken()).toBe("refresh-token-9");
    expect(session.getAccessToken()).toBe("access-token-1");
    expect(session.getAuthExpired()).toBe(false);
    expect(heard).toHaveBeenCalled();
  });

  it("다른 탭의 로그아웃은 이 탭의 세션도 끝낸다 — 메모리의 access 토큰까지", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);

    fromOtherTab(WEB_KEY, null);

    expect(session.hasPersistedSession()).toBe(false);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getAuthExpired()).toBe(true);
  });

  it("다른 계정이 로그인하면 이 탭은 새로 시작한다", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { session } = await loadApp();
    session.applyLogin(login);

    fromOtherTab(WEB_KEY, stored("refresh-other", { ...member, id: "0199aaaa-0000-7000-8000-000000000002" }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.getAccessToken()).toBeNull();
  });

  it("받은 기록을 다시 쓰지 않는다 — 탭 사이 핑퐁 없음", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", { key: WEB_KEY, newValue: stored("refresh-token-9") }));
    expect(setItem).not.toHaveBeenCalledWith(WEB_KEY, expect.anything());
    setItem.mockRestore();
  });
});

describe("데스크톱(키체인) — 같은 규칙", () => {
  beforeEach(() => {
    mocks.desktop = true;
  });

  it("회전 전 키체인을 다시 읽고, 다른 창이 쓴 토큰을 낸다", async () => {
    const { session, api } = await loadApp();
    expect(session.getSessionStorageMode()).toBe("keychain");
    session.applyLogin(login);
    await flush();
    const presented = stubServer();
    mocks.keychain.load.mockImplementation(async () => "refresh-token-from-window-b");

    expect(await api.refreshSessionOutcome()).toBe("rotated");
    expect(presented).toEqual(["refresh-token-from-window-b"]);
    expect(mocks.keychain.store).toHaveBeenLastCalledWith("refresh-token-2");
  });

  it("키체인 읽기가 실패(null)하면 메모리의 토큰을 지키고 로그아웃으로 바꾸지 않는다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    await flush();
    const presented = stubServer();

    expect(await api.refreshSessionOutcome()).toBe("rotated");
    expect(presented).toEqual(["refresh-token-1"]);
  });

  it("회전이 키체인에 닿으면 표지 키를 바꿔 다른 창에 알린다", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);
    await flush();
    const first = localStorage.getItem(ROTATED_KEY);
    session.applyRotation("access-token-2", "refresh-token-2");
    await flush();
    expect(localStorage.getItem(ROTATED_KEY)).not.toBeNull();
    expect(localStorage.getItem(ROTATED_KEY)).not.toBe(first);
    // 토큰은 여전히 localStorage 에 없다.
    expect(JSON.stringify({ ...localStorage })).not.toContain("refresh-token-2");
  });

  it("표지 키 이벤트를 들으면 키체인에서 새 토큰을 받아들인다", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);
    await flush();
    mocks.keychain.load.mockImplementation(async () => "refresh-token-7");

    fromOtherTab(ROTATED_KEY, "nonce-from-window-b");
    await flush();

    expect(session.getRefreshToken()).toBe("refresh-token-7");
  });

  it("다른 창의 로그아웃(메타데이터 삭제)은 이 창의 세션도 끝낸다", async () => {
    const { session } = await loadApp();
    session.applyLogin(login);
    await flush();

    fromOtherTab(DESKTOP_KEY, null);
    await flush();

    expect(session.hasPersistedSession()).toBe(false);
    expect(session.getAuthExpired()).toBe(true);
  });
});

describe("락이 풀리지 않을 때", () => {
  it("다른 탭이 임대를 쥔 채 살아 있으면 기다리다 unreachable — 세션은 지우지 않는다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const presented = stubServer();
    const lock = await import("./rotationLock");

    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    // 살아 있는 다른 탭: 만료를 계속 뒤로 미룬다.
    const renew = () =>
      localStorage.setItem(lock.LEASE_KEY, JSON.stringify({ owner: "tab-b", expiresAt: Date.now() + lock.LEASE_TTL_MS }));
    renew();
    const keepAlive = setInterval(renew, 1_000);

    const outcome = api.refreshSessionOutcome();
    await vi.advanceTimersByTimeAsync(lock.LOCK_WAIT_MS + 1_000);
    clearInterval(keepAlive);

    expect(await outcome).toBe("unreachable");
    expect(presented).toEqual([]);
    expect(session.getRefreshToken()).toBe("refresh-token-1");
  });

  it("임대를 쥔 탭이 닫혔으면(갱신 없음) TTL 뒤 이 탭이 가져간다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    const presented = stubServer();
    const lock = await import("./rotationLock");

    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    localStorage.setItem(lock.LEASE_KEY, JSON.stringify({ owner: "closed-tab", expiresAt: Date.now() + lock.LEASE_TTL_MS }));

    const outcome = api.refreshSessionOutcome();
    await vi.advanceTimersByTimeAsync(lock.LEASE_TTL_MS + 500);
    vi.useRealTimers();

    expect(await outcome).toBe("rotated");
    expect(presented).toEqual(["refresh-token-1"]);
    expect(localStorage.getItem(lock.LEASE_KEY)).toBeNull(); // 끝나면 놓는다
  });

  it("회전이 실패(오프라인)해도 임대를 놓는다", async () => {
    const { session, api } = await loadApp();
    session.applyLogin(login);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const lock = await import("./rotationLock");

    expect(await api.refreshSessionOutcome()).toBe("unreachable");
    expect(localStorage.getItem(lock.LEASE_KEY)).toBeNull();
    expect(session.getRefreshToken()).toBe("refresh-token-1");
  });

  it("Locks API 가 끝내 락을 주지 않으면 LOCK_WAIT_MS 뒤 포기한다", async () => {
    const lock = await import("./rotationLock");
    vi.useFakeTimers();
    const never = {
      request: (_name: string, options: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    };
    const work = vi.fn(async () => "ran");
    const held = lock.withRotationLock(work, {
      locks: () => never,
      storage: () => null,
      now: () => Date.now(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    });
    const settled = held.then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(lock.LOCK_WAIT_MS + 1);
    expect(await settled).toBe("rejected");
    expect(work).not.toHaveBeenCalled();
  });
});
