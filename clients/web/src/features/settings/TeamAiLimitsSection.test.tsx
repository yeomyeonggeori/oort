// @vitest-environment jsdom
// #5026 (#4944의 화면 몫, ADR-0201 증보 v3 B9): 설정 › AI › 팀 AI 키의 「사용 한도」.
// 기본은 제한 없음, 관리자만 보고 바꾸며, 끄기는 null · 0은 보내지 않고 · 운영자 천장은 입력 상한이다.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { TeamAiLimitsStatus } from "@momo/core/features/settings/teamAiLimits";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiLimitsSection } from "./TeamAiLimitsSection";

const fetchBag = vi.hoisted(() => vi.fn());
const saveLimits = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/teamAiLimits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiLimits")>();
  return {
    ...actual,
    fetchTeamAiLimitsBag: (...args: unknown[]) => fetchBag(...args) as Promise<unknown>,
    saveTeamAiLimits: (...args: unknown[]) => saveLimits(...args) as Promise<unknown>,
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const HOUR = 3_600_000;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  fetchBag.mockReset();
  saveLimits.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** 서버 `limits_status_in_tx` 의 모양(openapi `TeamAiLimitsStatus`). 시험마다 한 조각만 바꾼다. */
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
    dayResetsAtMs: Date.now() + 3 * HOUR,
    monthResetsAtMs: Date.now() + 100 * HOUR,
    ...over,
  };
}

/** 가방 + 계산된 읽기. 한도를 안 켠 가방은 `team_ai_limits` 키가 없다. */
function bagOf(s: TeamAiLimitsStatus) {
  const limits: Record<string, number> = {};
  if (s.limits.dailyTokens !== null) limits["dailyTokens"] = s.limits.dailyTokens;
  if (s.limits.dailySearches !== null) limits["dailySearches"] = s.limits.dailySearches;
  if (s.limits.monthlyUsd !== null) limits["monthlyUsd"] = s.limits.monthlyUsd;
  return {
    ...(Object.keys(limits).length > 0 ? { team_ai_limits: limits } : {}),
    team_ai_limits_status: s,
  };
}

const ON = status({
  limits: { dailyTokens: 500_000, dailySearches: null, monthlyUsd: 20 },
  effective: { dailyTokens: 200_000, dailySearches: null },
  operatorCeiling: { dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false },
});

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(offline = false): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      <LocaleProvider locale={korean}>
        <QueryClientProvider client={client}>
          <TeamAiLimitsSection workspaceId={WS} offline={offline} />
        </QueryClientProvider>
      </LocaleProvider>
    );
  });
  await flush();
  return host;
}

const pick = <T extends Element = HTMLElement>(view: HTMLElement, testId: string) =>
  view.querySelector<T>(`[data-testid="${testId}"]`);
const item = (view: HTMLElement, field: string) => pick(view, `team-ai-limit-${field}-item`);
const toggle = (view: HTMLElement, field: string) =>
  pick<HTMLButtonElement>(view, `team-ai-limit-${field}-toggle`);
const input = (view: HTMLElement, field: string) =>
  pick<HTMLInputElement>(view, `team-ai-limit-${field}-input`);
const saveButton = (view: HTMLElement, field: string) =>
  pick<HTMLButtonElement>(view, `team-ai-limit-${field}-save`);

async function press(element: HTMLElement | null) {
  await act(async () => {
    element?.click();
  });
  await flush();
}

