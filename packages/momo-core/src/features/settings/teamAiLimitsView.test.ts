import { describe, expect, it } from "vitest";
import { createLocaleService, type LocaleService } from "../../i18n/context";
import { catalog as en } from "../../i18n/generated/en-US";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { resolveLocaleContext } from "../../i18n/locale";
import { ApiError } from "../../lib/api";
import {
  LIMIT_COUNT_MAX,
  LIMIT_USD_MAX,
  limitChange,
  limitInputErrorCopy,
  limitInputText,
  limitRowCopy,
  limitRows,
  limitSaveFailure,
  limitSaveFailureCopy,
  limitSwitchDisabled,
  limitsHeaderNote,
  parseLimitInput,
  teamAiLimitsQueryKey,
  type LimitRow,
} from "./teamAiLimitsView";
import {
  TEAM_AI_USD_LIMIT_UNAVAILABLE,
  teamAiLimitsPatchBody,
  type TeamAiLimitsStatus,
} from "./teamAiLimits";

// 서버 `limits_status_in_tx` 가 내는 모양 그대로(openapi `TeamAiLimitsStatus`)에서 시험마다 한 조각만 바꾼다.
function status(over: Partial<TeamAiLimitsStatus> = {}): TeamAiLimitsStatus {
  return {
    limits: { dailyTokens: null, dailySearches: null, monthlyUsd: null },
    effective: { dailyTokens: null, dailySearches: null },
    operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: false, searchOff: false },
    usage: {
      todayTokens: 124_000,
      todaySearches: 3,
      monthCostMicroUsd: 12_500_000,
      monthRuns: 40,
      monthUnpricedRuns: 0,
      monthEstimatedRuns: 0,
    },
    monthlyUsdAvailable: true,
    monthlyUsdUnavailableReason: null,
    dayResetsAtMs: Date.UTC(2026, 10, 1, 0, 0),
    monthResetsAtMs: Date.UTC(2026, 10, 1, 0, 0),
    ...over,
  };
}

function rowOf(s: TeamAiLimitsStatus, field: LimitRow["field"]): LimitRow {
  const row = limitRows(s).find((candidate) => candidate.field === field);
  if (row === undefined) throw new Error(`no row ${field}`);
  return row;
}

// 24시간제로 고정한다: 오전·오후 글자는 ICU(CLDR) 판마다 다르다(Node 24는 한국어를 「AM」으로 낸다). 이 시험이 재는 것은
// 시간대와 날의 계산이고, 시계 글자는 서비스(`formatTime`)가 문맥의 시계 방식으로 짓는 것을 그대로 믿는다.
function locale(language: "ko-KR" | "en-US", timeZone: string): LocaleService {
  return createLocaleService({
    ...resolveLocaleContext(language, { languages: [language], timeZone, hourCycle: "h23" }),
    catalog: language === "ko-KR" ? ko : en,
  });
}

const SEOUL = locale("ko-KR", "Asia/Seoul");
// 한국 시간 2026-10-31 12:00. 다음 00:00 UTC(= 11월 1일 오전 9시)는 내일이다.
const NOW = Date.UTC(2026, 9, 31, 3, 0);

