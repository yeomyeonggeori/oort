import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginResponse } from "@momo/core/lib/api";

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
  log: [] as string[],
  hold: {
    begin: vi.fn(async (): Promise<boolean> => {
      mocks.log.push("hold:begin");
      return true;
    }),
    end: vi.fn(async (): Promise<void> => {
      mocks.log.push("hold:end");
    }),
  },
}));

vi.mock("./tauri", () => ({
  isDesktop: () => mocks.desktop,
  desktopKeychain: mocks.keychain,
  desktopRotationHold: mocks.hold,
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
  mocks.log.length = 0;
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

  it("does not touch the credential store when there is nothing to resume", async () => {
    // MOMO-606: on macOS a probe against an item written by a differently
    // signed build is answered with a login-keychain password DIALOG, not an
    // error. A first launch must not put that in front of someone who has not
    // signed in, to answer a question whose answer is not used until they do.
    const session = await loadStore();
    await session.initSessionStore();

    expect(mocks.keychain.available).not.toHaveBeenCalled();
    expect(mocks.keychain.load).not.toHaveBeenCalled();
    expect(session.getSessionStorageMode()).toBe("keychain");
    expect(session.hasPersistedSession()).toBe(false);
  });

  it("demotes to web storage when the keychain refuses the write, keeping the session", async () => {
    mocks.keychain.store.mockResolvedValue(false);
    const session = await loadStore();
    await session.initSessionStore();

    session.applyLogin(login);
    await flush();

    expect(session.getSessionStorageMode()).toBe("web");
    expect(JSON.parse(store.get(WEB_KEY)!).refreshToken).toBe("refresh.token");
    expect(store.has(DESKTOP_KEY)).toBe(false);
    expect(session.getRefreshToken()).toBe("refresh.token");
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

// #3098 — closing the window destroys the webview, and with it a rotation whose
// response or keychain write is still in the air. The shell defers the close
// while a hold is open (clients/desktop/src-tauri/src/rotation_hold.rs); what
// is pinned here is that the web half opens the hold before the POST and
// releases it only once the rotated token is in the keychain.
describe("desktop: a rotation holds the window open until its token is stored (#3098)", () => {
  beforeEach(() => {
    mocks.desktop = true;
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function signedIn() {
    const session = await loadStore();
    await session.initSessionStore();
    session.applyLogin(login);
    await flush();
    mocks.log.length = 0;
    return session;
  }

  it("holds from before the POST until the keychain write has landed", async () => {
    const session = await signedIn();
    const server = deferred<void>();
    const write = deferred<boolean>();
    mocks.keychain.store.mockImplementationOnce(async () => {
      mocks.log.push("keychain:write-started");
      const ok = await write.promise;
      mocks.log.push("keychain:written");
      return ok;
    });

    const rotation = session.exclusiveRotation(async () => {
      mocks.log.push("post");
      await server.promise; // the slow response the window is closed during
      session.applyRotation("access.2", "refresh.2");
      return "rotated";
    });
    await vi.waitFor(() => expect(mocks.log).toContain("post"));
    expect(mocks.log).toEqual(["hold:begin", "post"]);

    server.resolve();
    await vi.waitFor(() => expect(mocks.log).toContain("keychain:write-started"));
    await flush();
    // The server has revoked refresh.token; refresh.2 is not written yet.
    expect(mocks.log).not.toContain("hold:end");

    write.resolve(true);
    await expect(rotation).resolves.toBe("rotated");
    await flush();
    expect(mocks.log).toEqual([
      "hold:begin",
      "post",
      "keychain:write-started",
      "keychain:written",
      "hold:end",
    ]);
    expect(mocks.keychain.store).toHaveBeenLastCalledWith("refresh.2");
  });

  it("releases the hold when the rotation fails", async () => {
    const session = await signedIn();
    await expect(
      session.exclusiveRotation(async () => {
        mocks.log.push("post");
        throw new TypeError("Failed to fetch");
      })
    ).rejects.toThrow("Failed to fetch");
    await flush();
    expect(mocks.log).toEqual(["hold:begin", "post", "hold:end"]);
  });

  it("owes no release when the shell did not take the hold", async () => {
    const session = await signedIn();
    mocks.hold.begin.mockResolvedValueOnce(false);
    await session.exclusiveRotation(async () => "rotated");
    await flush();
    expect(mocks.hold.end).not.toHaveBeenCalled();
  });

  it("asks for no hold in a browser", async () => {
    mocks.desktop = false;
    const session = await signedIn();
    await session.exclusiveRotation(async () => "rotated");
    expect(mocks.hold.begin).not.toHaveBeenCalled();
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