async function type(element: HTMLInputElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("사용 한도: 기본은 제한 없음", () => {
  it("한도를 안 켠 기본: 세 행이 모두 꺼져 있고 입력칸이 없으며 쓴 양만 말한다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    expect(pick(view, "team-ai-limits")).not.toBeNull();
    for (const field of ["dailyTokens", "dailySearches", "monthlyUsd"]) {
      expect(toggle(view, field)?.getAttribute("aria-checked")).toBe("false");
      expect(input(view, field)).toBeNull();
    }
    expect(view.textContent).toContain("기본은 제한 없음");
    expect(view.textContent).toContain("오늘 124,000 토큰 사용");
    expect(view.textContent).toContain("오늘 웹 검색 3회");
    // 한도가 없으니 비율도 초기화 시각도 없다.
    expect(view.textContent).not.toContain("% 사용");
    expect(view.textContent).not.toContain("새로 시작해요");
    // 금액 행은 늘 공개 단가 안내를 든다.
    expect(view.textContent).toContain("공개 단가로 계산한 금액이에요. 공급사 청구서와 다를 수 있어요.");
  });

  it("켠 한도: 값·실효 한도 기준의 사용 비율·초기화 시각을 보인다", async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    const view = await mount();
    expect(toggle(view, "dailyTokens")?.getAttribute("aria-checked")).toBe("true");
    expect(input(view, "dailyTokens")?.value).toBe("500000");
    // 62%는 관리자 값(500,000)이 아니라 천장까지 따진 실효 한도(200,000)로 잰다.
    expect(pick(view, "team-ai-limit-dailyTokens-headline")?.textContent).toBe("오늘 62% 사용");
    expect(pick(view, "team-ai-limit-dailyTokens-detail")?.textContent).toBe("124,000 / 200,000 토큰");
    expect(pick(view, "team-ai-limit-dailyTokens-resets")?.textContent).toMatch(/에 새로 시작해요$/);
    expect(view.textContent).toContain("서버 운영자가 하루 200,000토큰까지로 제한했어요.");
    expect(pick(view, "team-ai-limit-monthlyUsd-headline")?.textContent).toBe("이번 달 62% 사용");
    expect(input(view, "monthlyUsd")?.value).toBe("20");
  });
});

describe("저장 요청의 모양", () => {
  it("켜기는 값을 적고 저장해야 서버에 가고, 그 한도 하나만 이름을 댄다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    await press(toggle(view, "dailyTokens"));
    // 켜기만으로는 아무것도 저장하지 않는다.
    expect(saveLimits).not.toHaveBeenCalled();
    expect(input(view, "dailyTokens")).not.toBeNull();
    expect(saveButton(view, "dailyTokens")?.disabled).toBe(true);
    expect(document.activeElement).toBe(input(view, "dailyTokens"));

    saveLimits.mockResolvedValueOnce(
      bagOf(status({ limits: { dailyTokens: 100_000, dailySearches: null, monthlyUsd: null } }))
    );
    await type(input(view, "dailyTokens"), "100,000");
    await press(saveButton(view, "dailyTokens"));
    expect(saveLimits).toHaveBeenCalledTimes(1);
    expect(saveLimits).toHaveBeenCalledWith(WS, { dailyTokens: 100_000 });
    expect(toggle(view, "dailyTokens")?.getAttribute("aria-checked")).toBe("true");
    expect(input(view, "dailyTokens")?.value).toBe("100000");
    expect(pick(view, "team-ai-limit-dailyTokens-status")?.textContent).toBe("저장했어요.");
    // 다른 한도는 그대로 꺼져 있다.
    expect(toggle(view, "dailySearches")?.getAttribute("aria-checked")).toBe("false");
  });

  it("끄기는 0이 아니라 null 하나다", async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    saveLimits.mockResolvedValueOnce(
      bagOf({ ...ON, limits: { dailyTokens: null, dailySearches: null, monthlyUsd: 20 } })
    );
    const view = await mount();
    await press(toggle(view, "dailyTokens"));
    expect(saveLimits).toHaveBeenCalledWith(WS, { dailyTokens: null });
    const sent = saveLimits.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.values(sent)).not.toContain(0);
    expect(toggle(view, "dailyTokens")?.getAttribute("aria-checked")).toBe("false");
    expect(pick(view, "team-ai-limit-dailyTokens-status")?.textContent).toBe("한도를 껐어요.");
  });

  it("끄는 동안에는 누른 값(꺼짐)을 보이고, 실패하면 켜진 채로 돌아와 이유를 말한다", async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    const view = await mount();
    let fail: (error: Error) => void = () => {};
    saveLimits.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
    await press(toggle(view, "dailyTokens"));
    // 응답 전: 스위치는 이미 꺼져 있고 입력칸은 접혔으며 다른 행은 잠겼다. 되돌아 튀는 스위치는 고장 난 것처럼 보인다.
    expect(toggle(view, "dailyTokens")?.getAttribute("aria-checked")).toBe("false");
    expect(input(view, "dailyTokens")).toBeNull();
    expect(toggle(view, "dailySearches")?.disabled).toBe(true);
    await act(async () => {
      fail(new ApiError(500, "boom"));
    });
    await flush();
    // 실패: 저장된 값은 그대로라 켜진 채로 돌아오고, 입력은 저장된 값이며, 이유를 말한다.
    expect(toggle(view, "dailyTokens")?.getAttribute("aria-checked")).toBe("true");
    expect(input(view, "dailyTokens")?.value).toBe("500000");
    expect(pick(view, "team-ai-limit-dailyTokens-error")?.textContent).toBe(
      "한도를 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요."
    );
  });

  it("0을 적으면 보내지 않고 이유를 말한다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    await press(toggle(view, "dailyTokens"));
    await type(input(view, "dailyTokens"), "0");
    await press(saveButton(view, "dailyTokens"));
    expect(saveLimits).not.toHaveBeenCalled();
    expect(pick(view, "team-ai-limit-dailyTokens-error")?.textContent).toBe(
      "0은 한도로 쓸 수 없어요. 한도를 없애려면 스위치를 꺼 주세요."
    );
    // 금액도 같다: 0.0 은 0이다.
    await press(toggle(view, "monthlyUsd"));
    await type(input(view, "monthlyUsd"), "0.0");
    await press(saveButton(view, "monthlyUsd"));
    expect(saveLimits).not.toHaveBeenCalled();
    // 글자를 고치면 오류가 사라진다.
    await type(input(view, "dailyTokens"), "5");
    expect(pick(view, "team-ai-limit-dailyTokens-error")).toBeNull();
  });
});