describe("행 모델: 기본은 제한 없음, 운영자 천장과 끔은 입력을 막는다", () => {
  it("아무것도 안 켠 기본: 세 행이 모두 꺼져 있고 켤 수 있다", () => {
    const rows = limitRows(status());
    expect(rows.map((row) => row.field)).toEqual(["dailyTokens", "dailySearches", "monthlyUsd"]);
    for (const row of rows) {
      expect(row.saved).toBeNull();
      expect(row.editable).toBe(true);
      expect(row.canClear).toBe(false);
      expect(row.lock).toBeNull();
    }
    expect(rowOf(status(), "dailyTokens").max).toBe(LIMIT_COUNT_MAX);
    expect(rowOf(status(), "monthlyUsd").max).toBe(LIMIT_USD_MAX);
    // 키보드: 개수는 숫자판, 금액만 소수점이 있는 판.
    expect(limitRows(status()).map((row) => row.inputMode)).toEqual(["numeric", "numeric", "decimal"]);
  });

  it("운영자 천장은 그 행의 입력 상한이다(금액 행은 천장이 없다)", () => {
    const s = status({
      operatorCeiling: { dailyTokens: 200_000, dailySearches: 50, helperOff: false, searchOff: false },
    });
    expect(rowOf(s, "dailyTokens")).toMatchObject({ ceiling: 200_000, max: 200_000 });
    expect(rowOf(s, "dailySearches")).toMatchObject({ ceiling: 50, max: 50 });
    expect(rowOf(s, "monthlyUsd")).toMatchObject({ ceiling: null, max: LIMIT_USD_MAX });
  });

  it("운영자가 팀 AI를 끄면 세 행이 모두 잠기고, 웹 검색만 끄면 그 행만 잠긴다", () => {
    const helperOff = status({
      limits: { dailyTokens: 100_000, dailySearches: null, monthlyUsd: null },
      operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: true, searchOff: false },
    });
    for (const row of limitRows(helperOff)) {
      expect(row.lock).toBe("helper_off");
      expect(row.editable).toBe(false);
      expect(row.canClear).toBe(false);
    }
    const searchOff = status({
      operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: false, searchOff: true },
    });
    expect(rowOf(searchOff, "dailySearches")).toMatchObject({ lock: "search_off", editable: false });
    expect(rowOf(searchOff, "dailyTokens")).toMatchObject({ lock: null, editable: true });
    expect(rowOf(searchOff, "monthlyUsd")).toMatchObject({ lock: null, editable: true });
  });

  it("금액 한도를 켤 수 없으면 켜기만 막고, 저장돼 있으면 끌 수는 있고 걸리지 않는다고 말한다", () => {
    const blocked = status({ monthlyUsdAvailable: false, monthlyUsdUnavailableReason: "model_unpriced" });
    expect(rowOf(blocked, "monthlyUsd")).toMatchObject({
      usdBlocker: "model_unpriced",
      editable: false,
      canClear: false,
      inactive: false,
    });
    const saved = status({
      limits: { dailyTokens: null, dailySearches: null, monthlyUsd: 20 },
      monthlyUsdAvailable: false,
      monthlyUsdUnavailableReason: "model_unpriced",
    });
    expect(rowOf(saved, "monthlyUsd")).toMatchObject({ editable: false, canClear: true, inactive: true });
    // 까닭을 안 준 불가는 지어내지 않고 가장 흔한 까닭으로 읽는다.
    expect(
      rowOf(status({ monthlyUsdAvailable: false, monthlyUsdUnavailableReason: null }), "monthlyUsd").usdBlocker
    ).toBe("model_unpriced");
  });

  it("스위치: 켜진 한도는 지울 수 있을 때만 끄고, 꺼진 한도는 켤 수 있을 때만 켜며, 초안은 늘 접는다", () => {
    const base = rowOf(status(), "dailyTokens");
    expect(limitSwitchDisabled(base, false, false)).toBe(false);
    expect(limitSwitchDisabled(base, true, true)).toBe(false);
    expect(limitSwitchDisabled({ ...base, saved: 5, canClear: true }, true, false)).toBe(false);
    expect(limitSwitchDisabled({ ...base, saved: 5, canClear: false }, true, false)).toBe(true);
    expect(limitSwitchDisabled({ ...base, editable: false }, false, false)).toBe(true);
    expect(limitSwitchDisabled({ ...base, editable: false }, true, true)).toBe(false);
  });

  it("쿼리 키는 스위치 쿼리와 겹치지 않고 워크스페이스 id 를 소문자로 맞춘다", () => {
    expect(teamAiLimitsQueryKey("ABC-1")).toEqual(["settings", "team-ai-limits", "abc-1"]);
  });
});

