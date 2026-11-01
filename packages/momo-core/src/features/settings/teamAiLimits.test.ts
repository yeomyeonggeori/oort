import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  fetchTeamAiLimitsBag,
  limitUsagePercent,
  monthlyUsdPercent,
  readTeamAiLimits,
  readTeamAiLimitsStatus,
  saveTeamAiLimits,
  teamAiLimitsPatchBody,
  type TeamAiLimitsStatus,
} from "./teamAiLimits";

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

const WS = "00000000-0000-7000-8000-000000000001";

/** 서버 `limits_status_in_tx` 가 내는 모양 그대로(openapi `TeamAiLimitsStatus`). */
const STATUS = {
  limits: { dailyTokens: 500000, dailySearches: null, monthlyUsd: 20 },
  effective: { dailyTokens: 200000, dailySearches: null },
  operatorCeiling: { dailyTokens: 200000, dailySearches: null, helperOff: false, searchOff: false },
  usage: {
    todayTokens: 124000,
    todaySearches: 3,
    monthCostMicroUsd: 12_500_000,
    monthRuns: 40,
    monthUnpricedRuns: 2,
    monthEstimatedRuns: 1,
  },
  monthlyUsdAvailable: true,
  monthlyUsdUnavailableReason: null,
  dayResetsAtMs: 1_790_000_000_000,
  monthResetsAtMs: 1_792_000_000_000,
};

describe("한도 읽기 (설정 가방의 team_ai_limits)", () => {
  it("없으면 한도가 없다", () => {
    expect(readTeamAiLimits({})).toEqual({});
    expect(readTeamAiLimits(null)).toEqual({});
    expect(readTeamAiLimits({ team_ai_limits: "많이" })).toEqual({});
  });

  it("정한 필드만 돌려준다", () => {
    expect(
      readTeamAiLimits({ team_ai_limits: { dailyTokens: 500000, monthlyUsd: 12.5 } })
    ).toEqual({ dailyTokens: 500000, monthlyUsd: 12.5 });
  });

  it("서버가 쓰지 않는 값은 한도가 아니다 (0·음수·소수·문자열)", () => {
    expect(
      readTeamAiLimits({
        team_ai_limits: { dailyTokens: 0, dailySearches: 1.5, monthlyUsd: -3 },
      })
    ).toEqual({});
    expect(
      readTeamAiLimits({ team_ai_limits: { dailyTokens: "9", monthlyUsd: "9" } })
    ).toEqual({});
  });
});

describe("계산된 읽기 (?include=team_ai_limits_status)", () => {
  it("서버가 낸 모양을 그대로 읽는다", () => {
    expect(readTeamAiLimitsStatus({ team_ai_limits_status: STATUS })).toEqual(STATUS);
  });

  it("없으면 null (저장된 가방만 온 응답)", () => {
    expect(readTeamAiLimitsStatus({ team_ai_limits: { dailyTokens: 5 } })).toBeNull();
    expect(readTeamAiLimitsStatus(null)).toBeNull();
  });

  it("한 조각이라도 모양이 다르면 통째로 null — 일부만 믿고 그리지 않는다", () => {
    const broken = (patch: (copy: typeof STATUS) => unknown) => {
      const copy = JSON.parse(JSON.stringify(STATUS)) as typeof STATUS;
      return readTeamAiLimitsStatus({ team_ai_limits_status: patch(copy) });
    };
    expect(broken((s) => ({ ...s, usage: { ...s.usage, todayTokens: "많이" } }))).toBeNull();
    expect(broken((s) => ({ ...s, usage: { ...s.usage, todayTokens: -1 } }))).toBeNull();
    expect(broken((s) => ({ ...s, monthlyUsdAvailable: "yes" }))).toBeNull();
    expect(broken((s) => ({ ...s, monthlyUsdUnavailableReason: "because" }))).toBeNull();
    expect(
      broken((s) => ({ ...s, operatorCeiling: { ...s.operatorCeiling, helperOff: 0 } }))
    ).toBeNull();
    expect(broken((s) => ({ ...s, limits: { ...s.limits, monthlyUsd: 0 } }))).toBeNull();
    expect(broken((s) => ({ ...s, dayResetsAtMs: "tomorrow" }))).toBeNull();
    expect(broken((s) => ({ ...s, effective: null }))).toBeNull();
  });

  it("금액 한도를 켤 수 없는 까닭 둘을 알아본다", () => {
    for (const reason of ["model_unpriced", "no_usage_yet"] as const) {
      const read = readTeamAiLimitsStatus({
        team_ai_limits_status: {
          ...STATUS,
          monthlyUsdAvailable: false,
          monthlyUsdUnavailableReason: reason,
        },
      });
      expect(read?.monthlyUsdAvailable).toBe(false);
      expect(read?.monthlyUsdUnavailableReason).toBe(reason);
    }
  });

  it("운영자의 끔 스위치는 0 이 아니라 플래그로 온다", () => {
    const read = readTeamAiLimitsStatus({
      team_ai_limits_status: {
        ...STATUS,
        effective: { dailyTokens: 0, dailySearches: 0 },
        operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: true, searchOff: true },
      },
    });
    expect(read?.operatorCeiling).toEqual({
      dailyTokens: null,
      dailySearches: null,
      helperOff: true,
      searchOff: true,
    });
    expect(read?.effective).toEqual({ dailyTokens: 0, dailySearches: 0 });
  });
});

describe("사용 %", () => {
  it("한도에 닿기 전에는 100 이 되지 않는다", () => {
    expect(limitUsagePercent(0, 1000)).toBe(0);
    expect(limitUsagePercent(620, 1000)).toBe(62);
    expect(limitUsagePercent(999, 1000)).toBe(99);
    expect(limitUsagePercent(1000, 1000)).toBe(100);
    expect(limitUsagePercent(5000, 1000)).toBe(100);
  });

  it("한도가 없으면 %도 없다", () => {
    expect(limitUsagePercent(10, null)).toBeNull();
    expect(limitUsagePercent(10, 0)).toBeNull();
  });

  it("금액은 마이크로 달러를 달러 한도에 맞춘다", () => {
    expect(monthlyUsdPercent(STATUS as TeamAiLimitsStatus)).toBe(62);
    expect(
      monthlyUsdPercent({
        ...(STATUS as TeamAiLimitsStatus),
        limits: { ...STATUS.limits, monthlyUsd: null },
      })
    ).toBeNull();
  });
});

describe("저장 요청", () => {
  it("이름을 댄 필드만 담고 undefined 는 보내지 않는다", () => {
    expect(teamAiLimitsPatchBody({ dailyTokens: 100000 })).toEqual({
      team_ai_limits: { dailyTokens: 100000 },
    });
    expect(
      teamAiLimitsPatchBody({ dailyTokens: undefined, monthlyUsd: null })
    ).toEqual({ team_ai_limits: { monthlyUsd: null } });
    expect(JSON.stringify(teamAiLimitsPatchBody({ dailySearches: undefined }))).toBe(
      '{"team_ai_limits":{}}'
    );
  });

  it("읽기와 저장은 계산된 읽기를 함께 달라고 한다", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ team_ai_limits: { dailyTokens: 100 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchTeamAiLimitsBag(WS);
    await saveTeamAiLimits(WS, { dailyTokens: 100, monthlyUsd: null });
    const url = `https://oort.test/v1/workspaces/${WS}/settings?include=team_ai_limits_status`;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(url);
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(url);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      team_ai_limits: { dailyTokens: 100, monthlyUsd: null },
    });
  });
});
