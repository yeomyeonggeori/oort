import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  DEFAULT_PHONE_DELAY_SECS,
  PHONE_DELAY_OPTIONS,
  fetchPhoneDelay,
  hidesPhoneDelayRow,
  isNotificationPrefsUnavailable,
  phoneDelayFromWire,
  savePhoneDelay,
} from "./notificationPrefs";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("phoneDelayFromWire", () => {
  it("서버가 받는 세 값(0·60·300)만 그대로 읽고, 그 밖·빠진 값은 서버의 기본 60초다", () => {
    expect([...PHONE_DELAY_OPTIONS]).toEqual([0, 60, 300]);
    expect(phoneDelayFromWire({ phoneDelaySecs: 0 })).toBe(0);
    expect(phoneDelayFromWire({ phoneDelaySecs: 60 })).toBe(60);
    expect(phoneDelayFromWire({ phoneDelaySecs: 300 })).toBe(300);
    for (const odd of [{}, { phoneDelaySecs: 30 }, { phoneDelaySecs: "300" }, null, "x"]) {
      expect(phoneDelayFromWire(odd)).toBe(DEFAULT_PHONE_DELAY_SECS);
    }
    expect(DEFAULT_PHONE_DELAY_SECS).toBe(60);
  });
});

describe("notification-prefs 한 칸 읽고 쓰기", () => {
  it("GET 은 phoneDelaySecs 만 읽고, 다른 필드는 건드리지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      json({ kinds: {}, phoneDelaySecs: 300, keywordOverridesMute: true })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPhoneDelay("w 1")).resolves.toBe(300);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://oort.test/v1/workspaces/w%201/notification-prefs");
  });

  it("PATCH 는 이 칸 하나만 싣는다(다른 기기가 바꾼 칸을 지우지 않는다)", async () => {
    installHost();
    const fetchMock = vi.fn(async () => json({ phoneDelaySecs: 0, dnd: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(savePhoneDelay("w", 0)).resolves.toBe(0);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(String(call[1].body))).toEqual({ phoneDelaySecs: 0 });
  });

  it("옛 서버의 404·405 만 「기능 없음」이고, 403 은 칸을 숨기되 그 밖의 실패는 숨김이 아니다", () => {
    for (const status of [404, 405]) {
      expect(isNotificationPrefsUnavailable(new ApiError(status, "x"))).toBe(true);
      expect(hidesPhoneDelayRow(new ApiError(status, "x"))).toBe(true);
    }
    expect(isNotificationPrefsUnavailable(new ApiError(403, "x"))).toBe(false);
    expect(hidesPhoneDelayRow(new ApiError(403, "x"))).toBe(true);
    for (const status of [400, 401, 422, 500, 503]) {
      expect(hidesPhoneDelayRow(new ApiError(status, "x"))).toBe(false);
    }
    expect(hidesPhoneDelayRow(new TypeError("offline"))).toBe(false);
  });
});
