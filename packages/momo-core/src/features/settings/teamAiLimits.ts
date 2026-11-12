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
//   - **Hermes에 맡기기**(ADR-0201 증보 v4 P7·P8, 서버 #5369·#5374)는 방향이 반대다. `dailyDelegations`
//     (1~200)가 없으면 「제한 없음」이 아니라 **기본 30**이고, 운영자 천장 `TEAM_AI_HERMES_DAILY_CAP`은
//     **비어 있으면 닫힘**이다. 계산된 읽기는 같은 객체에 위임 칸을 더해 「오늘 Hermes에 맡긴 횟수 4/30」과
//     「지금은 쓸 수 없어요」의 닫힌 낱말을 준다(`TeamAiDelegationStatus`). 이 칸을 모르는 옛 서버도 나머지
//     읽기는 그대로 되고, 위임 칸만 「모름 = 닫힘」으로 읽는다.
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

/** 관리자가 정한 한도. 없는 필드 = 그 한도는 없다(선택값). `dailyDelegations`만은 없으면 기본 30이다. */
export interface TeamAiLimits {
  /** UTC 하루 동안 쓸 수 있는 토큰(입력 + 출력). */
  dailyTokens?: number;
  /** UTC 하루 동안 할 수 있는 공급자 웹 검색 횟수. */
  dailySearches?: number;
  /** UTC 달력월 동안의 금액(공개 단가 상당액, 달러). */
  monthlyUsd?: number;
  /**
   * UTC 하루 동안 도우미가 팀 Hermes에 맡길 수 있는 횟수(1~200, 증보 v4 P7). **없으면 기본 30**이지 「제한
   * 없음」이 아니다. 지우기(`null`)는 기본 30으로 돌아가는 것이다. 운영자 천장이 그 위에 있다.
   */
  dailyDelegations?: number;
}

/**
 * 「사용 한도」 화면의 세 행(`teamAiLimitsView`): 없으면 「제한 없음」인 한도들이다. 하루 위임 횟수는 뜻이 달라
 * (없으면 기본 30, 지우면 기본으로 돌아감) 이 행 모델에 넣지 않는다 — 그 칸은 `TeamAiDelegationStatus`가 말한다.
 */
export type TeamAiLimitField = "dailyTokens" | "dailySearches" | "monthlyUsd";

/** 저장 요청이 이름을 댈 수 있는 필드: 세 행 + `dailyDelegations`. */
export type TeamAiLimitsChangeField = TeamAiLimitField | "dailyDelegations";

/**
 * 저장 요청의 한 필드: 숫자 = 켜기·바꾸기, `null` = 그 한도 지우기(`dailyDelegations`는 기본 30으로). 안 댄 필드는
 * 그대로다.
 */
export type TeamAiLimitsChange = { [F in TeamAiLimitsChangeField]?: number | null };

/** 금액 한도를 켤 수 없는 까닭. */
export type MonthlyUsdUnavailableReason = "model_unpriced" | "no_usage_yet";

/** 관리자가 정할 수 있는 하루 위임 횟수의 범위(서버 `workspace_settings.rs`, 증보 v4 P7). */
export const DAILY_DELEGATIONS_MIN = 1;
export const DAILY_DELEGATIONS_MAX = 200;
/** 관리자가 정하지 않았을 때 걸리는 하루 위임 횟수 **[추정]**(서버 `DEFAULT_TEAM_AI_DAILY_DELEGATIONS`). */
export const DAILY_DELEGATIONS_DEFAULT = 30;

/**
 * 「지금은 쓸 수 없어요」의 닫힌 낱말 — 서버 문(`team_ai_hermes::DoorClosed::word`) 중 워크스페이스 쪽 문(G3~G6)의
 * 낱말이다(P8). 문의 순서대로 처음 닫힌 하나가 온다.
 *
 *   hermes_not_connected  G3: 팀원 누구나 맡길 수 있는 Hermes가 없다(연결 안 됨·일시정지·개인 앱 표시·도우미 자신)
 *   hermes_ambiguous      G3: 그런 Hermes가 둘 이상이다
 *   tools_not_locked      G4: 운영자가 도구 잠금을 선언하지 않았다
 *   connection_mode       G4: 연결 모드(한 사람의 앱이 붙은 Hermes) 선언이 있다
 *   pin_unresolved        G5: 운영자 연결(env 링크·키)이 풀리지 않는다
 *   ceiling_unset         G6: 운영자 천장이 비었다(위임이 닫혀 있다)
 *   daily_cap             G6: 오늘 횟수를 다 썼다
 *
 * `unknown`은 **코어가 붙이는 낱말**이다: 서버가 위임 칸을 보내지 않았거나(옛 서버) 모양이 어긋났거나 모르는
 * 낱말을 보냈다. 화면은 그때도 「쓸 수 있다」고 말하지 않는다(닫힌 쪽).
 */
