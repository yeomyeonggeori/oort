// =============================================================================
// 설정 › AI 「사용 한도」 화면의 판단과 문장 (#5026, #4944의 화면 몫, ADR-0201 증보 v3 B9).
//
// 서버 몫(`teamAiLimits.ts`)은 값의 모양과 읽기·저장만 한다. 이 파일은 그 위에서 웹·데스크탑·폰이
// **같은 판단을 한 곳에서** 받게 하는 화면 모델이다. 화면은 이 파일이 낸 값을 그리기만 한다:
//
//   * 행 셋(하루 토큰·하루 웹 검색·한 달 금액)과 각 행의 「켤 수 있는가·지울 수 있는가·입력 상한」.
//   * 입력 글자를 값으로 바꾸는 판정(`parseLimitInput`). **0은 한도가 아니다** — 서버도 400이고(B9-3),
//     끄기는 필드를 지우는 `null`이다. 이 판정과 `limitChange` 둘 다 0을 통과시키지 않는다.
//   * 서버 운영자의 천장(`operatorCeiling`)은 입력 상한이다. 천장을 넘는 값은 서버가 받아도 실제로는
//     걸리지 않으니(실효 한도 = 둘 중 낮은 값), 화면이 처음부터 받지 않는다.
//   * 사용량 줄: 「오늘 62% 사용」은 **천장까지 따진 실효 한도**(`effective`)로 잰다. 금액은 공개 단가로
//     읽을 때 계산한 값이라 「약 … 이상」 표지(ADR-0147 D3)와 청구서와 다를 수 있다는 안내가 따른다.
//   * 초기화 시각은 UTC 0시(한국 오전 9시)를 **보는 사람의 시간대**로 풀어 말한다.
//
// 문구는 i18n 사전(`settings.aiLimits.*`)에서만 나온다. 문장 조립이 필요한 곳은 호출자가 넘긴 언어
// 서비스(`LimitsLocale`)로 만든다: 시각은 서비스의 `formatTime`·`formatDate`(문맥의 시간대·시계 방식)로
// 짓고 그 결과를 문자열 인자로 넘긴다(ICU 시각 인자는 시계 방식을 따르지 않는 알려진 빈틈이 있다).
// 이 모듈에는 DOM·React·fetch가 없다.
// =============================================================================

import type { LocaleService } from "../../i18n/context";
import type { MessageKey } from "../../i18n/generated/messages";
import { ApiError } from "../../lib/api";
import {
  limitUsagePercent,
  monthlyUsdPercent,
  TEAM_AI_USD_LIMIT_UNAVAILABLE,
  type MonthlyUsdUnavailableReason,
  type TeamAiLimitField,
  type TeamAiLimitsChange,
  type TeamAiLimitsStatus,
} from "./teamAiLimits";

/** 화면의 행 순서. 서버 설정 키의 필드 이름 그대로다. */
export const TEAM_AI_LIMIT_FIELDS = [
  "dailyTokens",
  "dailySearches",
  "monthlyUsd",
] as const satisfies readonly TeamAiLimitField[];

/** 서버가 받는 개수의 최댓값(`workspace_settings.rs`, JSON 정수 1~10^12). */
export const LIMIT_COUNT_MAX = 1_000_000_000_000;
/** 서버가 받는 금액의 최댓값(달러). 최솟값은 소수 여섯 자리의 0.000001이다. */
export const LIMIT_USD_MAX = 1_000_000;

/** 한도 읽기·저장 쿼리 키. 스위치 쿼리(`teamAiSettingKey`)와 **같은 키를 쓰지 않는다**: 그쪽은 상태 없는 가방이다. */
export function teamAiLimitsQueryKey(workspaceId: string) {
  return ["settings", "team-ai-limits", workspaceId.toLowerCase()] as const;
}

// ---- 행 모델 -----------------------------------------------------------------------

/** 운영자가 이 한도를 쓰지 못하게 막았다: `helper_off` = 팀 AI 끔(토큰 0), `search_off` = 웹 검색 끔. */
export type LimitLock = "helper_off" | "search_off";