describe("운영자: 천장은 입력 상한이고, 끄면 입력을 막는다", () => {
  const CEILING = status({
    effective: { dailyTokens: 200_000, dailySearches: null },
    operatorCeiling: { dailyTokens: 200_000, dailySearches: null, helperOff: false, searchOff: false },
  });

  it("천장을 넘는 값은 보내지 않고, 천장 그대로는 보낸다", async () => {
    fetchBag.mockResolvedValue(bagOf(CEILING));
    const view = await mount();
    expect(view.textContent).toContain("서버 운영자가 하루 200,000토큰까지로 제한했어요.");
    await press(toggle(view, "dailyTokens"));
    await type(input(view, "dailyTokens"), "200001");
    await press(saveButton(view, "dailyTokens"));
    expect(saveLimits).not.toHaveBeenCalled();
    expect(pick(view, "team-ai-limit-dailyTokens-error")?.textContent).toBe(
      "서버 운영자가 정한 200,000까지만 적을 수 있어요."
    );
    saveLimits.mockResolvedValueOnce(
      bagOf({ ...CEILING, limits: { dailyTokens: 200_000, dailySearches: null, monthlyUsd: null } })
    );
    await type(input(view, "dailyTokens"), "200000");
    await press(saveButton(view, "dailyTokens"));
    expect(saveLimits).toHaveBeenCalledWith(WS, { dailyTokens: 200_000 });
  });

  it("운영자가 팀 AI를 멈췄으면 안내 한 줄이 서고 모든 스위치와 입력이 잠긴다", async () => {
    const off = status({
      limits: { dailyTokens: 100_000, dailySearches: null, monthlyUsd: null },
      effective: { dailyTokens: 0, dailySearches: null },
      operatorCeiling: { dailyTokens: null, dailySearches: null, helperOff: true, searchOff: false },
    });
    fetchBag.mockResolvedValue(bagOf(off));
    const view = await mount();
    expect(pick(view, "team-ai-limits-operator-off")?.textContent).toBe("서버 운영자가 팀 AI를 멈춰 뒀어요.");
    for (const field of ["dailyTokens", "dailySearches", "monthlyUsd"]) {
      expect(toggle(view, field)?.disabled).toBe(true);
    }
    expect(input(view, "dailyTokens")?.disabled).toBe(true);
    await press(toggle(view, "dailyTokens"));
    expect(saveLimits).not.toHaveBeenCalled();
  });
});

