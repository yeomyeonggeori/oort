import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  DAILY_DELEGATIONS_DEFAULT,
  delegationLimitOrDefault,
  delegationOf,
  fetchTeamAiLimitsBag,
  limitUsagePercent,
  monthlyUsdPercent,
  readTeamAiLimits,
  readTeamAiLimitsStatus,
  saveTeamAiLimits,
  teamAiLimitsPatchBody,
  TEAM_AI_DELEGATION_CLOSED_WORDS,
  UNKNOWN_DELEGATION_STATUS,
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

/**
 * #5374 서버(`limits_status_in_tx`)가 같은 객체에 더하는 위임 칸 — ADR-0201 증보 v4 P7·P8. 관리자 값 4, 운영자 천장
 * 100, 오늘 3번 맡겼고 문(G3~G6)이 열려 있다.
 */
const DELEGATION_STATUS = {
  limits: { ...STATUS.limits, dailyDelegations: 4 },
  effective: { ...STATUS.effective, dailyDelegations: 4 },
  operatorCeiling: { ...STATUS.operatorCeiling, dailyDelegations: 100, delegationOff: false },
  usage: { ...STATUS.usage, todayDelegations: 3 },
  monthlyUsdAvailable: true,
  monthlyUsdUnavailableReason: null,
  delegationAvailable: true,
  delegationUnavailableReason: null,
  dayResetsAtMs: STATUS.dayResetsAtMs,
  monthResetsAtMs: STATUS.monthResetsAtMs,
};

/** 새 서버의 위임 칸만 바꾼 읽기. */
function delegationRead(patch: (copy: typeof DELEGATION_STATUS) => unknown) {
  const copy = JSON.parse(JSON.stringify(DELEGATION_STATUS)) as typeof DELEGATION_STATUS;
  return readTeamAiLimitsStatus({ team_ai_limits_status: patch(copy) });
}

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

  it("하루 위임 횟수는 서버 설정 문이 받는 1~200의 정수만이고, 없으면 기본 30이다 (#5374)", () => {
    for (const good of [1, 30, 200]) {
      expect(readTeamAiLimits({ team_ai_limits: { dailyDelegations: good } })).toEqual({
        dailyDelegations: good,
      });
    }
    for (const bad of [0, -1, 201, 30.5, "30", true, null]) {
      expect(readTeamAiLimits({ team_ai_limits: { dailyDelegations: bad } }), String(bad)).toEqual(
        {}
      );
    }
    expect(delegationLimitOrDefault({})).toBe(DAILY_DELEGATIONS_DEFAULT);
    expect(DAILY_DELEGATIONS_DEFAULT).toBe(30);
    expect(delegationLimitOrDefault({ dailyDelegations: 7 })).toBe(7);
  });
});