export interface LimitRow {
  field: TeamAiLimitField;
  /** 관리자가 저장해 둔 값. 없으면 `null`(제한 없음). */
  saved: number | null;
  /** 서버 운영자의 천장(개수 한도만, 금액은 천장이 없다). 없으면 `null`. */
  ceiling: number | null;
  /** 입력 상한: 천장이 있으면 천장, 없으면 서버가 받는 최댓값. */
  max: number;
  /** 입력칸이 띄울 키보드: 개수는 숫자판, 금액은 소수점이 있는 판. 화면이 낱말을 적지 않게 여기서 준다. */
  inputMode: "numeric" | "decimal";
  /** 운영자가 막았으면 어느 쪽인지. 막혔으면 값을 쓰거나 켜거나 지울 수 없다. */
  lock: LimitLock | null;
  /** 금액 한도를 켤 수 없는 까닭(금액 행만, 켤 수 있으면 `null`). */
  usdBlocker: MonthlyUsdUnavailableReason | null;
  /** 값을 쓸 수 있다(켜기·바꾸기). 운영자 잠금이나 금액 한도 불가면 `false`. */
  editable: boolean;
  /** 저장된 한도를 끌 수 있다(지우기는 단가를 몰라도 된다. 운영자 잠금이면 안 된다). */
  canClear: boolean;
  /** 저장된 금액 한도가 지금 걸리지 않는다(단가를 모르는 모델로 바뀌었다). */
  inactive: boolean;
}

function ceilingOf(status: TeamAiLimitsStatus, field: TeamAiLimitField): number | null {
  if (field === "dailyTokens") return status.operatorCeiling.dailyTokens;
  if (field === "dailySearches") return status.operatorCeiling.dailySearches;
  return null;
}

function lockOf(status: TeamAiLimitsStatus, field: TeamAiLimitField): LimitLock | null {
  if (status.operatorCeiling.helperOff) return "helper_off";
  if (field === "dailySearches" && status.operatorCeiling.searchOff) return "search_off";
  return null;
}

export function limitRows(status: TeamAiLimitsStatus): LimitRow[] {
  return TEAM_AI_LIMIT_FIELDS.map((field) => {
    const saved = status.limits[field];
    const ceiling = ceilingOf(status, field);
    const lock = lockOf(status, field);
    // 서버가 불가라고 하면서 까닭을 안 준 모양은 지어내지 않고 가장 흔한 까닭으로 읽는다(켤 수 없다는 사실은 같다).
    const usdBlocker: MonthlyUsdUnavailableReason | null =
      field === "monthlyUsd" && !status.monthlyUsdAvailable
        ? (status.monthlyUsdUnavailableReason ?? "model_unpriced")
        : null;
    return {
      field,
      saved,
      ceiling,
      max: ceiling ?? (field === "monthlyUsd" ? LIMIT_USD_MAX : LIMIT_COUNT_MAX),
      inputMode: field === "monthlyUsd" ? "decimal" : "numeric",
      lock,
      usdBlocker,
      editable: lock === null && usdBlocker === null,
      canClear: saved !== null && lock === null,
      inactive: usdBlocker !== null && saved !== null,
    };
  });
}

/**
 * 스위치를 누를 수 없는가. 켜진 한도는 지울 수 있을 때만 끄고, 꺼진 한도는 켤 수 있을 때만 켠다.
 * 쓰다 만 초안(켰지만 아직 저장하지 않음)은 늘 접을 수 있다 — 서버에 아무것도 없으니 막을 이유가 없다.
 */
export function limitSwitchDisabled(row: LimitRow, shownOn: boolean, draft: boolean): boolean {
  if (draft) return false;
  return shownOn ? !row.canClear : !row.editable;
}

// ---- 입력 판정 ----------------------------------------------------------------------

export type LimitInputError = "empty" | "invalid" | "zero" | "over_ceiling" | "too_large";

export type ParsedLimitInput =
  | { ok: true; value: number }
  | { ok: false; error: LimitInputError; max: number };

const COUNT_PATTERN = /^\d+$/;
const USD_PATTERN = /^\d+(?:\.\d{1,6})?$/;

