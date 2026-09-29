import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import {
  DEVICE_KEY_REFUSAL,
  DeviceKeyRebindError,
  deviceKeyErrorMessage,
  deviceKeyServerMessage,
  fetchSigningContext,
  keyNeedsRebind,
  listDeviceKeys,
  parseDeviceKey,
  parseSigningContext,
  phoneKeyForLinkedDevice,
  phoneKeys,
  rebindDeviceKey,
  registerPhoneDeviceKey,
  registerRootDeviceKey,
  rootRowFor,
  submitEndorsement,
  submitRevocation,
  type DeviceKey,
} from "./deviceKeys";

const WS = "00000000-0000-7000-8000-000000000001";
const PHONE_KEY = "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW";
const MAC_KEY = "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S";

function installHost() {
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

function row(overrides: Partial<DeviceKey> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-7000-8000-00000000d002",
    workspaceId: WS,
    memberId: "00000000-0000-7000-8000-000000000101",
    alg: "p256",
    publicKey: PHONE_KEY,
    platform: "ios",
    label: "성재의 iPhone",
    state: "unendorsed",
    canInstruct: false,
    current: false,
    createdAtMs: 1_790_550_000_000,
    ...overrides,
  };
}

describe("deviceKeys wire (E2 DeviceKeyDto)", () => {
  it("parses a row and keeps the optional fields only when present", () => {
    const parsed = parseDeviceKey(row());
    expect(parsed.state).toBe("unendorsed");
    expect(parsed.endorsedByKeyId).toBeUndefined();
    expect(
      parseDeviceKey(row({ state: "revoked", revokedAtMs: 5, revocationSignature: "s" }))
        .revocationSignature
    ).toBe("s");
  });

  it("refuses an unknown state rather than guessing what it allows", () => {
    expect(() => parseDeviceKey(row({ state: "trusted" as never }))).toThrow(WireShapeError);
    expect(() => parseDeviceKey({ ...row(), canInstruct: undefined })).toThrow(WireShapeError);
  });

  it("sends the password only for the root registration and names refusals by code", async () => {
    installHost();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/device-keys") && init.method === "POST") {
          return new Response(
            JSON.stringify({ error: { message: "no", code: "device_root_password_required" } }),
            { status: 403, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ deviceKeys: [row()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    expect(await listDeviceKeys(WS)).toHaveLength(1);
    const error = await registerRootDeviceKey(WS, {
      publicKey: MAC_KEY,
      label: "성재의 MacBook Pro",
      currentPassword: "pw",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("device_root_password_required");
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      alg: "p256",
      publicKey: MAC_KEY,
      platform: "macos",
      label: "성재의 MacBook Pro",
      currentPassword: "pw",
    });
  });

  it("posts letters to the target key's endorsement and revocation routes", async () => {
    installHost();
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ deviceKey: row({ state: "endorsed" }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    await submitEndorsement(WS, "k1", { rootKeyId: "r", signature: "s" });
    await submitRevocation(WS, "k1", { rootKeyId: "r", revokedAtMs: 7, signature: "s" });
    expect(urls).toEqual([
      `https://oort.test/v1/workspaces/${WS}/device-keys/k1/endorsement`,
      `https://oort.test/v1/workspaces/${WS}/device-keys/k1/revocation`,
    ]);
    expect(bodies[1]).toEqual({ rootKeyId: "r", revokedAtMs: 7, signature: "s" });
  });
});

describe("the phone's side (#3026 E6)", () => {
  it("registers an ios key with no password field at all", async () => {
    installHost();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ deviceKey: row() }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      })
    );
    const key = await registerPhoneDeviceKey(WS, { publicKey: PHONE_KEY, label: "iPhone 17 Pro" });
    expect(key.state).toBe("unendorsed");
    expect(calls[0]!.url).toBe(`https://oort.test/v1/workspaces/${WS}/device-keys`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      alg: "p256",
      publicKey: PHONE_KEY,
      platform: "ios",
      label: "iPhone 17 Pro",
    });
  });

  it("reads the signing context verbatim and refuses a partial one", async () => {
    installHost();
    const context = {
      instanceId: "inst_01J9Z6T3QK8Y2W5N7M4R0P1XAB",
      serverTimeMs: 1_790_550_000_000,
      maxLifetimeMs: 600_000,
      maxClockSkewMs: 300_000,
      humanControlSignatureRequired: true,
      hostRegisterSignatureRequired: false,
    };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(context), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    // A server before #3097 has no `sessionId`: null, never a guess.
    expect(await fetchSigningContext(WS)).toEqual({ ...context, sessionId: null });
    expect(parseSigningContext({ ...context, sessionId: "s-1" }).sessionId).toBe("s-1");
    expect(parseSigningContext({ ...context, sessionId: null }).sessionId).toBeNull();
    expect(() => parseSigningContext({ ...context, sessionId: 7 })).toThrow(WireShapeError);
    expect(urls).toEqual([`https://oort.test/v1/workspaces/${WS}/device-keys/signing-context`]);
    expect(() => parseSigningContext({ ...context, instanceId: "" })).toThrow(WireShapeError);
    expect(() => parseSigningContext({ ...context, maxLifetimeMs: 0 })).toThrow(WireShapeError);
    expect(() =>
      parseSigningContext({ ...context, humanControlSignatureRequired: undefined })
    ).toThrow(WireShapeError);
  });
});

