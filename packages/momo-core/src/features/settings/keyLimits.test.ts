import { describe, expect, it } from "vitest";
import type { ProviderLimits } from "./api";
import {
  CONSOLE_BILLING,
  budgetHint,
  limitsBlock,
  limitsCompanyOf,
  parseBudgetUsd,
  usdFromMicro,
} from "./keyLimits";
import { teamProbeDetailAt } from "./teamKeyForm";
import type { ProviderLinkTest } from "./api";

function limits(partial: Partial<ProviderLimits["companies"][number]> & { company: "anthropic" | "openai" | "xai" | "openrouter" }): ProviderLimits {
  return {
    schema: "momo.provider_limits.v0",
    monthStartMs: 0,
    computedAtMs: 0,
    companies: [
      {
        spendEstimate: { microUsd: 0, runs: 0, promptTokens: 0, completionTokens: 0, unpricedRuns: 0, unpricedModels: [] },
        ...partial,
      },
    ],
  };
}

function probeWith(position: number, probe: Record<string, unknown>): ProviderLinkTest {
  return {
    schema: "x",
    ok: true,
    source: "database",
    mode: "external-hermes",
    endpointLabel: "x",
    checkedAtMs: 1,
    entries: [{ position, source: "chain", mode: "external-hermes", endpointLabel: "x", enabled: true, ok: true, disposition: "ok", probe: probe as never }],
  };
}