describe("계산된 읽기 (?include=team_ai_limits_status)", () => {
  it("서버가 낸 모양을 그대로 읽는다 — 위임 칸이 없는 옛 서버도 통째로 읽히고 위임만 모름 = 닫힘이다", () => {
    const read = readTeamAiLimitsStatus({ team_ai_limits_status: STATUS });
    expect(read).toEqual({ ...STATUS, delegation: UNKNOWN_DELEGATION_STATUS });
    expect(read?.delegation).toEqual({
      known: false,
      limit: null,
      effective: null,
      ceiling: null,
      ceilingOff: true,
      today: null,
      available: false,
      unavailableReason: "unknown",
    });
  });

  it("새 서버의 위임 칸을 읽는다: 관리자 값·실제 상한·천장·오늘 횟수·문 (#5374)", () => {
    const read = readTeamAiLimitsStatus({ team_ai_limits_status: DELEGATION_STATUS });
    expect(read?.delegation).toEqual({
      known: true,
      limit: 4,
      effective: 4,
      ceiling: 100,
      ceilingOff: false,
      today: 3,
      available: true,
      unavailableReason: null,
    });
    // 나머지 읽기는 옛 서버와 같은 값이다(위임 칸이 다른 칸을 움직이지 않는다)
    expect({ ...read, delegation: undefined }).toEqual({ ...STATUS, delegation: undefined });
    // 관리자가 정하지 않았으면(null) 기본 30이 실제 상한에 걸린다 — 「제한 없음」이 아니다
    expect(
      delegationRead((s) => ({
        ...s,
        limits: { ...s.limits, dailyDelegations: null },
        effective: { ...s.effective, dailyDelegations: 30 },
      }))?.delegation
    ).toMatchObject({ known: true, limit: null, effective: 30 });
  });

  it("천장이 비면 닫힘이다: 실제 상한 0 + 끔 표지 + 까닭 ceiling_unset", () => {
    const read = delegationRead((s) => ({
      ...s,
      effective: { ...s.effective, dailyDelegations: 0 },
      operatorCeiling: { ...s.operatorCeiling, dailyDelegations: null, delegationOff: true },
      delegationAvailable: false,
      delegationUnavailableReason: "ceiling_unset",
    }));
    expect(read?.delegation).toMatchObject({
      known: true,
      effective: 0,
      ceiling: null,
      ceilingOff: true,
      available: false,
      unavailableReason: "ceiling_unset",
    });
  });

  it("문이 닫힌 까닭은 서버 문의 낱말 그대로이고, 모르는 낱말은 unknown(닫힘)이다", () => {
    for (const word of TEAM_AI_DELEGATION_CLOSED_WORDS) {
      const read = delegationRead((s) => ({
        ...s,
        delegationAvailable: false,
        delegationUnavailableReason: word,
      }));
      expect(read?.delegation?.unavailableReason, word).toBe(word);
      expect(read?.delegation?.available, word).toBe(false);
    }
    const strange = delegationRead((s) => ({
      ...s,
      delegationAvailable: false,
      delegationUnavailableReason: "moon_phase",
    }));
    expect(strange?.delegation).toMatchObject({ known: true, available: false, unavailableReason: "unknown" });
  });

  it("위임 칸이 하나라도 없거나 어긋나면 위임만 모름 = 닫힘이고, 나머지 읽기는 그대로다", () => {
    const cases: [string, (s: typeof DELEGATION_STATUS) => unknown][] = [
      ["오늘 횟수 없음", (s) => ({ ...s, usage: { ...s.usage, todayDelegations: undefined } })],
      ["오늘 횟수 음수", (s) => ({ ...s, usage: { ...s.usage, todayDelegations: -1 } })],
      ["관리자 값 범위 밖", (s) => ({ ...s, limits: { ...s.limits, dailyDelegations: 500 } })],
      ["실제 상한 문자열", (s) => ({ ...s, effective: { ...s.effective, dailyDelegations: "4" } })],
      ["천장 0(양수만 천장)", (s) => ({ ...s, operatorCeiling: { ...s.operatorCeiling, dailyDelegations: 0 } })],
      ["끔 표지 없음", (s) => ({ ...s, operatorCeiling: { ...s.operatorCeiling, delegationOff: undefined } })],
      ["천장이 있는데 끔", (s) => ({ ...s, operatorCeiling: { ...s.operatorCeiling, delegationOff: true } })],
      ["천장이 있는데 끔(실제 0)", (s) => ({
        ...s,
        effective: { ...s.effective, dailyDelegations: 0 },
        operatorCeiling: { ...s.operatorCeiling, delegationOff: true },
      })],
      ["끔인데 실제 상한이 0이 아님", (s) => ({
        ...s,
        operatorCeiling: { ...s.operatorCeiling, dailyDelegations: null, delegationOff: true },
      })],
      ["열렸다면서 까닭", (s) => ({ ...s, delegationUnavailableReason: "daily_cap" })],
      ["닫혔다면서 까닭 없음", (s) => ({ ...s, delegationAvailable: false })],
      ["열림 표지가 문자열", (s) => ({ ...s, delegationAvailable: "yes" })],
    ];
    for (const [label, patch] of cases) {
      const read = delegationRead(patch);
      expect(read, label).not.toBeNull();
      expect(read?.delegation, label).toEqual(UNKNOWN_DELEGATION_STATUS);
      expect(read?.usage.todayTokens, label).toBe(STATUS.usage.todayTokens);
    }
  });

  it("손으로 만든 상태(위임 칸 없음)도 모름 = 닫힘으로 읽힌다", () => {
    expect(delegationOf(STATUS as TeamAiLimitsStatus)).toEqual(UNKNOWN_DELEGATION_STATUS);
    const read = readTeamAiLimitsStatus({ team_ai_limits_status: DELEGATION_STATUS });
    expect(read && delegationOf(read).today).toBe(3);
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

  it("하루 위임 횟수도 이름을 대면 실리고, null은 기본 30으로 돌리는 지우기다 (#5374)", () => {
    expect(teamAiLimitsPatchBody({ dailyDelegations: 12 })).toEqual({
      team_ai_limits: { dailyDelegations: 12 },
    });
    expect(teamAiLimitsPatchBody({ dailyDelegations: null, dailyTokens: 5 })).toEqual({
      team_ai_limits: { dailyTokens: 5, dailyDelegations: null },
    });
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