describe("입력 판정: 0은 한도가 아니고 천장은 상한이다", () => {
  it("개수: 정수만 받고 쉼표·공백·전각 숫자는 맞춘다", () => {
    expect(parseLimitInput("dailyTokens", "200000")).toEqual({ ok: true, value: 200_000 });
    expect(parseLimitInput("dailyTokens", " 200,000 ")).toEqual({ ok: true, value: 200_000 });
    expect(parseLimitInput("dailySearches", "５０")).toEqual({ ok: true, value: 50 });
    expect(parseLimitInput("dailyTokens", "007")).toEqual({ ok: true, value: 7 });
    for (const text of ["1.5", "-3", "1e5", "abc", "12개", "٣"]) {
      expect(parseLimitInput("dailyTokens", text)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(parseLimitInput("dailyTokens", "   ")).toMatchObject({ ok: false, error: "empty" });
  });

  it("0은 값이 아니다: 0·00·0.0 은 어느 행에서도 거절한다", () => {
    for (const text of ["0", "00", "0,0"]) {
      expect(parseLimitInput("dailyTokens", text)).toMatchObject({ ok: false, error: "zero" });
    }
    for (const text of ["0", "0.0", "0.000000"]) {
      expect(parseLimitInput("monthlyUsd", text)).toMatchObject({ ok: false, error: "zero" });
    }
  });

  it("금액: 소수 여섯 자리까지, 그보다 잘게는 값이 아니다", () => {
    expect(parseLimitInput("monthlyUsd", "20")).toEqual({ ok: true, value: 20 });
    expect(parseLimitInput("monthlyUsd", "12.5")).toEqual({ ok: true, value: 12.5 });
    expect(parseLimitInput("monthlyUsd", "0.000001")).toEqual({ ok: true, value: 0.000001 });
    expect(parseLimitInput("monthlyUsd", "0.0000001")).toMatchObject({ ok: false, error: "invalid" });
    expect(parseLimitInput("monthlyUsd", "$20")).toMatchObject({ ok: false, error: "invalid" });
  });

  it("서버가 받는 최댓값을 넘으면 거절한다(개수 10^12, 금액 1,000,000)", () => {
    expect(parseLimitInput("dailyTokens", String(LIMIT_COUNT_MAX))).toMatchObject({ ok: true });
    expect(parseLimitInput("dailyTokens", String(LIMIT_COUNT_MAX + 1))).toEqual({
      ok: false,
      error: "too_large",
      max: LIMIT_COUNT_MAX,
    });
    expect(parseLimitInput("dailyTokens", "99999999999999999999999")).toMatchObject({ error: "too_large" });
    expect(parseLimitInput("monthlyUsd", "1000000")).toMatchObject({ ok: true });
    expect(parseLimitInput("monthlyUsd", "1000000.01")).toMatchObject({ error: "too_large", max: LIMIT_USD_MAX });
  });

  it("운영자 천장이 있으면 천장이 상한이다: 넘는 값은 거절하고 천장 그대로는 받는다", () => {
    expect(parseLimitInput("dailyTokens", "200000", 200_000)).toEqual({ ok: true, value: 200_000 });
    expect(parseLimitInput("dailyTokens", "200001", 200_000)).toEqual({
      ok: false,
      error: "over_ceiling",
      max: 200_000,
    });
    expect(parseLimitInput("dailySearches", "51", 50)).toMatchObject({ error: "over_ceiling", max: 50 });
    // 천장이 없으면 같은 값이 통과한다: 거절은 천장 때문이다.
    expect(parseLimitInput("dailyTokens", "200001")).toEqual({ ok: true, value: 200_001 });
  });
});

describe("저장 요청: 끄기는 null, 0은 보내지 않는다", () => {
  it("켜기·바꾸기는 숫자, 끄기는 null 하나만 담는다", () => {
    expect(limitChange("dailyTokens", 100_000)).toEqual({ dailyTokens: 100_000 });
    expect(limitChange("monthlyUsd", 12.5)).toEqual({ monthlyUsd: 12.5 });
    expect(teamAiLimitsPatchBody(limitChange("dailySearches", null))).toEqual({
      team_ai_limits: { dailySearches: null },
    });
    expect(JSON.stringify(teamAiLimitsPatchBody(limitChange("dailyTokens", null)))).not.toContain("0");
  });

  it("0·음수·NaN 은 요청으로 만들지 않는다", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => limitChange("dailyTokens", value)).toThrow(RangeError);
    }
  });

  it("입력칸 글은 저장된 값이거나 빈 글이다", () => {
    expect(limitInputText(null)).toBe("");
    expect(limitInputText(200_000)).toBe("200000");
  });

  it("저장 실패: 403 은 권한, 400 금액 불가는 코드로, 나머지는 일반 실패", () => {
    expect(limitSaveFailure(new ApiError(403, "forbidden"))).toBe("forbidden");
    expect(limitSaveFailure(new ApiError(400, "no price", TEAM_AI_USD_LIMIT_UNAVAILABLE))).toBe("usd_unavailable");
    expect(limitSaveFailure(new ApiError(400, "no price"))).toBe("other");
    expect(limitSaveFailure(new ApiError(500, "boom"))).toBe("other");
    expect(limitSaveFailure(new TypeError("network"))).toBe("other");
  });
});

