// =============================================================================
// 팀 AI 사용 한도의 코어 타입 (ADR-0201 증보 v3 B9, #4944) — 서버 몫.
//
// 서버 쪽 사실:
//   - BYOK 라서 기본은 **제한 없음**이다. 설정 가방(`GET|PATCH /v1/workspaces/{ws}/settings`,
//     운영자 전용)의 `team_ai_limits` 가 없으면 한도가 없다. 관리자가 원하면 셋 중 골라 켠다:
//     `dailyTokens`·`dailySearches`(1 이상의 정수), `monthlyUsd`(0 보다 큰 수).
//     **「제한 없음」은 필드를 없애는 것이지 `0` 이 아니다**(`0`·음수·소수·모르는 필드는 400).
//   - 한 단계 아래로 병합된다: 이름을 댄 필드만 바뀌고, 안 댄 필드는 그대로, `null` 은 그
//     필드를 지운다. `null`(키 통째)은 모든 한도를 지운다.
//   - `monthlyUsd` 는 공개 단가 상당액(읽을 때 계산, 공급사 청구서가 아님)이라 도우미의
//     마지막 요청 모델에 단가가 있을 때만 켠다. 아니면 400 `team_ai_usd_limit_unavailable`
//     (`TEAM_AI_USD_LIMIT_UNAVAILABLE`). 지우기(`null`)는 늘 된다.
//   - `?include=team_ai_limits_status` 를 붙이면 계산된 읽기 `team_ai_limits_status` 가
//     같은 응답에 실린다(저장되지 않고, PATCH 할 수 없다). 붙이지 않으면 저장된 가방 그대로다.
//   - 서버 운영자의 env 상한(`TEAM_AI_DAILY_TOKEN_CAP`·`…_SEARCH_CAP`)은 **천장**이다:
//     워크스페이스 값과 상관없이 넘지 못한다. `operatorCeiling` 이 그 숫자를, `effective` 가
//     천장까지 따진 실제 한도를 말한다.
//
// 이 모듈에는 사용자 문구가 없다. 화면은 문구를 i18n 사전으로 넣는다.
// 읽기는 전부 총 함수다: 모양이 다르면 그 필드를 없는 것으로 읽고 던지지 않는다.
// =============================================================================

import { settingsRequest } from "./api";

export const TEAM_AI_LIMITS_KEY = "team_ai_limits";
export const TEAM_AI_LIMITS_STATUS_KEY = "team_ai_limits_status";
/** `?include=` 값. 붙여야 계산된 읽기가 온다. */
export const TEAM_AI_LIMITS_STATUS_INCLUDE = "team_ai_limits_status";
/** 금액 한도를 켤 수 없을 때 서버가 400 에 싣는 코드(`ApiError.code`). */
export const TEAM_AI_USD_LIMIT_UNAVAILABLE = "team_ai_usd_limit_unavailable";

/** 관리자가 정한 한도. 없는 필드 = 그 한도는 없다(선택값). */
export interface TeamAiLimits {
  /** UTC 하루 동안 쓸 수 있는 토큰(입력 + 출력). */
  dailyTokens?: number;
  /** UTC 하루 동안 할 수 있는 공급자 웹 검색 횟수. */
  dailySearches?: number;
  /** UTC 달력월 동안의 금액(공개 단가 상당액, 달러). */
  monthlyUsd?: number;
}

export type TeamAiLimitField = keyof TeamAiLimits;

/** 저장 요청의 한 필드: 숫자 = 켜기·바꾸기, `null` = 그 한도 지우기. 안 댄 필드는 그대로다. */
export type TeamAiLimitsChange = { [F in TeamAiLimitField]?: number | null };

/** 금액 한도를 켤 수 없는 까닭. */
export type MonthlyUsdUnavailableReason = "model_unpriced" | "no_usage_yet";