describe("회사 알아보기", () => {
  it("프리셋 주소는 회사로, 모르는 주소는 null", () => {
    expect(limitsCompanyOf("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(limitsCompanyOf("https://api.openai.com/v1/")).toBe("openai");
    expect(limitsCompanyOf("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(limitsCompanyOf("https://api.x.ai/v1")).toBe("xai");
    expect(limitsCompanyOf("https://llm.corp.example/v1")).toBeNull();
    expect(limitsCompanyOf("not a url")).toBeNull();
  });
});

describe("월 크레딧 안내", () => {
  it("구독 예시는 Anthropic에만 붙는다", () => {
    expect(budgetHint("anthropic")).toContain("Max 5x는 월 $100");
    expect(budgetHint("openrouter")).not.toContain("Max");
  });
});

describe("월 크레딧 입력", () => {
  it("달러 금액만 받고 빈 칸은 지움", () => {
    expect(parseBudgetUsd("100")).toBe(100);
    expect(parseBudgetUsd(" $1,250.5 ")).toBe(1250.5);
    expect(parseBudgetUsd("")).toBeNull();
    expect(parseBudgetUsd("-1")).toBeUndefined();
    expect(parseBudgetUsd("10.123")).toBeUndefined();
    expect(parseBudgetUsd("abc")).toBeUndefined();
    expect(parseBudgetUsd("1000001")).toBeUndefined();
  });
});

describe("한도·남은 크레딧 블록", () => {
  it("Anthropic: 월 크레딧 100, 사용 추정 32.5 → 남은 양(추정) 67.5, 공급사 잔액이라 부르지 않는다", () => {
    const block = limitsBlock({
      baseUrl: "https://api.anthropic.com/v1",
      detail: teamProbeDetailAt(probeWith(0, { rateLimit: { source: "anthropic-ratelimit", requestsLimit: 50, requestsRemaining: 49 } }), 0),
      limits: limits({ company: "anthropic", monthlyBudgetMicroUsd: 100_000_000, spendEstimate: { microUsd: 32_500_000, runs: 9, promptTokens: 1, completionTokens: 1, unpricedRuns: 0, unpricedModels: [] } }),
    });
    expect(block.provider.lines).toEqual([{ label: "요청 한도", value: "50 중 49 남음" }]);
    expect(block.provider.note).toContain("일반 API 키로 알려 주지 않아요");
    expect(block.provider.note).toContain("키가 유효해도 크레딧이 남았다는 뜻은 아니니");
    expect(block.estimate?.lines).toEqual([
      { label: "이번 달 oort가 집계한 사용액", value: "약 $32.50" },
      { label: "적어 둔 월 크레딧", value: "$100.00" },
      { label: "남은 양(추정)", value: "약 $67.50" },
    ]);
    expect(block.estimate?.usedRatio).toBeCloseTo(0.325);
    expect(block.estimate?.over).toBe(false);
    expect(block.console).toEqual(CONSOLE_BILLING.anthropic);
    // 추정 칸에 공급사 「남은 크레딧」 라벨이 없다.
    expect(JSON.stringify(block.estimate)).not.toContain("남은 크레딧");
  });

  it("월 크레딧을 넘으면 넘었다고 하고, 단가 없는 모델은 금액에서 빼고 이름을 댄다", () => {
    const block = limitsBlock({
      baseUrl: "https://api.openai.com/v1",
      detail: null,
      limits: limits({ company: "openai", monthlyBudgetMicroUsd: 5_000_000, spendEstimate: { microUsd: 7_000_000, runs: 3, promptTokens: 1, completionTokens: 1, unpricedRuns: 2, unpricedModels: ["gpt-9"] } }),
    });
    expect(block.estimate?.over).toBe(true);
    expect(block.estimate?.usedRatio).toBe(1);
    expect(block.estimate?.lines.at(-1)).toEqual({ label: "남은 양(추정)", value: "월 크레딧을 넘겼어요" });
    expect(block.estimate?.unpriced).toBe("단가를 모르는 모델 2회는 금액에 들어 있지 않아요(gpt-9).");
    expect(block.provider.note).toContain("아직 확인하지 않았어요");
  });

  it("월 크레딧이 없으면 적어 달라고 하고 남은 양을 지어내지 않는다", () => {
    const block = limitsBlock({ baseUrl: "https://api.anthropic.com/v1", detail: null, limits: limits({ company: "anthropic" }) });
    expect(block.estimate?.hint).toContain("월 크레딧을 적어 두면");
    expect(block.estimate?.lines.map((l) => l.label)).toEqual(["이번 달 oort가 집계한 사용액"]);
    expect(block.estimate?.lines[0].value).toBe("기록 없음");
    expect(block.estimate?.usedRatio).toBeNull();
  });

  it("OpenRouter 일반 키: 키의 숫자만 읽고 계정 전체 잔액은 관리 키로만 읽힌다고 말한다", () => {
    const detail = teamProbeDetailAt(
      probeWith(0, { credit: { limit: 20, limitRemaining: 12.5, usage: 7.5, usageMonthly: 2.25 }, accountCreditNeedsManagementKey: true }),
      0
    );
    const block = limitsBlock({ baseUrl: "https://openrouter.ai/api/v1", detail, limits: null });
    expect(block.provider.lines).toEqual([
      { label: "이 키의 남은 크레딧", value: "$12.50 / $20.00" },
      { label: "이 키가 이번 달 쓴 크레딧", value: "$2.25" },
    ]);
    expect(block.provider.note).toBe("계정 전체 잔액은 관리 키로만 읽혀요.");
    expect(block.estimate).toBeNull();
  });

  it("OpenRouter 관리 키: 계정 전체 남은 크레딧을 보인다", () => {
    const detail = teamProbeDetailAt(
      probeWith(1, { credit: { limit: null, limitRemaining: null, usage: 3 }, accountCredit: { totalCredits: 100, totalUsage: 42.5 } }),
      1
    );
    const block = limitsBlock({ baseUrl: "https://openrouter.ai/api/v1", detail, limits: null });
    expect(block.provider.lines).toContainEqual({ label: "계정 전체 남은 크레딧", value: "$57.50 / $100.00" });
    expect(block.provider.lines).toContainEqual({ label: "이 키의 한도", value: "정해 두지 않았어요" });
  });

  it("모르는 주소(사내 프록시)는 추정 없이 읽은 숫자만", () => {
    const block = limitsBlock({ baseUrl: "https://llm.corp.example/v1", detail: null, limits: limits({ company: "openai" }) });
    expect(block.estimate).toBeNull();
    expect(block.console).toBeNull();
  });

  it("micro-USD를 달러 두 자리로", () => {
    expect(usdFromMicro(1_234_567)).toBe("$1.23");
    expect(usdFromMicro(0)).toBe("$0.00");
  });
});
