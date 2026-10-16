import type { LimitsCompany, ProviderCompanyLimits, ProviderLimits } from "./api";
import type { TeamProbeDetail } from "./teamKeyForm";

// =============================================================================
// 「한도·남은 크레딧」 블록의 문장과 숫자 (#3886, ADR-0147 증보 2026-10-16).
//
// 두 출처를 **섞지 않는다**:
//   · 공급사가 알려 준 숫자: 확인 호출이 키로 직접 읽은 것(한도 헤더, OpenRouter 크레딧).
//   · oort 추정: 이 워크스페이스의 사용 기록(토큰 × 단가표)과 운영자가 적은 월 크레딧.
//     공급사가 밝힌 잔액이 아니다. 그래서 라벨에 「추정」이 붙고 「남은 크레딧」이라고 쓰지 않는다
//     (「남은 양(추정)」).
// Anthropic·OpenAI는 일반 API 키로 읽는 잔액 API가 없다(콘솔 전용). 읽을 수 없는 것은 읽을 수
// 없다고 말하고, 지어내지 않는다.
// =============================================================================

/** 확인 주소의 호스트로 회사를 안다. 모르는 주소(사내 프록시 등)는 null: 추정 없이 읽은 숫자만. */
export function limitsCompanyOf(baseUrl: string): LimitsCompany | null {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "api.openai.com") return "openai";
  if (host === "api.x.ai") return "xai";
  if (host === "openrouter.ai") return "openrouter";
  return null;
}

export interface ConsoleLink {
  readonly label: string;
  readonly url: string;
}

/** 정확한 잔액을 보는 곳. 주소는 공급사 문서가 가리키는 결제 화면이다. */
export const CONSOLE_BILLING: Readonly<Record<LimitsCompany, ConsoleLink>> = {
  anthropic: { label: "Anthropic 콘솔에서 크레딧 보기", url: "https://platform.claude.com/settings/billing" },
  openai: { label: "OpenAI 결제 화면 열기", url: "https://platform.openai.com/settings/organization/billing/overview" },
  xai: { label: "xAI 콘솔 열기", url: "https://console.x.ai" },
  openrouter: { label: "OpenRouter 크레딧 보기", url: "https://openrouter.ai/settings/credits" },
};

/** 회사 이름. 「Anthropic 전체」처럼 숫자의 범위를 말할 때 쓴다. */
export const COMPANY_LABEL: Readonly<Record<LimitsCompany, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
};

/** 월 크레딧 칸의 안내. 구독 크레딧 예시는 구독이 있는 회사에만 붙는다. */
export function budgetHint(company: LimitsCompany): string {
  return company === "anthropic"
    ? "구독으로 받는 월 API 크레딧을 적어요(예: Max 5x는 월 $100). UTC 달력 기준 한 달 단위로 계산해요."
    : "이번 달 쓰기로 한 한도를 적어요. UTC 달력 기준 한 달 단위로 계산해요.";
}

const MICRO = 1_000_000;