export interface TeamAiLimitsStatus {
  /** 관리자가 정한 것. 안 정한 한도는 `null`. */
  limits: {
    dailyTokens: number | null;
    dailySearches: number | null;
    monthlyUsd: number | null;
  };
  /**
   * 서버 운영자의 천장까지 따진 실제 한도(둘 중 낮은 값, 없으면 `null`). `0` 은 운영자의
   * 끔 스위치다(토큰은 도우미 전체, 검색은 웹 검색만).
   */
  effective: { dailyTokens: number | null; dailySearches: number | null };
  /** 서버 운영자가 env 로 건 천장. 없으면 `null`. 화면은 「서버 운영자가 하루 N까지로 제한했어요」를 말한다. */
  operatorCeiling: {
    dailyTokens: number | null;
    dailySearches: number | null;
    helperOff: boolean;
    searchOff: boolean;
  };
  usage: {
    /** 00:00 UTC 부터의 토큰(입력 + 출력). */
    todayTokens: number;
    todaySearches: number;
    /** 이번 달 단가가 있는 실행의 공개 단가 상당액(마이크로 달러). 청구서가 아니다. */
    monthCostMicroUsd: number;
    monthRuns: number;
    /** 단가 없는 모델로 한 실행(토큰에는 세고 금액에는 안 센다). */
    monthUnpricedRuns: number;
    /** 토큰이나 단가가 추정인 실행: 금액은 「이상」이다. */
    monthEstimatedRuns: number;
  };
  monthlyUsdAvailable: boolean;
  monthlyUsdUnavailableReason: MonthlyUsdUnavailableReason | null;
  /** 다음 00:00 UTC (한국 시간 오전 9시). 보는 사람의 시간으로 풀어 보인다. */
  dayResetsAtMs: number;
  /** 다음 달 1일 00:00 UTC. */
  monthResetsAtMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wholeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function positiveUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 가방에서 관리자가 정한 한도를 읽는다. 모양이 다른 필드는 없는 것이다(= 그 한도 없음). */
export function readTeamAiLimits(bag: unknown): TeamAiLimits {
  const raw = record(record(bag)?.[TEAM_AI_LIMITS_KEY]);
  if (raw === null) return {};
  const limits: TeamAiLimits = {};
  const dailyTokens = wholeCount(raw["dailyTokens"]);
  const dailySearches = wholeCount(raw["dailySearches"]);
  const monthlyUsd = positiveUsd(raw["monthlyUsd"]);
  if (dailyTokens !== null) limits.dailyTokens = dailyTokens;
  if (dailySearches !== null) limits.dailySearches = dailySearches;
  if (monthlyUsd !== null) limits.monthlyUsd = monthlyUsd;
  return limits;
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  const count = nonNegativeCount(value);
  return count === null ? undefined : count;
}

function nullableUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  const usd = positiveUsd(value);
  return usd === null ? undefined : usd;
}

/**
 * `?include=team_ai_limits_status` 로 받은 계산된 읽기. 없거나 한 조각이라도 모양이 다르면
 * `null` 이다 — 화면은 일부만 믿고 그리지 않는다(모르는 숫자를 지어내지 않는다).
 */
