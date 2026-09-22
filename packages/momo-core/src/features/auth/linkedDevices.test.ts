import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  CANNOT_REVOKE_CURRENT,
  isCannotRevokeCurrent,
  isPhonePlatform,
  linkedDevicePlatformLabel,
  listLinkedDevices,
  parseLinkedDeviceList,
  revokeLinkedDevice,
} from "./linkedDevices";

const CURRENT_ID = "019f9b10-0000-7000-8000-000000000d01";
const OTHER_ID = "019f9b10-0000-7000-8000-000000000d02";

function installHost(overrides: Partial<SessionPort> = {}): SessionPort {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
    ...overrides,
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
  return session;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function jsonResponse(body: unknown, status: number): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TWO = {
  devices: [
    {
      id: CURRENT_ID,
      label: "성재 iMac, 집 작업실",
      platform: "macos",
      linkedAt: 1_800_000_000_000,
      current: true,
    },
    {
      id: OTHER_ID,
      label: "성재 iPhone 16 Pro Max, 집 작업실 책상 옆 MagSafe 충전 거치대",
      platform: "ios",
      linkedAt: 1_800_000_100_000,
      current: false,
    },
  ],
};

describe("linkedDevices wire", () => {
  it("parses a list and omits lastSeenAt when the field is absent", () => {
    const parsed = parseLinkedDeviceList(TWO);
    expect(parsed.devices).toHaveLength(2);
    expect(parsed.devices[0]?.current).toBe(true);
    expect(parsed.devices[0]?.lastSeenAt).toBeUndefined();
    expect(parsed.devices[1]?.label).toContain("iPhone 16 Pro Max");
    expect(
      parseLinkedDeviceList({
        devices: [
          {
            ...TWO.devices[0],
            lastSeenAt: 1_800_000_200_000,
          },
        ],
      }).devices[0]?.lastSeenAt
    ).toBe(1_800_000_200_000);
  });

  it("rejects a list that is missing current", () => {
    expect(() =>
      parseLinkedDeviceList({
        devices: [
          {
            id: CURRENT_ID,
            label: "맥",
            platform: "macos",
            linkedAt: 1,
          },
        ],
      })
    ).toThrow(WireShapeError);
  });
});

describe("linkedDevices platform labels", () => {
  it("maps known wire tokens and treats ipados as a phone", () => {
    expect(linkedDevicePlatformLabel("ios")).toBe("iOS");
    expect(linkedDevicePlatformLabel("ipados")).toBe("iPadOS");
    expect(linkedDevicePlatformLabel("macos")).toBe("macOS");
    expect(linkedDevicePlatformLabel("android")).toBe("Android");
    expect(linkedDevicePlatformLabel("windows")).toBe("Windows");
    expect(isPhonePlatform("ipados")).toBe(true);
    expect(isPhonePlatform("macos")).toBe(false);
    expect(linkedDevicePlatformLabel("custom-rig")).toBe("custom-rig");
  });
});

describe("linkedDevices client", () => {
  it("GETs the owner list and DELETEs one id", async () => {
    installHost();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/v1/auth/devices") && (init?.method ?? "GET") === "GET") {
        expect(init?.cache).toBe("no-store");
        return jsonResponse(TWO, 200);
      }
      if (path.endsWith(`/v1/auth/devices/${OTHER_ID}`)) {
        expect(init?.method).toBe("DELETE");
        return jsonResponse(null, 204);
      }
      throw new Error(path);
    });
    vi.stubGlobal("fetch", fetchMock);
    const listed = await listLinkedDevices();
    expect(listed.devices).toHaveLength(2);
    await expect(revokeLinkedDevice(OTHER_ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 400 cannot_revoke_current and 404 without leaking a body", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith(CURRENT_ID)) {
          return jsonResponse(
            { error: { message: CANNOT_REVOKE_CURRENT } },
            400
          );
        }
        return jsonResponse({ error: { message: "not found" } }, 404);
      })
    );
    const current = await revokeLinkedDevice(CURRENT_ID)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(isCannotRevokeCurrent(current)).toBe(true);
    const missing = await revokeLinkedDevice(OTHER_ID)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
  });

  it("rotates once on 401 and retries the list", async () => {
    const markAuthExpired = vi.fn();
    const applyRotation = vi.fn();
    installHost({
      getRefreshToken: () => "refresh-token",
      markAuthExpired,
      applyRotation,
    });
    let listGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/v1/auth/refresh")) {
          expect(init?.method).toBe("POST");
          return jsonResponse(
            { accessToken: "next-access", refreshToken: "next-refresh" },
            200
          );
        }
        if (path.endsWith("/v1/auth/devices")) {
          listGets += 1;
          if (listGets === 1) {
            return jsonResponse({ error: { message: "expired" } }, 401);
          }
          return jsonResponse(TWO, 200);
        }
        throw new Error(path);
      })
    );
    const listed = await listLinkedDevices();
    expect(listed.devices).toHaveLength(2);
    expect(listGets).toBe(2);
    expect(applyRotation).toHaveBeenCalledWith("next-access", "next-refresh");
    expect(markAuthExpired).not.toHaveBeenCalled();
  });

  it("a 401 that survives rotation ends the session", async () => {
    const markAuthExpired = vi.fn();
    installHost({
      getRefreshToken: () => "refresh-token",
      markAuthExpired,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/auth/refresh")) {
          return jsonResponse({ error: { message: "gone" } }, 401);
        }
        return jsonResponse({ error: { message: "expired" } }, 401);
      })
    );
    const error = await listLinkedDevices()
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(markAuthExpired).toHaveBeenCalled();
  });
});