describe("rebind (#3103, ADR-0146 D-7 증보 #3097)", () => {
  it("reads lineageLive, and a server from before #3097 (no field) as live", () => {
    expect(parseDeviceKey(row()).lineageLive).toBe(true);
    expect(parseDeviceKey(row({ lineageLive: false })).lineageLive).toBe(false);
    expect(() => parseDeviceKey({ ...row(), lineageLive: "no" })).toThrow(WireShapeError);
  });

  function answer(body: Record<string, unknown>, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      })
    );
    return calls;
  }

  const input = {
    publicKey: PHONE_KEY,
    platform: "ios" as const,
    label: "iPhone",
    rebind: { signedAtMs: 1_790_000_000_000, signature: "c2ln" },
  };

  it("posts the register body with the letter and returns the moved, current row", async () => {
    installHost();
    const calls = answer({ deviceKey: row({ current: true, lineageLive: true }) });
    const moved = await rebindDeviceKey(WS, input);
    expect(moved.current).toBe(true);
    expect(calls[0]!.url).toBe(`https://oort.test/v1/workspaces/${WS}/device-keys`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      alg: "p256",
      publicKey: PHONE_KEY,
      platform: "ios",
      label: "iPhone",
      rebind: { signedAtMs: 1_790_000_000_000, signature: "c2ln" },
    });
  });

  it("treats a 200 whose row is not current as a failure, said as one", async () => {
    installHost();
    answer({ deviceKey: row({ current: false, lineageLive: true }) });
    const error = await rebindDeviceKey(WS, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceKeyRebindError);
    expect(deviceKeyErrorMessage(error)).toContain("옮기지 않았습니다");
    answer({ deviceKey: row({ current: true, lineageLive: false }) });
    expect(await rebindDeviceKey(WS, input).catch((e: unknown) => e)).toBeInstanceOf(
      DeviceKeyRebindError
    );
  });

  it("names the rebind refusals in sentences", async () => {
    installHost();
    answer({ error: { message: "x", code: "device_signature_invalid" } }, 403);
    const error = (await rebindDeviceKey(WS, input).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("device_signature_invalid");
    expect(deviceKeyServerMessage(error.code, "fallback")).toContain("시계");
    expect(deviceKeyServerMessage("device_key_rebind_required", "f")).toContain("다시 연결");
    expect(deviceKeyServerMessage("device_key_not_found", "f")).toContain("새로 등록");
    expect(deviceKeyErrorMessage("device_key_no_session")).toContain("다시 로그인");
  });
});

describe("deviceKeys views", () => {
  const keys = [
    parseDeviceKey(row({ id: "a", createdAtMs: 1 })),
    parseDeviceKey(row({ id: "b", label: "성재의 iPad", createdAtMs: 2 })),
    parseDeviceKey(row({ id: "c", state: "revoked", createdAtMs: 3 })),
    parseDeviceKey(
      row({ id: "m", platform: "macos", publicKey: MAC_KEY, state: "root", current: true })
    ),
  ];

  it("lists live phone keys newest first and finds this Mac's root row", () => {
    expect(phoneKeys(keys).map((k) => k.id)).toEqual(["b", "a"]);
    expect(rootRowFor(keys, MAC_KEY)).toEqual({ row: keys[3], lineageLive: true });
    expect(rootRowFor(keys, PHONE_KEY)).toBeUndefined();
  });

  it("offers no phone the server will not let a root approve, and keeps an approved one marked (#3119)", () => {
    const rows = [
      parseDeviceKey(row({ id: "qr", linkedSession: true, linkedFromMac: true, createdAtMs: 5 })),
      parseDeviceKey(row({ id: "password", linkedSession: false, linkedFromMac: false, createdAtMs: 4 })),
      parseDeviceKey(row({ id: "self-qr", linkedSession: true, linkedFromMac: false, createdAtMs: 3 })),
      parseDeviceKey(
        row({
          id: "approved-before",
          state: "endorsed",
          canInstruct: true,
          linkedSession: false,
          linkedFromMac: false,
          createdAtMs: 2,
        })
      ),
      parseDeviceKey(row({ id: "older-server", createdAtMs: 1 })),
    ];
    expect(phoneKeys(rows).map((k) => k.id)).toEqual(["qr", "approved-before", "older-server"]);
    expect(rows[3]!.linkedSession).toBe(false);
    expect(rows[4]!.linkedSession).toBeUndefined();
    expect(deviceKeyServerMessage(DEVICE_KEY_REFUSAL.requiresLinkedSession, "x")).toContain("QR");
    expect(deviceKeyServerMessage(DEVICE_KEY_REFUSAL.linkNotFromMac, "x")).toContain("QR");
  });

  it("finds a root row on an ended sign-in as a row that must move, not a new registration (#3103)", () => {
    const mute = parseDeviceKey(
      row({
        id: "m",
        platform: "macos",
        publicKey: MAC_KEY,
        state: "root",
        lineageLive: false,
      })
    );
    expect(mute.lineageLive).toBe(false);
    expect(rootRowFor([mute], MAC_KEY)).toEqual({ row: mute, lineageLive: false });
    expect(keyNeedsRebind(mute)).toBe(true);
    expect(keyNeedsRebind({ ...mute, lineageLive: true })).toBe(false);
    // A revoked row is never moved: it is registered afresh.
    expect(keyNeedsRebind({ ...mute, state: "revoked" })).toBe(false);
  });

  it("maps a linked device to a key only when exactly one live phone key matches", () => {
    expect(
      phoneKeyForLinkedDevice(keys, { label: "성재의 iPhone", platform: "ios" })?.id
    ).toBe("a");
    const twin = [...keys, parseDeviceKey(row({ id: "d", createdAtMs: 4 }))];
    expect(phoneKeyForLinkedDevice(twin, { label: "성재의 iPhone", platform: "ios" })).toBe(
      undefined
    );
    expect(phoneKeyForLinkedDevice(keys, { label: "성재의 iPhone", platform: "macos" })).toBe(
      undefined
    );
  });
});