describe("금액 한도", () => {
  it("켤 수 없는 두 까닭: 스위치가 잠기고 까닭을 말한다", async () => {
    fetchBag.mockResolvedValue(
      bagOf(status({ monthlyUsdAvailable: false, monthlyUsdUnavailableReason: "model_unpriced" }))
    );
    let view = await mount();
    expect(toggle(view, "monthlyUsd")?.disabled).toBe(true);
    expect(view.textContent).toContain("지금 쓰는 모델의 단가를 몰라 금액 한도를 켤 수 없어요. 토큰 한도를 써 보세요.");
    // 토큰 한도는 그대로 켤 수 있다.
    expect(toggle(view, "dailyTokens")?.disabled).toBe(false);

    act(() => root?.unmount());
    host?.remove();
    fetchBag.mockResolvedValue(
      bagOf(status({ monthlyUsdAvailable: false, monthlyUsdUnavailableReason: "no_usage_yet" }))
    );
    view = await mount();
    expect(toggle(view, "monthlyUsd")?.disabled).toBe(true);
    expect(view.textContent).toContain("도우미가 한 번 답한 뒤에 켤 수 있어요.");
  });

  it("추정이 섞인 금액은 「약 … 이상」이고 단가 없는 실행 수를 말한다", async () => {
    fetchBag.mockResolvedValue(
      bagOf(
        status({
          limits: { dailyTokens: null, dailySearches: null, monthlyUsd: 20 },
          usage: { ...status().usage, monthEstimatedRuns: 1, monthUnpricedRuns: 2 },
        })
      )
    );
    const view = await mount();
    expect(pick(view, "team-ai-limit-monthlyUsd-detail")?.textContent).toBe("약 US$12.50 이상 / US$20.00");
    expect(view.textContent).toContain("단가를 모르는 모델로 한 요청 2건은 금액에 넣지 않았어요.");
  });

  it("켤 수 없다는 400 답은 금액 한도를 못 켠다고 말하고 다시 읽는다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    await press(toggle(view, "monthlyUsd"));
    await type(input(view, "monthlyUsd"), "20");
    saveLimits.mockRejectedValueOnce(new ApiError(400, "no price", "team_ai_usd_limit_unavailable"));
    fetchBag.mockResolvedValue(
      bagOf(status({ monthlyUsdAvailable: false, monthlyUsdUnavailableReason: "model_unpriced" }))
    );
    await press(saveButton(view, "monthlyUsd"));
    expect(fetchBag).toHaveBeenCalledTimes(2);
    // 쓰던 초안은 접히고, 스위치는 꺼진 채 잠기며, 까닭과 실패를 말한다.
    expect(input(view, "monthlyUsd")).toBeNull();
    expect(toggle(view, "monthlyUsd")?.getAttribute("aria-checked")).toBe("false");
    expect(toggle(view, "monthlyUsd")?.disabled).toBe(true);
    expect(pick(view, "team-ai-limit-monthlyUsd-error")?.textContent).toBe("지금은 금액 한도를 켤 수 없어요.");
    expect(view.textContent).toContain("단가를 몰라 금액 한도를 켤 수 없어요");
  });
});

