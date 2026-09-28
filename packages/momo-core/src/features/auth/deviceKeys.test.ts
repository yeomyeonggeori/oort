import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import {
  deviceKeyFingerprint,
  listDeviceKeys,
  parseDeviceKey,
  phoneKeyForLinkedDevice,
  phoneKeys,
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
    expect(rootRowFor(keys, MAC_KEY)?.id).toBe("m");
    expect(rootRowFor(keys, PHONE_KEY)).toBeUndefined();
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

describe("deviceKeyFingerprint", () => {
  // Same key, same string as the desktop shell's native dialog
  // (clients/desktop/src-tauri/src/device_key/payload/tests.rs FINGERPRINT_VECTOR).
  it("matches the shared case", async () => {
    expect(await deviceKeyFingerprint(PHONE_KEY)).toBe("5BAF F89D E7DE 5C1D 7B61");
  });
});