export const TEAM_AI_DELEGATION_CLOSED_WORDS = [
  "hermes_not_connected",
  "hermes_ambiguous",
  "tools_not_locked",
  "connection_mode",
  "pin_unresolved",
  "ceiling_unset",
  "daily_cap",
] as const;

export type TeamAiDelegationClosedWord = (typeof TEAM_AI_DELEGATION_CLOSED_WORDS)[number];

export type TeamAiDelegationUnavailableReason = TeamAiDelegationClosedWord | "unknown";

/**
 * Hermes에 맡기기의 계산된 읽기(증보 v4 P7·P8, #5374). 역할 스위치(G1)는 여기 없다: 같은 응답 가방의
 * `team_ai_roles.hermes`(`readTeamAiRoles`)가 말한다. 화면은 스위치가 켜져 있는데 `available`이 거짓이면
 * 「지금은 쓸 수 없어요」와 `unavailableReason`을 보인다(P10 「켠 채라도」).
 */
export interface TeamAiDelegationStatus {
  /** 서버가 위임 칸을 온전히 보냈는가. 거짓이면 아래 숫자는 `null`이고 `available`은 거짓이다(모름 = 닫힘). */
  known: boolean;
  /** 관리자가 정한 하루 횟수. `null` = 정하지 않음(기본 30이 걸린다) 또는 모름. */
  limit: number | null;
  /** 실제로 걸리는 하루 횟수: min(관리자 값 또는 30, 운영자 천장). **0 = 닫힘**. 모르면 `null`. */
  effective: number | null;
  /** 운영자 천장(양수). 없으면 `null` — 그때 `ceilingOff`가 참이다. */
  ceiling: number | null;
  /** 운영자 천장이 비었다(미설정·빈 값·0): 위임이 닫혀 있다. 모를 때도 참(닫힌 쪽)이다. */
  ceilingOff: boolean;
  /** 오늘(UTC) 맡긴 횟수(`called` 이상, 끝난 것 포함). 모르면 `null`. */
  today: number | null;
  /** 워크스페이스 쪽 문(G3~G6)이 모두 열려 있다. */
  available: boolean;
  /** 닫힌 까닭. 열려 있으면 `null`. */
  unavailableReason: TeamAiDelegationUnavailableReason | null;
}

/** 서버가 위임 칸을 보내지 않았을 때(옛 서버) — 모름이고 닫혀 있다. */
export const UNKNOWN_DELEGATION_STATUS: TeamAiDelegationStatus = Object.freeze({
  known: false,
  limit: null,
  effective: null,
  ceiling: null,
  ceilingOff: true,
  today: null,
  available: false,
  unavailableReason: "unknown",
});

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
  /**
   * Hermes에 맡기기(#5374). `readTeamAiLimitsStatus`는 **늘 채운다**: 서버가 보내지 않았으면(옛 서버)
   * `UNKNOWN_DELEGATION_STATUS`이고 나머지 읽기는 그대로다. 선택 칸인 것은 손으로 만든 상태(화면 시험의 고정
   * 값)가 그대로 맞게 하려는 것뿐이다 — 읽을 때는 `delegationOf`를 쓴다.
   */
  delegation?: TeamAiDelegationStatus;
}

