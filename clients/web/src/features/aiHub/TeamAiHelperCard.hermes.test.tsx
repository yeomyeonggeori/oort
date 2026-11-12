// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RosterMember } from "@momo/core/lib/api";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { TeamAiHelperCard } from "./TeamAiHelperCard";

// =============================================================================
// 설정 › AI › 팀 AI 키의 「도우미」 카드가 「Hermes 도움」 행을 실제로 잇는가 (#5375, ADR-0201 증보 v4 P8·P10).
//
// 목록 부품(`TeamAiRolesList`)의 시험은 위임 칸을 손으로 넘긴다. 여기는 카드가 **한도 가방(같은 쿼리 키)을 읽어 그 칸을
// 넘기는지**를 잰다: 천장이 있는 서버 → 행, 지금 운영(천장 없음) → 행 + 「지금은 쓸 수 없어요.」와 천장 까닭(증보 v4 P8),
// 한도 가방을 못 읽음(관리자 아님 403) → 없다.
// =============================================================================

const fetchSettings = vi.hoisted(() => vi.fn());
const fetchLimits = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/teamAiSwitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiSwitch")>();
  return { ...actual, fetchWorkspaceSettingsBag: (...args: unknown[]) => fetchSettings(...args) as Promise<unknown> };
});
vi.mock("@momo/core/features/settings/teamAiLimits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiLimits")>();
  return { ...actual, fetchTeamAiLimitsBag: (...args: unknown[]) => fetchLimits(...args) as Promise<unknown> };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: () =>
      Promise.resolve([
        {
          id: HELPER,
          workspaceId: WS,
          kind: "agent",
          status: "active",
          handle: "oort-helper",
          displayName: "오르트 도우미",
        } as RosterMember,
      ]),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const HELPER = "00000000-0000-7000-8000-0000000000a1";

let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  fetchSettings.mockReset();
  fetchLimits.mockReset();
  fetchSettings.mockResolvedValue({
    team_ai_fast_path: true,
    team_ai_agent_member_id: HELPER,
    team_ai_alias_status: { oort: "registered", 오르트: "registered", claude: "registered" },
  });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** 서버 `limits_status_in_tx` 의 모양 + 위임 칸. `ceiling` 이 `null` 이면 지금 운영(닫힘)이다. */
function limitsBag(ceiling: number | null) {
  return {
    team_ai_limits_status: {
      limits: { dailyTokens: null, dailySearches: null, monthlyUsd: null, dailyDelegations: null },
      effective: { dailyTokens: null, dailySearches: null, dailyDelegations: ceiling === null ? 0 : Math.min(30, ceiling) },
      operatorCeiling: {
        dailyTokens: null,
        dailySearches: null,
        helperOff: false,
        searchOff: false,
        dailyDelegations: ceiling,
        delegationOff: ceiling === null,
      },
      usage: {
        todayTokens: 0,
        todaySearches: 0,
        monthCostMicroUsd: 0,
        monthRuns: 0,
        monthUnpricedRuns: 0,
        monthEstimatedRuns: 0,
        todayDelegations: 0,
      },
      monthlyUsdAvailable: true,
      monthlyUsdUnavailableReason: null,
      delegationAvailable: ceiling !== null,
      delegationUnavailableReason: ceiling === null ? "ceiling_unset" : null,
      dayResetsAtMs: Date.now() + 3_600_000,
      monthResetsAtMs: Date.now() + 360_000_000,
    },
  };
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(QueryClientProvider, {
        client,
        children: createElement(LocaleProvider, { locale: korean, children: createElement(TeamAiHelperCard, { workspaceId: WS }) }),
      })
    );
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const row = () => document.querySelector('[data-testid="team-ai-helper-role-row-hermes"]');

describe("도우미 카드의 「Hermes 도움」 행", () => {
  it("운영자가 연 서버: 카드가 한도 가방을 읽어 행을 세운다", async () => {
    fetchLimits.mockResolvedValue(limitsBag(50));
    await mount();
    // 카드 자체가 섰다(다른 역할 행이 있다) — 아래 두 시험의 「없음」이 카드가 안 서서 생긴 것이 아님을 함께 잰다.
    expect(document.querySelector('[data-testid="team-ai-helper-role-row-files"]')).not.toBeNull();
    expect(row()).not.toBeNull();
    expect(fetchLimits).toHaveBeenCalledWith(WS);
  });

  it("지금 운영(천장 없음): 행이 서고 「지금은 쓸 수 없어요.」 + 천장 까닭", async () => {
    fetchLimits.mockResolvedValue(limitsBag(null));
    await mount();
    expect(row()).not.toBeNull();
    expect(document.querySelector('[data-testid="team-ai-helper-role-unavailable-hermes"]')?.textContent).toBe(
      "지금은 쓸 수 없어요. 서버 운영자가 아직 Hermes 맡기기를 열지 않았어요."
    );
  });

  it("한도 가방을 못 읽으면(관리자 아님 403) 행이 없다", async () => {
    fetchLimits.mockRejectedValue(new ApiError(403, "forbidden"));
    await mount();
    expect(document.querySelector('[data-testid="team-ai-helper-role-row-files"]')).not.toBeNull();
    expect(row()).toBeNull();
  });
});
