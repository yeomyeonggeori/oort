// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_DELEGATION_STATUS,
  type TeamAiDelegationStatus,
} from "@momo/core/features/settings/teamAiLimits";
import { defaultTeamAiRoles, type TeamAiRoles } from "@momo/core/features/settings/teamAiRoles";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiLimitsSection } from "./TeamAiLimitsSection";
import { TeamAiRolesList } from "./TeamAiRolesList";

// =============================================================================
// 설정의 「Hermes 도움」 행과 「하루 Hermes 맡기기」 칸 (ADR-0201 증보 v4 P7·P8·P10, #5375).
//
//   1. 운영자가 위임을 열지 않은 서버(천장 없음 — 지금 운영)·모름: 행도 칸도 없다(새로 보이는 것 0).
//   2. 연 서버: 행이 목록 끝에 서고 고지 두 문장이 행에 늘 보인다. 켜져 있는데 문이 닫혔으면 「지금은 쓸 수 없어요」 + 서버 낱말.
//      꺼져 있으면 까닭 줄 없이 스위치만(다시 켜는 길).
//   3. 온보딩처럼 위임 칸을 넘기지 않는 목록에는 행이 없다.
//   4. 하루 칸: 오늘 횟수/실제 상한은 서버 값 그대로, 천장을 넘는 값은 보내지 않는다, 빈 칸은 기본 30으로(`null`).
// =============================================================================

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
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      <LocaleProvider locale={korean}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </LocaleProvider>
    );
  });
  return host;
}

const pick = <T extends Element = HTMLElement>(view: HTMLElement, testId: string) =>
  view.querySelector<T>(`[data-testid="${testId}"]`);

function delegation(over: Partial<TeamAiDelegationStatus> = {}): TeamAiDelegationStatus {
  return {
    known: true,
    limit: 4,
    effective: 4,
    ceiling: 100,
    ceilingOff: false,
    today: 3,
    available: true,
    unavailableReason: null,
    ...over,
  };
}

/** 지금 운영의 모양: 천장 없음 = 닫힘. 첫 닫힌 문은 G3(연결 안 됨)일 수 있다. */
const OPS_OFF = delegation({
  limit: null,
  effective: 0,
  ceiling: null,
  ceilingOff: true,
  available: false,
  unavailableReason: "hermes_not_connected",
});

function roles(over: Partial<TeamAiRoles> = {}): TeamAiRoles {
  return { ...defaultTeamAiRoles(), ...over };
}

function list(hermes: TeamAiDelegationStatus | null | undefined, rolesValue = roles()) {
  return mount(
    <TeamAiRolesList
      roles={rolesValue}
      rowNotices
      testIdPrefix="t"
      onToggle={() => undefined}
      {...(hermes === undefined ? {} : { hermes })}
    />
  );
}

describe("역할 목록의 「Hermes 도움」 행", () => {
  it("운영자가 열지 않았거나(천장 없음) 모르면 행이 없다", () => {
    expect(pick(list(OPS_OFF), "t-role-row-hermes")).toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(pick(list(UNKNOWN_DELEGATION_STATUS), "t-role-row-hermes")).toBeNull();
  });

  it("위임 칸을 넘기지 않는 목록(온보딩)에는 행이 없다", () => {
    expect(pick(list(undefined), "t-role-row-hermes")).toBeNull();
  });

  it("연 서버: 목록 끝에 행, 고지 두 문장이 행에 늘 보이고 문이 열려 있으면 까닭 줄이 없다", () => {
    const view = list(delegation());
    const row = pick(view, "t-role-row-hermes");
    expect(row).not.toBeNull();
    expect(row?.parentElement?.lastElementChild).toBe(row);
    expect(row?.textContent).toContain("Hermes 도움");
    const notice = pick(view, "t-role-notice-hermes");
    expect(notice?.textContent).toContain("Hermes가 쓰는 AI 회사(OpenAI 등)로 전달돼요");
    expect(notice?.textContent).toContain("그 보관과 삭제는 oort가 아니라 서버 운영자가 정해요");
    expect(pick(view, "t-role-unavailable-hermes")).toBeNull();
    const toggle = pick<HTMLButtonElement>(view, "t-role-hermes");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    // 고지가 스위치의 설명에 묶여 있다(켤 때의 고지 기록이 사실이다).
    expect(toggle?.getAttribute("aria-describedby")?.split(" ")).toContain(notice?.id);
  });

  it("켜져 있는데 Hermes가 연결 안 됨: 「지금은 쓸 수 없어요.」 + 서버 낱말의 까닭", () => {
    const view = list(delegation({ available: false, unavailableReason: "hermes_not_connected" }));
    const line = pick(view, "t-role-unavailable-hermes");
    expect(line?.textContent).toBe("지금은 쓸 수 없어요. Hermes가 연결돼 있지 않아요.");
    expect(pick(view, "t-role-hermes")?.getAttribute("aria-describedby")?.split(" ")).toContain(line?.id);
  });

  it("묶음이 꺼져 있으면 행과 스위치는 남고 까닭 줄은 없다", () => {
    const view = list(
      delegation({ available: false, unavailableReason: "hermes_not_connected" }),
      roles({ hermes: false })
    );
    expect(pick(view, "t-role-row-hermes")).not.toBeNull();
    expect(pick(view, "t-role-hermes")?.getAttribute("aria-checked")).toBe("false");
    expect(pick(view, "t-role-unavailable-hermes")).toBeNull();
  });
});