/**
 * 입력 글자를 한도 값으로. 성공이면 **언제나 0보다 큰 값**이다.
 *
 * 천 단위 쉼표·공백은 지우고, 한글 입력기가 만드는 전각 숫자(「１２３」)는 반각으로 맞춘다. 개수는 정수만,
 * 금액은 소수 여섯 자리까지. 0·음수·지수 표기·글자는 값이 아니다. `ceiling` 이 있으면 그것이 상한이다.
 */
export function parseLimitInput(
  field: TeamAiLimitField,
  text: string,
  ceiling: number | null = null
): ParsedLimitInput {
  const hardMax = field === "monthlyUsd" ? LIMIT_USD_MAX : LIMIT_COUNT_MAX;
  const cleaned = text.normalize("NFKC").replace(/[\s,]/g, "");
  if (cleaned === "") return { ok: false, error: "empty", max: hardMax };
  const pattern = field === "monthlyUsd" ? USD_PATTERN : COUNT_PATTERN;
  if (!pattern.test(cleaned)) return { ok: false, error: "invalid", max: hardMax };
  const value = Number(cleaned);
  if (!(value > 0)) return { ok: false, error: "zero", max: hardMax };
  if (value > hardMax) return { ok: false, error: "too_large", max: hardMax };
  if (ceiling !== null && value > ceiling) {
    return { ok: false, error: "over_ceiling", max: ceiling };
  }
  return { ok: true, value };
}

/**
 * 저장 요청이 담을 변경 하나. 숫자는 켜기·바꾸기, `null` 은 그 한도 끄기다. **0은 만들지 않는다**:
 * 서버는 0을 400으로 거절하고, 끄기는 `0` 이 아니라 필드를 지우는 것이라서다. 입력 판정을 거친 값만
 * 오므로 여기서 던지는 것은 호출자의 버그다.
 */
export function limitChange(field: TeamAiLimitField, value: number | null): TeamAiLimitsChange {
  if (value !== null && !(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`team_ai_limits.${field}: a limit is a positive number, turn it off with null`);
  }
  return { [field]: value };
}

/** 한 번 저장한 입력칸의 글. 저장된 값이 없으면 빈 글이다. */
export function limitInputText(saved: number | null): string {
  return saved === null ? "" : String(saved);
}

// ---- 저장 실패 ----------------------------------------------------------------------

export type LimitSaveFailure = "forbidden" | "usd_unavailable" | "other";

/** 저장 실패를 화면이 답할 세 갈래로. 서버 문장을 그대로 보이지 않는다. */
export function limitSaveFailure(error: unknown): LimitSaveFailure {
  if (error instanceof ApiError) {
    if (error.status === 403) return "forbidden";
    if (error.status === 400 && error.code === TEAM_AI_USD_LIMIT_UNAVAILABLE) {
      return "usd_unavailable";
    }
  }
  return "other";
}

// ---- 문장 ---------------------------------------------------------------------------

/** 문장 조립에 필요한 언어 서비스의 일부. 화면은 설치된 서비스를 통째로 넘긴다. */
export type LimitsLocale = Pick<
  LocaleService,
  "formatMessage" | "formatNumber" | "formatTime" | "formatDate" | "formatCurrency" | "formatRelativeTime"
>;

export interface LimitRowCopy {
  /** 스위치의 이름. */
  label: string;
  /** 스위치 밑 설명(넘으면 무슨 일이 일어나는가). */
  hint: string;
  /** 값 입력칸의 접근성 이름. */
  valueLabel: string;
  /** 입력칸 옆 단위. */
  unit: string;
  /** 「오늘 62% 사용」. 비율을 잴 한도가 없으면 `null`. */
  headline: string | null;
  /** 「124,000 / 200,000 토큰」. 한도가 없으면 쓴 양만. 말할 숫자가 없으면 `null`. */
  detail: string | null;
  /** 「내일 오전 9:00에 새로 시작해요」. 걸린 한도가 없으면 `null`. */
  resets: string | null;
  /** 운영자 천장·끔·금액 불가·단가 모름 같은 안내. 순서가 의미다. */
  notes: readonly string[];
  /** 금액 행의 「공개 단가로 계산한 금액이에요…」. 다른 행은 `null`. */
  pricingNote: string | null;
}