export function readTeamAiLimitsStatus(bag: unknown): TeamAiLimitsStatus | null {
  const raw = record(record(bag)?.[TEAM_AI_LIMITS_STATUS_KEY]);
  if (raw === null) return null;
  const limits = record(raw["limits"]);
  const effective = record(raw["effective"]);
  const ceiling = record(raw["operatorCeiling"]);
  const usage = record(raw["usage"]);
  if (limits === null || effective === null || ceiling === null || usage === null) return null;

  const limitTokens = nullableCount(limits["dailyTokens"]);
  const limitSearches = nullableCount(limits["dailySearches"]);
  const limitUsd = nullableUsd(limits["monthlyUsd"]);
  const effectiveTokens = nullableCount(effective["dailyTokens"]);
  const effectiveSearches = nullableCount(effective["dailySearches"]);
  const ceilingTokens = nullableCount(ceiling["dailyTokens"]);
  const ceilingSearches = nullableCount(ceiling["dailySearches"]);
  const todayTokens = nonNegativeCount(usage["todayTokens"]);
  const todaySearches = nonNegativeCount(usage["todaySearches"]);
  const monthCostMicroUsd = nonNegativeCount(usage["monthCostMicroUsd"]);
  const monthRuns = nonNegativeCount(usage["monthRuns"]);
  const monthUnpricedRuns = nonNegativeCount(usage["monthUnpricedRuns"]);
  const monthEstimatedRuns = nonNegativeCount(usage["monthEstimatedRuns"]);
  const dayResetsAtMs = nonNegativeCount(raw["dayResetsAtMs"]);
  const monthResetsAtMs = nonNegativeCount(raw["monthResetsAtMs"]);
  const reason = raw["monthlyUsdUnavailableReason"];
  if (
    limitTokens === undefined ||
    limitSearches === undefined ||
    limitUsd === undefined ||
    effectiveTokens === undefined ||
    effectiveSearches === undefined ||
    ceilingTokens === undefined ||
    ceilingSearches === undefined ||
    todayTokens === null ||
    todaySearches === null ||
    monthCostMicroUsd === null ||
    monthRuns === null ||
    monthUnpricedRuns === null ||
    monthEstimatedRuns === null ||
    dayResetsAtMs === null ||
    monthResetsAtMs === null ||
    typeof ceiling["helperOff"] !== "boolean" ||
    typeof ceiling["searchOff"] !== "boolean" ||
    typeof raw["monthlyUsdAvailable"] !== "boolean" ||
    !(reason === null || reason === "model_unpriced" || reason === "no_usage_yet")
  ) {
    return null;
  }
  return {
    limits: { dailyTokens: limitTokens, dailySearches: limitSearches, monthlyUsd: limitUsd },
    effective: { dailyTokens: effectiveTokens, dailySearches: effectiveSearches },
    operatorCeiling: {
      dailyTokens: ceilingTokens,
      dailySearches: ceilingSearches,
      helperOff: ceiling["helperOff"],
      searchOff: ceiling["searchOff"],
    },
    usage: {
      todayTokens,
      todaySearches,
      monthCostMicroUsd,
      monthRuns,
      monthUnpricedRuns,
      monthEstimatedRuns,
    },
    monthlyUsdAvailable: raw["monthlyUsdAvailable"],
    monthlyUsdUnavailableReason: reason,
    dayResetsAtMs,
    monthResetsAtMs,
  };
}

/**
 * 사용한 양이 한도의 몇 %인가(「오늘 62% 사용」). 한도에 닿기 전에는 100 이 되지 않도록
 * 내림하고, 닿았거나 넘으면 100 이다. 한도가 없거나 0 이하면 `null`.
 */
export function limitUsagePercent(used: number, limit: number | null): number | null {
  if (limit === null || !(limit > 0)) return null;
  if (used >= limit) return 100;
  return Math.max(0, Math.floor((used * 100) / limit));
}

/** 이번 달 금액 한도의 사용 %. 단가 상당액(마이크로 달러)을 달러 한도와 맞춘다. */
export function monthlyUsdPercent(status: TeamAiLimitsStatus): number | null {
  const limit = status.limits.monthlyUsd;
  return limit === null
    ? null
    : limitUsagePercent(status.usage.monthCostMicroUsd, Math.round(limit * 1_000_000));
}

/** 저장 요청의 본문. 이름을 댄 필드만 담는다(서버가 한 단계 아래로 병합한다). */
export function teamAiLimitsPatchBody(change: TeamAiLimitsChange): {
  [TEAM_AI_LIMITS_KEY]: TeamAiLimitsChange;
} {
  const named: TeamAiLimitsChange = {};
  for (const field of ["dailyTokens", "dailySearches", "monthlyUsd"] as const) {
    const value = change[field];
    if (value !== undefined) named[field] = value;
  }
  return { [TEAM_AI_LIMITS_KEY]: named };
}

function settingsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings?include=${TEAM_AI_LIMITS_STATUS_INCLUDE}`;
}

/** 운영자 전용 가방 + 계산된 한도 읽기. 운영자가 아니면 403 이다. */
export function fetchTeamAiLimitsBag(workspaceId: string): Promise<unknown> {
  return settingsRequest<unknown>(settingsPath(workspaceId));
}

/** 한도 저장. 응답은 저장된 가방 + 계산된 읽기다(`readTeamAiLimits`·`readTeamAiLimitsStatus`). */
export function saveTeamAiLimits(
  workspaceId: string,
  change: TeamAiLimitsChange
): Promise<unknown> {
  return settingsRequest<unknown>(settingsPath(workspaceId), {
    method: "PATCH",
    body: JSON.stringify(teamAiLimitsPatchBody(change)),
  });
}
