import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  confirmDeviceLinkSas,
  getDeviceLink,
  issueDeviceLink,
  parseDeviceLinkIssue,
  parseDeviceLinkStatus,
} from "./deviceLink";

const TOKEN_HEAD = "ABCDEFGHIJKLMNOPQRSTUV";
const TOKEN_TAIL = "WXYZabcdefghijklmnopq";

function voucher(): string {
  return `${TOKEN_HEAD}${TOKEN_TAIL}`;
}

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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("deviceLink wire", () => {
  it("parses a 201 issue body and omits sas when the field is absent", () => {
    const token = voucher();
    const issued = parseDeviceLinkIssue({
      id: "019f9b10-0000-7000-8000-000000000d01",
      token,
      expiresAt: 1_800_000_120_000,
      deepLink: `oort://link?server=https%3A%2F%2Fteam.example.com&token=${token}`,
    });
    expect(issued.sas).toBeUndefined();
    expect(issued.token).toHaveLength(43);
    expect(
      parseDeviceLinkIssue({
        id: issued.id,
        token,
        expiresAt: issued.expiresAt,
        sas: "4821",
        deepLink: issued.deepLink,
      }).sas
    ).toBe("4821");
  });

  it("rejects an issue body that is missing the raw voucher", () => {
    expect(() =>
      parseDeviceLinkIssue({
        id: "019f9b10-0000-7000-8000-000000000d01",
        expiresAt: 1,
        deepLink: "oort://link?server=https%3A%2F%2Fx.example&token=x",
      })
    ).toThrow(WireShapeError);
  });

  it("parses status with an optional long device name", () => {
    expect(parseDeviceLinkStatus({ status: "pending" })).toEqual({
      status: "pending",
    });
    const consumed = parseDeviceLinkStatus({
      status: "consumed",
      device: {
        name: "성재 iPhone 16 Pro Max, 집 작업실 책상 옆 MagSafe 충전 거치대",
        platform: "ios",
      },
    });
    expect(consumed.device?.name).toContain("iPhone 16 Pro Max");
  });
});

describe("deviceLink issuer client", () => {
  it("POSTs issue with no-store and reads a 201", async () => {
    installHost();
    const token = voucher();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://oort.test/v1/auth/device-link");
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      return jsonResponse(
        {
          id: "019f9b10-0000-7000-8000-000000000d01",
          token,
          expiresAt: 1_800_000_120_000,
          sas: "4821",
          deepLink: `oort://link?server=https%3A%2F%2Fteam.example.com&token=${token}`,
        },
        201
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const issued = await issueDeviceLink();
    expect(issued.sas).toBe("4821");
    expect(issued.token).toHaveLength(43);
  });

  it("GETs status and POSTs confirm-sas", async () => {
    installHost();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/confirm-sas")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ status: "confirmed" }, 200);
      }
      return jsonResponse({ status: "pending" }, 200);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getDeviceLink("019f9b10-0000-7000-8000-000000000d01")
    ).resolves.toEqual({ status: "pending" });
    await expect(
      confirmDeviceLinkSas("019f9b10-0000-7000-8000-000000000d01")
    ).resolves.toEqual({ status: "confirmed" });
  });

  it("maps a 409 confirm to ApiError without reading a voucher", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "not redeemed" } }, 409)
      )
    );
    const error = await confirmDeviceLinkSas(
      "019f9b10-0000-7000-8000-000000000d01"
    )
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
  });
});