/** 서버 `limits_status_in_tx` 의 모양 + 위임 칸(#5374). */
function bag(d: TeamAiDelegationStatus, helperOff = false) {
  return {
    team_ai_limits_status: {
      limits: { dailyTokens: null, dailySearches: null, monthlyUsd: null, dailyDelegations: d.limit },
      effective: { dailyTokens: null, dailySearches: null, dailyDelegations: d.effective },
      operatorCeiling: {
        dailyTokens: null,
        dailySearches: null,
        helperOff,
        searchOff: false,
        dailyDelegations: d.ceiling,
        delegationOff: d.ceilingOff,
      },
      usage: {
        todayTokens: 0,
        todaySearches: 0,
        monthCostMicroUsd: 0,
        monthRuns: 0,
        monthUnpricedRuns: 0,
        monthEstimatedRuns: 0,
        todayDelegations: d.today,
      },
      monthlyUsdAvailable: true,
      monthlyUsdUnavailableReason: null,
      delegationAvailable: d.available,
      delegationUnavailableReason: d.unavailableReason,
      dayResetsAtMs: Date.now() + 3 * HOUR,
      monthResetsAtMs: Date.now() + 100 * HOUR,
    },
  };
}

async function section(d: TeamAiDelegationStatus, helperOff = false) {
  fetchBag.mockResolvedValue(bag(d, helperOff));
  const view = mount(<TeamAiLimitsSection workspaceId={WS} offline={false} />);
  await flush();
  return view;
}

async function type(element: HTMLInputElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("「사용 한도」의 하루 Hermes 맡기기 칸", () => {
  it("운영자가 열지 않은 서버(지금 운영)에는 칸이 없다 — 다른 한도는 그대로", async () => {
    const view = await section(OPS_OFF);
    expect(pick(view, "team-ai-limits")).not.toBeNull();
    expect(pick(view, "team-ai-limit-delegations-item")).toBeNull();
  });

  it("연 서버: 오늘 횟수/실제 상한은 서버 값 그대로, 천장 안내", async () => {
    const view = await section(delegation({ ceiling: 50 }));
    expect(pick(view, "team-ai-limit-delegations-today")?.textContent).toBe("오늘 Hermes에 맡긴 횟수 3/4");
    expect(pick(view, "team-ai-limit-delegations-ceiling")?.textContent).toBe(
      "서버 운영자가 하루 50회까지로 제한했어요."
    );
    expect(pick<HTMLInputElement>(view, "team-ai-limit-delegations-input")?.value).toBe("4");
  });

  it("천장을 넘는 값은 보내지 않고 상한을 말한다, 빈 칸은 기본 30으로(null)", async () => {
    const view = await section(delegation({ ceiling: 50 }));
    const input = pick<HTMLInputElement>(view, "team-ai-limit-delegations-input");
    await type(input, "51");
    await act(async () => {
      pick<HTMLButtonElement>(view, "team-ai-limit-delegations-save")?.click();
    });
    await flush();
    expect(saveLimits).not.toHaveBeenCalled();
    expect(pick(view, "team-ai-limit-delegations-error")?.textContent).toBe("서버 운영자가 정한 50까지만 적을 수 있어요.");

    saveLimits.mockResolvedValueOnce(bag(delegation({ ceiling: 50, limit: null, effective: 30 })));
    await type(input, "");
    await act(async () => {
      pick<HTMLButtonElement>(view, "team-ai-limit-delegations-save")?.click();
    });
    await flush();
    expect(saveLimits).toHaveBeenCalledWith(WS, { dailyDelegations: null });
    expect(pick(view, "team-ai-limit-delegations-today")?.textContent).toBe("오늘 Hermes에 맡긴 횟수 3/30");
  });

  it("운영자가 팀 AI를 멈췄으면 이웃 행처럼 입력과 저장이 잠긴다", async () => {
    const view = await section(delegation({ ceiling: 50 }), true);
    const input = pick<HTMLInputElement>(view, "team-ai-limit-delegations-input");
    expect(input?.disabled).toBe(true);
    await type(input, "12");
    expect(pick<HTMLButtonElement>(view, "team-ai-limit-delegations-save")?.disabled).toBe(true);
  });
});