/** 「$12.35」. micro-USD를 받는다. */
export function usdFromMicro(micro: number): string {
  return `$${(micro / MICRO).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

/** 폼 칸의 달러 입력. 빈 칸은 null(지움), 잘못된 값은 undefined. */
export function parseBudgetUsd(raw: string): number | null | undefined {
  const text = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value <= 1_000_000 ? value : undefined;
}

export const BUDGET_INPUT_ERROR = "0에서 1,000,000 사이의 달러 금액(소수 둘째 자리까지)으로 적어 주세요.";

export interface LimitsLine {
  readonly label: string;
  readonly value: string;
}

export interface LimitsBlock {
  /** 공급사가 알려 준 숫자. 비면 「받지 못했어요」 문장이 대신 선다. */
  readonly provider: {
    readonly lines: readonly LimitsLine[];
    readonly note: string | null;
  };
  /** oort 추정. 회사를 모르면 null(사내 프록시 등: 추정 근거가 없다). */
  readonly estimate: null | {
    readonly lines: readonly LimitsLine[];
    /** 0~1. 월 크레딧을 적었을 때만. */
    readonly usedRatio: number | null;
    readonly over: boolean;
    readonly hint: string | null;
    readonly unpriced: string | null;
    readonly budgetUsd: number | null;
  };
  readonly company: LimitsCompany | null;
  readonly console: ConsoleLink | null;
}

/** 한도 헤더에 기간이 실려 오지 않아서 「분당」 같은 말을 붙이지 않는다(teamKeyForm 주석과 같다). */
function rateLines(detail: TeamProbeDetail | null): LimitsLine[] {
  const out: LimitsLine[] = [];
  if (!detail) return out;
  if (detail.requestsLimit !== undefined) {
    out.push({
      label: "요청 한도",
      value:
        detail.requestsRemaining !== undefined
          ? `${count(detail.requestsLimit)} 중 ${count(detail.requestsRemaining)} 남음`
          : count(detail.requestsLimit),
    });
  }
  if (detail.tokensLimit !== undefined) {
    out.push({
      label: "토큰 한도",
      value:
        detail.tokensRemaining !== undefined
          ? `${count(detail.tokensLimit)} 중 ${count(detail.tokensRemaining)} 남음`
          : count(detail.tokensLimit),
    });
  }
  return out;
}

function creditLines(detail: TeamProbeDetail | null): LimitsLine[] {
  const out: LimitsLine[] = [];
  if (!detail) return out;
  if (detail.creditLimit === null) out.push({ label: "이 키의 한도", value: "정해 두지 않았어요" });
  else if (detail.creditLimit !== undefined) {
    out.push({
      label: "이 키의 남은 크레딧",
      value:
        detail.creditRemaining !== undefined
          ? `${usd(detail.creditRemaining)} / ${usd(detail.creditLimit)}`
          : usd(detail.creditLimit),
    });
  }
  if (detail.creditUsageMonthly !== undefined) out.push({ label: "이 키가 이번 달 쓴 크레딧", value: usd(detail.creditUsageMonthly) });
  else if (detail.creditUsage !== undefined) out.push({ label: "이 키가 쓴 크레딧", value: usd(detail.creditUsage) });
  if (detail.accountTotalCredits !== undefined && detail.accountTotalUsage !== undefined) {
    out.push({
      label: "계정 전체 남은 크레딧",
      value: `${usd(Math.max(detail.accountTotalCredits - detail.accountTotalUsage, 0))} / ${usd(detail.accountTotalCredits)}`,
    });
  }
  return out;
}

/**
 * 키 하나의 블록. `detail`은 이 키의 확인 세부(없으면 아직 확인 전), `limits`는 서버의
 * 월 크레딧·지출 추정(운영자만 받는다; 못 받았으면 null).
 */
export function limitsBlock(input: {
  baseUrl: string;
  detail: TeamProbeDetail | null;
  /** 이 키가 방금 확인에서 불렸는가. 불렸는데 숫자가 없으면 「주지 않았다」고 말한다. */
  checked?: boolean;
  limits: ProviderLimits | null;
}): LimitsBlock {
  const company = limitsCompanyOf(input.baseUrl);
  const { detail } = input;
  const lines: LimitsLine[] = [];
  if (detail?.modelCount !== undefined) lines.push({ label: "쓸 수 있는 모델", value: `${count(detail.modelCount)}개` });
  lines.push(...rateLines(detail), ...creditLines(detail));

  let note: string | null = null;
  if (detail === null && input.checked !== true) note = "아직 확인하지 않았어요. 「연결 확인」을 누르면 읽어 와요.";
  else if (!lines.some((line) => line.label !== "쓸 수 있는 모델")) {
    note =
      company === "openrouter"
        ? "이 키는 한도를 따로 알려 주지 않았어요."
        : "이 확인 호출은 한도 숫자를 주지 않았어요.";
  }
  if (detail?.accountNeedsManagementKey && company === "openrouter") {
    note = [note, "계정 전체 잔액은 관리 키로만 읽혀요."].filter(Boolean).join(" ");
  }
  if (company === "anthropic" || company === "openai") {
    // 한 문장으로: 못 읽는다는 사실, 키가 유효해도 돈이 남았다는 뜻은 아니라는 것, 어디서 보는지.
    note = [note, "남은 크레딧은 공급사가 일반 API 키로 알려 주지 않아요. 키가 유효해도 크레딧이 남았다는 뜻은 아니니 콘솔에서 확인해 주세요."]
      .filter(Boolean)
      .join(" ");
  }

  const row: ProviderCompanyLimits | undefined = company
    ? input.limits?.companies.find((c) => c.company === company)
    : undefined;
  let estimate: LimitsBlock["estimate"] = null;
  if (company && row) {
    const spent = row.spendEstimate.microUsd;
    const budgetMicro = row.monthlyBudgetMicroUsd;
    const est: LimitsLine[] = [];
    est.push({
      label: "이번 달 oort가 집계한 사용액",
      value: row.spendEstimate.runs === 0 ? "기록 없음" : `약 ${usdFromMicro(spent)}`,
    });
    let usedRatio: number | null = null;
    let over = false;
    let hint: string | null = null;
    if (budgetMicro !== undefined) {
      est.push({ label: "적어 둔 월 크레딧", value: usdFromMicro(budgetMicro) });
      const remain = budgetMicro - spent;
      over = remain < 0;
      est.push({ label: "남은 양(추정)", value: over ? "월 크레딧을 넘겼어요" : `약 ${usdFromMicro(remain)}` });
      usedRatio = budgetMicro === 0 ? (spent > 0 ? 1 : 0) : Math.min(spent / budgetMicro, 1);
    } else {
      hint = "월 크레딧을 적어 두면 남은 양을 추정해 보여 줘요.";
    }
    const unpriced =
      row.spendEstimate.unpricedRuns > 0
        ? `단가를 모르는 모델 ${count(row.spendEstimate.unpricedRuns)}회는 금액에 들어 있지 않아요(${row.spendEstimate.unpricedModels.join(", ")}).`
        : null;
    estimate = {
      lines: est,
      usedRatio,
      over,
      hint,
      unpriced,
      budgetUsd: budgetMicro === undefined ? null : budgetMicro / MICRO,
    };
  }

  return {
    provider: { lines, note },
    estimate,
    company,
    console: company ? CONSOLE_BILLING[company] : null,
  };
}