const LABEL_KEY = {
  dailyTokens: "settings.aiLimits.tokensLabel",
  dailySearches: "settings.aiLimits.searchesLabel",
  monthlyUsd: "settings.aiLimits.usdLabel",
} as const satisfies Record<TeamAiLimitField, MessageKey>;

const HINT_KEY = {
  dailyTokens: "settings.aiLimits.stopHint",
  dailySearches: "settings.aiLimits.searchHint",
  monthlyUsd: "settings.aiLimits.stopHint",
} as const satisfies Record<TeamAiLimitField, MessageKey>;

const VALUE_LABEL_KEY = {
  dailyTokens: "settings.aiLimits.tokensValueLabel",
  dailySearches: "settings.aiLimits.searchesValueLabel",
  monthlyUsd: "settings.aiLimits.usdValueLabel",
} as const satisfies Record<TeamAiLimitField, MessageKey>;

const UNIT_KEY = {
  dailyTokens: "settings.aiLimits.tokensUnit",
  dailySearches: "settings.aiLimits.searchesUnit",
  monthlyUsd: "settings.aiLimits.usdUnit",
} as const satisfies Record<TeamAiLimitField, MessageKey>;

/** 다음 초기화 시각 한 줄. 이미 지난 시각(낡은 읽기)은 틀린 말이 되니 말하지 않는다. */
function resetLine(
  locale: LimitsLocale,
  atMs: number,
  nowMs: number,
  window: "day" | "month"
): string | null {
  if (!(atMs > nowMs)) return null;
  const time = locale.formatTime(atMs);
  if (window === "day") {
    const day = locale.formatRelativeTime(atMs, nowMs, "day");
    return locale.formatMessage("settings.aiLimits.resetsDay", { day, time });
  }
  const date = locale.formatDate(atMs, { month: "long", day: "numeric" });
  return locale.formatMessage("settings.aiLimits.resetsDate", { date, time });
}