describe("문장 (ko, 한국 시간)", () => {
  const ON = status({
    limits: { dailyTokens: 500_000, dailySearches: null, monthlyUsd: 20 },
    effective: { dailyTokens: 200_000, dailySearches: null },
    operatorCeiling: { dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false },
  });

  it("「오늘 62% 사용」은 관리자 값이 아니라 천장까지 따진 실효 한도로 잰다", () => {
    const copy = limitRowCopy(rowOf(ON, "dailyTokens"), ON, SEOUL, NOW);
    expect(copy.headline).toBe("오늘 62% 사용");
    expect(copy.detail).toBe("124,000 / 200,000 토큰");
    expect(copy.notes).toEqual(["서버 운영자가 하루 200,000토큰까지로 제한했어요."]);
    expect(copy.label).toBe("하루 토큰 한도");
    expect(copy.unit).toBe("토큰");
  });

  it("초기화 시각은 UTC 0시를 보는 사람의 시간으로 푼다: 한국이면 내일 9시", () => {
    const copy = limitRowCopy(rowOf(ON, "dailyTokens"), ON, SEOUL, NOW);
    expect(copy.resets).toBe("내일 09:00에 새로 시작해요");
    // 같은 순간을 미국 서부에서 보면 시각이 다르다(같은 UTC 0시가 오후 5시).
    const la = locale("en-US", "America/Los_Angeles");
    expect(limitRowCopy(rowOf(ON, "dailyTokens"), ON, la, NOW).resets).toBe("Starts over tomorrow at 17:00");
    // 그 시각 이전이 되도록 시계를 옮기면 같은 날이다.
    expect(limitRowCopy(rowOf(ON, "dailyTokens"), ON, la, Date.UTC(2026, 9, 31, 20, 0)).resets).toBe(
      "Starts over today at 17:00"
    );
  });

  it("이미 지난 초기화 시각은 말하지 않는다(낡은 읽기가 틀린 날짜를 말하지 않게)", () => {
    const stale = status({ ...ON, dayResetsAtMs: NOW - 1 });
    expect(limitRowCopy(rowOf(stale, "dailyTokens"), stale, SEOUL, NOW).resets).toBeNull();
  });

  it("한도가 없으면 비율도 초기화도 없고 쓴 양만 말한다", () => {
    const none = status();
    const tokens = limitRowCopy(rowOf(none, "dailyTokens"), none, SEOUL, NOW);
    expect(tokens).toMatchObject({
      headline: null,
      detail: "오늘 124,000 토큰 사용",
      resets: null,
      notes: [],
    });
    expect(limitRowCopy(rowOf(none, "dailySearches"), none, SEOUL, NOW).detail).toBe("오늘 웹 검색 3회");
  });

  it("관리자 값 없이 운영자 천장만 있어도 그 천장에 대한 사용 비율을 말한다", () => {
    const ceilingOnly = status({
      effective: { dailyTokens: 200_000, dailySearches: null },
      operatorCeiling: { dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false },
    });
    const copy = limitRowCopy(rowOf(ceilingOnly, "dailyTokens"), ceilingOnly, SEOUL, NOW);
    expect(copy.headline).toBe("오늘 62% 사용");
    expect(copy.notes).toHaveLength(1);
  });

  it("웹 검색: 실효 한도·천장 문장·검색 끔 문장", () => {
    const s = status({
      limits: { dailyTokens: null, dailySearches: 50, monthlyUsd: null },
      effective: { dailyTokens: null, dailySearches: 50 },
      operatorCeiling: { dailyTokens: null, dailySearches: 50, helperOff: false, searchOff: false },
    });
    const copy = limitRowCopy(rowOf(s, "dailySearches"), s, SEOUL, NOW);
    expect(copy.headline).toBe("오늘 6% 사용");
    expect(copy.detail).toBe("3 / 50회");
    expect(copy.notes).toEqual(["서버 운영자가 하루 50회까지로 제한했어요."]);
    expect(copy.hint).toBe("넘으면 새로 시작할 때까지 도우미가 웹 검색 없이 답해요.");
    const off = status({
      effective: { dailyTokens: null, dailySearches: 0 },
      operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: false, searchOff: true },
    });
    const offCopy = limitRowCopy(rowOf(off, "dailySearches"), off, SEOUL, NOW);
    expect(offCopy.notes).toEqual(["서버 운영자가 웹 검색을 꺼 뒀어요."]);
    expect(offCopy.headline).toBeNull();
  });

  it("운영자가 팀 AI를 멈추면 카드 위 안내 한 줄이 서고, 아니면 없다", () => {
    const off = status({
      effective: { dailyTokens: 0, dailySearches: null },
      operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: true, searchOff: false },
    });
    expect(limitsHeaderNote(off, SEOUL)).toBe("서버 운영자가 팀 AI를 멈춰 뒀어요.");
    expect(limitsHeaderNote(status(), SEOUL)).toBeNull();
    // 실효 한도 0은 비율을 재지 않는다(0으로 나누지 않는다).
    expect(limitRowCopy(rowOf(off, "dailyTokens"), off, SEOUL, NOW).headline).toBeNull();
  });

  it("금액: 사용 비율, 공개 단가 안내, 한 달 초기화", () => {
    const copy = limitRowCopy(rowOf(ON, "monthlyUsd"), ON, SEOUL, NOW);
    expect(copy.headline).toBe("이번 달 62% 사용");
    expect(copy.detail).toBe("US$12.50 / US$20.00");
    expect(copy.pricingNote).toBe("공개 단가로 계산한 금액이에요. 공급사 청구서와 다를 수 있어요.");
    expect(copy.resets).toBe("11월 1일 09:00에 새로 시작해요");
    expect(copy.notes).toEqual([]);
    expect(limitRowCopy(rowOf(ON, "dailyTokens"), ON, SEOUL, NOW).pricingNote).toBeNull();
  });

  it("금액은 추정이나 단가 없는 실행이 있으면 「약 … 이상」이고, 단가 없는 실행 수를 말한다", () => {
    const approx = status({
      limits: { dailyTokens: null, dailySearches: null, monthlyUsd: 20 },
      usage: { ...status().usage, monthEstimatedRuns: 1, monthUnpricedRuns: 2 },
    });
    const copy = limitRowCopy(rowOf(approx, "monthlyUsd"), approx, SEOUL, NOW);
    expect(copy.detail).toBe("약 US$12.50 이상 / US$20.00");
    expect(copy.notes).toEqual(["단가를 모르는 모델로 한 요청 2건은 금액에 넣지 않았어요."]);
    const noLimit = status({ usage: { ...status().usage, monthEstimatedRuns: 1 } });
    expect(limitRowCopy(rowOf(noLimit, "monthlyUsd"), noLimit, SEOUL, NOW).detail).toBe("이번 달 약 US$12.50 이상");
  });

  it("금액 한도를 켤 수 없는 두 까닭과, 저장된 한도가 걸리지 않을 때의 경고", () => {
    const unpriced = status({
      monthlyUsdAvailable: false,
      monthlyUsdUnavailableReason: "model_unpriced",
      usage: { ...status().usage, monthCostMicroUsd: 0, monthRuns: 4, monthUnpricedRuns: 4 },
    });
    const a = limitRowCopy(rowOf(unpriced, "monthlyUsd"), unpriced, SEOUL, NOW);
    expect(a.notes).toEqual(["지금 쓰는 모델의 단가를 몰라 금액 한도를 켤 수 없어요. 토큰 한도를 써 보세요."]);
    // 아는 금액이 없으면 쓴 양을 지어내지 않는다.
    expect(a.detail).toBeNull();
    const none = status({
      monthlyUsdAvailable: false,
      monthlyUsdUnavailableReason: "no_usage_yet",
      usage: { ...status().usage, monthCostMicroUsd: 0, monthRuns: 0 },
    });
    expect(limitRowCopy(rowOf(none, "monthlyUsd"), none, SEOUL, NOW).notes).toEqual([
      "도우미가 한 번 답한 뒤에 켤 수 있어요.",
    ]);
    const inactive = status({
      limits: { dailyTokens: null, dailySearches: null, monthlyUsd: 20 },
      monthlyUsdAvailable: false,
      monthlyUsdUnavailableReason: "model_unpriced",
    });
    expect(limitRowCopy(rowOf(inactive, "monthlyUsd"), inactive, SEOUL, NOW).notes).toEqual([
      "지금 쓰는 모델의 단가를 몰라 이 금액 한도는 걸리지 않아요. 토큰 한도를 함께 써 보세요.",
    ]);
  });

  it("입력 실패와 저장 실패는 서버 문장이 아니라 사전의 한 문장이다", () => {
    const fail = (error: string, max = 0) =>
      ({ ok: false, error, max }) as Extract<ReturnType<typeof parseLimitInput>, { ok: false }>;
    expect(limitInputErrorCopy("dailyTokens", fail("zero"), SEOUL)).toBe(
      "0은 한도로 쓸 수 없어요. 한도를 없애려면 스위치를 꺼 주세요."
    );
    expect(limitInputErrorCopy("dailyTokens", fail("over_ceiling", 200_000), SEOUL)).toBe(
      "서버 운영자가 정한 200,000까지만 적을 수 있어요."
    );
    expect(limitInputErrorCopy("monthlyUsd", fail("invalid"), SEOUL)).toContain("소수 여섯 자리");
    expect(limitInputErrorCopy("dailySearches", fail("invalid"), SEOUL)).toBe("1 이상의 정수로 적어 주세요.");
    expect(limitSaveFailureCopy("forbidden", SEOUL)).toBe("소유자나 관리자만 한도를 바꿀 수 있어요.");
    expect(limitSaveFailureCopy("usd_unavailable", SEOUL)).toBe("지금은 금액 한도를 켤 수 없어요.");
    expect(limitSaveFailureCopy("other", SEOUL)).toBe("한도를 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
  });
});

describe("문장 (en)", () => {
  const US = locale("en-US", "UTC");

  it("같은 모델에서 영어 사전이 같은 값을 말한다", () => {
    const s = status({
      limits: { dailyTokens: 500_000, dailySearches: null, monthlyUsd: 20 },
      effective: { dailyTokens: 200_000, dailySearches: null },
      usage: { ...status().usage, monthUnpricedRuns: 1 },
    });
    const copy = limitRowCopy(rowOf(s, "dailyTokens"), s, US, NOW);
    expect(copy.headline).toBe("62% used today");
    expect(copy.detail).toBe("124,000 of 200,000 tokens");
    const usd = limitRowCopy(rowOf(s, "monthlyUsd"), s, US, NOW);
    expect(usd.detail).toBe("About $12.50 or more of $20.00");
    expect(usd.notes).toEqual([
      "1 request on a model with no known price is not counted in the amount.",
    ]);
  });
});