/** 상태의 위임 칸. 칸이 없으면(손으로 만든 상태) 모름 = 닫힘이다. */
export function delegationOf(status: TeamAiLimitsStatus): TeamAiDelegationStatus {
  return status.delegation ?? UNKNOWN_DELEGATION_STATUS;
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

/** 서버 설정 문이 받는 값(1~200의 JSON 정수)만 하루 위임 횟수다. 그 밖은 없는 것(= 기본 30)이다. */
function dailyDelegationsOf(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DAILY_DELEGATIONS_MIN &&
    value <= DAILY_DELEGATIONS_MAX
    ? value
    : null;
}

/** 가방에서 관리자가 정한 한도를 읽는다. 모양이 다른 필드는 없는 것이다(= 그 한도 없음). */
export function readTeamAiLimits(bag: unknown): TeamAiLimits {
  const raw = record(record(bag)?.[TEAM_AI_LIMITS_KEY]);
  if (raw === null) return {};
  const limits: TeamAiLimits = {};
  const dailyTokens = wholeCount(raw["dailyTokens"]);
  const dailySearches = wholeCount(raw["dailySearches"]);
  const monthlyUsd = positiveUsd(raw["monthlyUsd"]);
  const dailyDelegations = dailyDelegationsOf(raw["dailyDelegations"]);
  if (dailyTokens !== null) limits.dailyTokens = dailyTokens;
  if (dailySearches !== null) limits.dailySearches = dailySearches;
  if (monthlyUsd !== null) limits.monthlyUsd = monthlyUsd;
  if (dailyDelegations !== null) limits.dailyDelegations = dailyDelegations;
  return limits;
}

/** 관리자 값이 실제로 걸리는 하루 위임 횟수(운영자 천장 전): 정한 값, 없으면 기본 30. */
export function delegationLimitOrDefault(limits: TeamAiLimits): number {
  return limits.dailyDelegations ?? DAILY_DELEGATIONS_DEFAULT;
}

const CLOSED_WORDS: ReadonlySet<string> = new Set(TEAM_AI_DELEGATION_CLOSED_WORDS);

/**
 * 계산된 읽기의 위임 칸을 읽는다(#5374). **한 묶음으로 믿는다**: 칸 하나라도 없거나 모양이 다르면 위임 전체가
 * 「모름 = 닫힘」(`UNKNOWN_DELEGATION_STATUS`)이고, 나머지 한도 읽기는 영향을 받지 않는다. 서로 어긋나는 칸
 * (열렸다면서 까닭이 있음, 닫혔다면서 까닭이 없음, 천장이 없다면서 닫힘 표지가 거짓)도 모양이 다른 것으로 본다.
 * 서버가 모르는 낱말을 보내면 그 낱말은 `unknown`이고 여전히 닫힘이다.
 */
function readDelegationStatus(
  raw: Record<string, unknown>,
  limits: Record<string, unknown>,
  effective: Record<string, unknown>,
  ceiling: Record<string, unknown>,
  usage: Record<string, unknown>
): TeamAiDelegationStatus {
  const limitRaw = limits["dailyDelegations"];
  const limit = limitRaw === null ? null : dailyDelegationsOf(limitRaw);
  const effectiveCap = nonNegativeCount(effective["dailyDelegations"]);
  const ceilingRaw = ceiling["dailyDelegations"];
  const ceilingCap = ceilingRaw === null ? null : wholeCount(ceilingRaw);
  const ceilingOff = ceiling["delegationOff"];
  const today = nonNegativeCount(usage["todayDelegations"]);
  const available = raw["delegationAvailable"];
  const reason = raw["delegationUnavailableReason"];
  if (
    (limitRaw !== null && limit === null) ||
    effectiveCap === null ||
    (ceilingRaw !== null && ceilingCap === null) ||
    typeof ceilingOff !== "boolean" ||
    ceilingOff !== (ceilingCap === null) ||
    // 천장이 없으면(닫힘) 실제 횟수는 0이고, 천장이 있으면 1 이상이다(min(1~200 또는 30, 양수 천장))
    ceilingOff !== (effectiveCap === 0) ||
    today === null ||
    typeof available !== "boolean" ||
    !(reason === null || typeof reason === "string") ||
    available !== (reason === null)
  ) {
    return UNKNOWN_DELEGATION_STATUS;
  }
  return {
    known: true,
    limit,
    effective: effectiveCap,
    ceiling: ceilingCap,
    ceilingOff,
    today,
    available,
    unavailableReason:
      reason === null
        ? null
        : CLOSED_WORDS.has(reason)
          ? (reason as TeamAiDelegationClosedWord)
          : "unknown",
  };
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
    delegation: readDelegationStatus(raw, limits, effective, ceiling, usage),
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

/**
 * 저장 요청의 본문. 이름을 댄 필드만 담는다(서버가 한 단계 아래로 병합한다). `dailyDelegations: null`은 그 값을
 * 지워 기본 30으로 돌린다(「제한 없음」이 아니다).
 */
export function teamAiLimitsPatchBody(change: TeamAiLimitsChange): {
  [TEAM_AI_LIMITS_KEY]: TeamAiLimitsChange;
} {
  const named: TeamAiLimitsChange = {};
  for (const field of ["dailyTokens", "dailySearches", "monthlyUsd", "dailyDelegations"] as const) {
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