function dollars(locale: LimitsLocale, microUsd: number): string {
  return locale.formatCurrency(microUsd / 1_000_000, "USD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function countCopy(
  row: LimitRow,
  status: TeamAiLimitsStatus,
  locale: LimitsLocale,
  nowMs: number
): Pick<LimitRowCopy, "headline" | "detail" | "resets" | "notes"> {
  const t = locale.formatMessage;
  const tokens = row.field === "dailyTokens";
  const used = tokens ? status.usage.todayTokens : status.usage.todaySearches;
  // 걸려 있는 한도: 관리자 값과 운영자 천장 중 낮은 쪽(서버가 계산한 `effective`). 0은 운영자의 끔 스위치다.
  const effective = tokens ? status.effective.dailyTokens : status.effective.dailySearches;
  const cap = effective !== null && effective > 0 ? effective : null;
  const percent = limitUsagePercent(used, cap);
  const notes: string[] = [];
  if (row.lock === "search_off") notes.push(t("settings.aiLimits.operatorSearchOff"));
  else if (row.ceiling !== null) {
    notes.push(
      t(tokens ? "settings.aiLimits.ceilingTokens" : "settings.aiLimits.ceilingSearches", {
        limit: row.ceiling,
      })
    );
  }
  return {
    headline: percent === null ? null : t("settings.aiLimits.usageToday", { percent }),
    detail:
      cap !== null
        ? t(tokens ? "settings.aiLimits.tokensOfLimit" : "settings.aiLimits.searchesOfLimit", {
            used,
            limit: cap,
          })
        : t(tokens ? "settings.aiLimits.tokensToday" : "settings.aiLimits.searchesToday", { used }),
    resets: cap !== null ? resetLine(locale, status.dayResetsAtMs, nowMs, "day") : null,
    notes,
  };
}

function usdCopy(
  row: LimitRow,
  status: TeamAiLimitsStatus,
  locale: LimitsLocale,
  nowMs: number
): Pick<LimitRowCopy, "headline" | "detail" | "resets" | "notes"> {
  const t = locale.formatMessage;
  const micro = status.usage.monthCostMicroUsd;
  // 단가를 모르는 실행은 금액에 안 들어가고, 토큰·단가가 추정인 실행이 있으면 금액은 「이상」이다.
  const approximate = status.usage.monthEstimatedRuns > 0 || status.usage.monthUnpricedRuns > 0;
  const spent = approximate
    ? t("settings.aiLimits.usdApprox", { amount: dollars(locale, micro) })
    : dollars(locale, micro);
  const notes: string[] = [];
  if (row.usdBlocker !== null) {
    notes.push(
      row.inactive
        ? t("settings.aiLimits.usdInactive")
        : t(
            row.usdBlocker === "no_usage_yet"
              ? "settings.aiLimits.usdNoUsageYet"
              : "settings.aiLimits.usdModelUnpriced"
          )
    );
  } else if (status.usage.monthUnpricedRuns > 0) {
    notes.push(t("settings.aiLimits.usdUnpricedRuns", { count: status.usage.monthUnpricedRuns }));
  }
  const limit = status.limits.monthlyUsd;
  if (limit === null) {
    // 단가를 모르는 채로는 말할 금액이 없다(전부 금액에서 빠진다). 아는 금액이 있을 때만 쓴 양을 말한다.
    const known = status.monthlyUsdAvailable || micro > 0;
    return {
      headline: null,
      detail: known ? t("settings.aiLimits.usdThisMonth", { spent }) : null,
      resets: null,
      notes,
    };
  }
  const percent = monthlyUsdPercent(status);
  return {
    headline: percent === null ? null : t("settings.aiLimits.usageMonth", { percent }),
    detail: t("settings.aiLimits.usdOfLimit", {
      spent,
      limit: dollars(locale, Math.round(limit * 1_000_000)),
    }),
    resets: resetLine(locale, status.monthResetsAtMs, nowMs, "month"),
    notes,
  };
}

/** 행 하나의 모든 문장. `nowMs` 는 호출자가 준다(시험이 고정하고, 화면은 `Date.now()`). */
export function limitRowCopy(
  row: LimitRow,
  status: TeamAiLimitsStatus,
  locale: LimitsLocale,
  nowMs: number
): LimitRowCopy {
  const t = locale.formatMessage;
  const body =
    row.field === "monthlyUsd"
      ? usdCopy(row, status, locale, nowMs)
      : countCopy(row, status, locale, nowMs);
  return {
    label: t(LABEL_KEY[row.field]),
    hint: t(HINT_KEY[row.field]),
    valueLabel: t(VALUE_LABEL_KEY[row.field]),
    unit: t(UNIT_KEY[row.field]),
    ...body,
    pricingNote: row.field === "monthlyUsd" ? t("settings.aiLimits.pricingNote") : null,
  };
}

/** 카드 맨 위 안내: 운영자가 팀 AI를 멈춰 뒀으면 어느 한도도 걸 수 없다. */
export function limitsHeaderNote(status: TeamAiLimitsStatus, locale: LimitsLocale): string | null {
  return status.operatorCeiling.helperOff ? locale.formatMessage("settings.aiLimits.operatorOff") : null;
}

/** 입력 판정 실패를 한 문장으로(무엇이 틀렸고 어떻게 적는지). */
export function limitInputErrorCopy(
  field: TeamAiLimitField,
  failure: Extract<ParsedLimitInput, { ok: false }>,
  locale: LimitsLocale
): string {
  const t = locale.formatMessage;
  switch (failure.error) {
    case "empty":
      return t("settings.aiLimits.errorEmpty");
    case "invalid":
      return t(
        field === "monthlyUsd"
          ? "settings.aiLimits.errorInvalidUsd"
          : "settings.aiLimits.errorInvalidCount"
      );
    case "zero":
      return t("settings.aiLimits.errorZero");
    case "over_ceiling":
      return t("settings.aiLimits.errorOverCeiling", { max: failure.max });
    case "too_large":
      return t("settings.aiLimits.errorTooLarge", { max: failure.max });
  }
}

/** 저장 실패의 문장. 금액 한도를 켤 수 없다는 답은 까닭을 다시 읽어 행의 안내가 말한다. */
export function limitSaveFailureCopy(kind: LimitSaveFailure, locale: LimitsLocale): string {
  const t = locale.formatMessage;
  if (kind === "forbidden") return t("settings.aiLimits.saveForbidden");
  if (kind === "usd_unavailable") return t("settings.aiLimits.usdUnavailableNow");
  return t("settings.aiLimits.saveFailed");
}