describe("저장 실패·읽기 실패·오프라인", () => {
  it("저장 실패는 서버 문장이 아니라 사전의 한 문장이고 입력은 남는다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    await press(toggle(view, "dailySearches"));
    await type(input(view, "dailySearches"), "50");
    saveLimits.mockRejectedValueOnce(new ApiError(500, "internal detail"));
    await press(saveButton(view, "dailySearches"));
    const error = pick(view, "team-ai-limit-dailySearches-error")?.textContent;
    expect(error).toBe("한도를 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    expect(error).not.toContain("internal detail");
    expect(input(view, "dailySearches")?.value).toBe("50");
    saveLimits.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    await press(saveButton(view, "dailySearches"));
    expect(pick(view, "team-ai-limit-dailySearches-error")?.textContent).toBe(
      "소유자나 관리자만 한도를 바꿀 수 있어요."
    );
  });

  it("오프라인이면 안내가 서고 눌러도 저장하지 않는다", async () => {
    fetchBag.mockResolvedValue(bagOf(ON));
    const view = await mount(true);
    expect(pick(view, "team-ai-limits-offline")?.textContent).toBe(
      "연결이 끊겨 지금은 한도를 바꿀 수 없어요."
    );
    expect(toggle(view, "dailyTokens")?.disabled).toBe(true);
    expect(input(view, "dailyTokens")?.disabled).toBe(true);
    expect(saveButton(view, "dailyTokens")?.disabled).toBe(true);
    await press(toggle(view, "dailyTokens"));
    expect(saveLimits).not.toHaveBeenCalled();
  });

  it("읽기에 실패하면 말하고 다시 시도 길을 둔다", async () => {
    fetchBag.mockRejectedValueOnce(new ApiError(500, "boom"));
    const view = await mount();
    const banner = pick(view, "team-ai-limits-load-error");
    expect(banner?.textContent).toContain("사용 한도를 불러오지 못했어요.");
    fetchBag.mockResolvedValueOnce(bagOf(status()));
    await press(banner?.querySelector("button") ?? null);
    expect(pick(view, "team-ai-limits")).not.toBeNull();
  });
});

describe("이 칸은 확인된 뒤에만 선다", () => {
  it("소유자·관리자가 아니면(403) 아무것도 그리지 않는다", async () => {
    fetchBag.mockRejectedValue(new ApiError(403, "forbidden"));
    const view = await mount();
    expect(pick(view, "team-ai-limits")).toBeNull();
    expect(pick(view, "team-ai-limits-load-error")).toBeNull();
    expect(view.textContent).toBe("");
  });

  it("한도 읽기를 모르는 서버(계산된 읽기 없음)에서는 아무것도 그리지 않는다", async () => {
    fetchBag.mockResolvedValue({ team_ai_fast_path: true });
    const view = await mount();
    expect(pick(view, "team-ai-limits")).toBeNull();
    expect(view.textContent).toBe("");
  });

  it("일부 조각이 깨진 읽기는 일부만 믿고 그리지 않는다", async () => {
    const broken = bagOf(status());
    (broken.team_ai_limits_status.usage as unknown as Record<string, unknown>)["todayTokens"] = "많이";
    fetchBag.mockResolvedValue(broken);
    const view = await mount();
    expect(view.textContent).toBe("");
  });
});

describe("행 안의 한 가지 일", () => {
  it("한 행의 저장이 가는 동안 다른 행은 잠기고 이 행만 「저장 중」이다", async () => {
    fetchBag.mockResolvedValue(bagOf(status()));
    const view = await mount();
    await press(toggle(view, "dailyTokens"));
    await type(input(view, "dailyTokens"), "100");
    let release: (value: unknown) => void = () => {};
    saveLimits.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await press(saveButton(view, "dailyTokens"));
    expect(saveButton(view, "dailyTokens")?.textContent).toBe("저장 중");
    expect(saveButton(view, "dailyTokens")?.getAttribute("aria-busy")).toBe("true");
    expect(toggle(view, "dailySearches")?.disabled).toBe(true);
    expect(item(view, "dailySearches")).not.toBeNull();
    await act(async () => {
      release(bagOf(status({ limits: { dailyTokens: 100, dailySearches: null, monthlyUsd: null } })));
    });
    await flush();
    expect(toggle(view, "dailySearches")?.disabled).toBe(false);
  });
});
