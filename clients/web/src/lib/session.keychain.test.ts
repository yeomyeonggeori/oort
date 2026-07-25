import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "./api";

// The refresh token's storage location is a RUNTIME decision (ADR-0133 P2,
// MOMO-603), so what is worth pinning is the decision itself and its failure
// modes — the shape parsing is covered in ./session.test.ts.
//
// The store keeps module-level state, so every test re-imports it fresh against
// a fresh fake localStorage. That is also what makes "what is in storage after
// this" assertable: the fake is inspected directly rather than through the API
// that wrote it.

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

const member: LoginResponse["member"] = {
  id: "0199aaaa-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human",
  displayName: "곽성재",
  handle: "seongjae",
};

const login: LoginResponse = {
  accessToken: "access.token",
  refreshToken: "refresh.token",
  member,
  realtimeWebSocketUrl: "ws://momowebqa.local:28001/connection/websocket",
};

function webRecord(refreshToken: string) {
  return JSON.stringify({
    refreshToken,
    realtimeWebSocketUrl: login.realtimeWebSocketUrl,
    member,
  });
}

let store: Map<string, string>;

/** Lets the serialised keychain writes queued by the store run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadStore(seed: Record<string, string> = {}) {
  store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.resetModules();
  return import("./session");
}

beforeEach(() => {
  mocks.desktop = false;
  mocks.keychain.available.mockResolvedValue(true);
  mocks.keychain.load.mockResolvedValue(null);
  mocks.keychain.store.mockResolvedValue(true);
  mocks.keychain.clear.mockResolvedValue(true);
  vi.clearAllMocks();
});

describe("browser runtime", () => {
  it("keeps the whole record in web storage and never reaches for a keychain", async () => {
    const session = await loadStore();
    await session.initSessionStore();

    expect(session.getSessionStorageMode()).toBe("web");
    session.applyLogin(login);
    await flush();

    expect(JSON.parse(store.get(WEB_KEY)!).refreshToken).toBe("refresh.token");
    expect(store.has(DESKTOP_KEY)).toBe(false);
    expect(mocks.keychain.available).not.toHaveBeenCalled();
    expect(mocks.keychain.store).not.toHaveBeenCalled();
  });
});

describe("desktop runtime with a working keychain", () => {
  beforeEach(() => {
    mocks.desktop = true;
  });

  it("resumes from the keychain, with the token absent from web storage", async () => {
    mocks.keychain.load.mockResolvedValue("stored.refresh");
    const session = await loadStore({
      [DESKTOP_KEY]: JSON.stringify({
        realtimeWebSocketUrl: login.realtimeWebSocketUrl,
        member,
      }),
    });
    await session.initSessionStore();

    expect(session.getSessionStorageMode()).toBe("keychain");
    expect(session.hasPersistedSession()).toBe(true);
    expect(session.getRefreshToken()).toBe("stored.refresh");
    expect(store.has(WEB_KEY)).toBe(false);
  });

  it("migrates a web-storage session and deletes the web copy", async () => {
    const session = await loadStore({ [WEB_KEY]: webRecord("legacy.refresh") });
    await session.initSessionStore();

    expect(mocks.keychain.store).toHaveBeenCalledWith("legacy.refresh");
    expect(store.has(WEB_KEY)).toBe(false);
    expect(JSON.parse(store.get(DESKTOP_KEY)!)).toEqual({
      realtimeWebSocketUrl: login.realtimeWebSocketUrl,
      member,
    });
    expect(session.getRefreshToken()).toBe("legacy.refresh");
  });

  it("keeps the web copy when the migration write does not land", async () => {
    mocks.keychain.store.mockResolvedValue(false);
    const session = await loadStore({ [WEB_KEY]: webRecord("legacy.refresh") });
    await session.initSessionStore();

    // Deleting it here would sign the person out to no benefit.
    expect(store.has(WEB_KEY)).toBe(true);
    expect(session.getSessionStorageMode()).toBe("web");
    expect(session.getRefreshToken()).toBe("legacy.refresh");
  });

  it("writes rotations to the keychain and never to web storage", async () => {
    const session = await loadStore();
    await session.initSessionStore();

    session.applyLogin(login);
    session.applyRotation("access.2", "refresh.2");
    await flush();

    expect(mocks.keychain.store).toHaveBeenLastCalledWith("refresh.2");
    expect(store.has(WEB_KEY)).toBe(false);
    expect(JSON.stringify([...store.values()])).not.toContain("refresh.2");
  });

  it("erases the credential store on logout", async () => {
    const session = await loadStore();
    await session.initSessionStore();
    session.applyLogin(login);
    await flush();

    session.clearSession();
    await flush();

    expect(mocks.keychain.clear).toHaveBeenCalled();
    expect(store.has(DESKTOP_KEY)).toBe(false);
    expect(session.hasPersistedSession()).toBe(false);
  });

  it("discards metadata left without its token instead of half-resuming", async () => {
    mocks.keychain.load.mockResolvedValue(null);
    const session = await loadStore({
      [DESKTOP_KEY]: JSON.stringify({
        realtimeWebSocketUrl: login.realtimeWebSocketUrl,
        member,
      }),
    });
    await session.initSessionStore();
    await flush();

    expect(session.hasPersistedSession()).toBe(false);
    expect(store.has(DESKTOP_KEY)).toBe(false);
    expect(mocks.keychain.clear).toHaveBeenCalled();
  });
});

describe("desktop runtime with no usable keychain", () => {
  it("still signs in, on web storage, and says so", async () => {
    mocks.desktop = true;
    mocks.keychain.available.mockResolvedValue(false);
    const session = await loadStore({ [WEB_KEY]: webRecord("refresh.token") });
    await session.initSessionStore();

    expect(session.getSessionStorageMode()).toBe("web");
    expect(session.getRefreshToken()).toBe("refresh.token");
    expect(mocks.keychain.store).not.toHaveBeenCalled();
  });
});
