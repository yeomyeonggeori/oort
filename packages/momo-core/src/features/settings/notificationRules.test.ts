import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  DEFAULT_NOTIFICATION_RULES,
  DEFAULT_PUSH_KINDS,
  fetchPushKinds,
  notificationRulesFromWire,
  patchNotificationRules,
  patchPushKinds,
  pushKindsFromWire,
} from "./notificationRules";

describe("notificationRulesFromWire", () => {
  it("reads both switches from a well-formed body", () => {
    expect(
      notificationRulesFromWire({ dnd: true, mentionOverridesMute: false })
    ).toEqual({ dnd: true, mentionOverridesMute: false });
  });

  it("treats a missing switch as off, the pre-증보 default", () => {
    // A server that never wrote a row answers with the defaults; a switch that
    // is simply absent must read false, never undefined.
    expect(notificationRulesFromWire({})).toEqual(DEFAULT_NOTIFICATION_RULES);
    expect(notificationRulesFromWire({ dnd: true })).toEqual({
      dnd: true,
      mentionOverridesMute: false,
    });
  });

  it("degrades a non-object body to defaults instead of throwing", () => {
    // The route is new; a proxy answering 200 with a string must not crash the
    // panel (the chainModel lesson). "both off" is the honest, safe fallback.
    expect(notificationRulesFromWire("not json")).toEqual(
      DEFAULT_NOTIFICATION_RULES
    );
    expect(notificationRulesFromWire(null)).toEqual(DEFAULT_NOTIFICATION_RULES);
  });

  it("carries dndUntilMs only while the pause is on (ADR-0124 증보 2)", () => {
    expect(
      notificationRulesFromWire({
        dnd: true,
        dndUntilMs: 1_800_000_000_000,
        mentionOverridesMute: false,
      })
    ).toEqual({
      dnd: true,
      dndUntilMs: 1_800_000_000_000,
      mentionOverridesMute: false,
    });
    // An older server, an open-ended pause, or a pause that is off: no key.
    expect(
      notificationRulesFromWire({ dnd: true, dndUntilMs: null })
    ).toEqual({ dnd: true, mentionOverridesMute: false });
    expect(
      notificationRulesFromWire({ dnd: false, dndUntilMs: 5 })
    ).toEqual(DEFAULT_NOTIFICATION_RULES);
  });

  it("ignores a non-boolean switch rather than coercing it", () => {
    expect(
      notificationRulesFromWire({ dnd: "yes", mentionOverridesMute: 1 })
    ).toEqual(DEFAULT_NOTIFICATION_RULES);
  });
});

// ---- #3042: the write is a field PATCH ---------------------------------------
//
// The fake server below does what the real one does (#3012): PUT replaces the
// whole rule, PATCH merges the named fields into what is stored when it lands.
// "Another device" changes a switch between this client's read and its write;
// only a patch that names the ONE field this surface touched keeps that change.

describe("patchNotificationRules (#3042)", () => {
  const WS = "00000000-0000-7000-8000-000000000001";

  function installHost(): void {
    const session: SessionPort = {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    };
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });

  it("sends only the named field, with PATCH, and reads the stored rule back", async () => {
    installHost();
    let stored = { dnd: false, mentionOverridesMute: true };
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ method: String(init?.method), body });
        stored = init?.method === "PATCH" ? { ...stored, ...body } : body;
        return new Response(JSON.stringify(stored), { status: 200 });
      })
    );
    await expect(patchNotificationRules(WS, { dnd: true })).resolves.toEqual({
      dnd: true,
      mentionOverridesMute: true,
    });
    expect(calls).toEqual([{ method: "PATCH", body: { dnd: true } }]);
  });

  it("refuses an empty patch without a round trip", async () => {
    installHost();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(patchNotificationRules(WS, {})).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries the server's error.code on a refusal", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "nope", code: "some_code" } }),
            { status: 409 }
          )
      )
    );
    const error = await patchNotificationRules(WS, { dnd: true }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: "nope", code: "some_code" });
  });
});

// ---- ADR-0120 부록 A (#3342): 푸시 종류 ---------------------------------------

describe("push kinds (#3342)", () => {
  const WS = "00000000-0000-7000-8000-000000000001";

  function installHost(): void {
    installCoreHost({
      apiBase: () => "https://oort.test",
      absoluteApiBase: () => "https://oort.test",
      buildMode: () => "test",
      session: {
        getAccessToken: () => "access-token",
        getRefreshToken: () => null,
        getPersistedSession: () => null,
        applyLogin: () => {},
        applyRotation: () => {},
        markAuthExpired: () => {},
        clearSession: () => {},
      },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCoreHost();
  });

  it("reads an absent or malformed body as ON — the server's no-row answer", () => {
    expect(pushKindsFromWire({})).toEqual(DEFAULT_PUSH_KINDS);
    expect(pushKindsFromWire(null)).toEqual(DEFAULT_PUSH_KINDS);
    expect(pushKindsFromWire({ workComplete: "no" })).toEqual(DEFAULT_PUSH_KINDS);
    expect(pushKindsFromWire({ workComplete: false })).toEqual({ workComplete: false });
  });

  it("PATCHes exactly {workComplete} to the push-kinds path", async () => {
    installHost();
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: String(init?.method),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ workComplete: false }), { status: 200 });
      })
    );
    await expect(patchPushKinds(WS, { workComplete: false })).resolves.toEqual({
      workComplete: false,
    });
    expect(calls).toEqual([
      {
        url: `https://oort.test/v1/workspaces/${WS}/notification-rules/push-kinds`,
        method: "PATCH",
        body: { workComplete: false },
      },
    ]);
  });

  it("GETs the same path and refuses an empty patch without a round trip", async () => {
    installHost();
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ workComplete: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPushKinds(WS)).resolves.toEqual({ workComplete: true });
    expect(requested[0]).toBe(
      `https://oort.test/v1/workspaces/${WS}/notification-rules/push-kinds`
    );
    fetchMock.mockClear();
    await expect(patchPushKinds(WS, {})).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
