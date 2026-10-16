// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchRoster, listChannels, type RosterMember } from "@momo/core/lib/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import {
  deleteProviderLink,
  fetchProviderChain,
  fetchProviderLink,
  fetchProviderLimits,
  fetchWorkspace,
  putProviderBudget,
  putProviderLink,
  testProviderLink,
} from "@momo/core/features/settings/api";
import { fetchProviderDefaultAi, putProviderDefaultAi } from "@momo/core/features/settings/defaultAi";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiTeamKeysPane } from "./AiTeamKeysPane";

// =============================================================================
// 「팀 AI 키」의 「한도·남은 크레딧」 블록 (#3887). 공급사가 알려 준 숫자와 oort 추정을 이름으로
// 가르고, 월 크레딧을 적고, 크레딧·결제 문제를 사람 말로 보인다.
// =============================================================================

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, IS_TAURI: true, SUBSCRIPTION_AGENTS_BUILD_FLAG: true };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchRoster: vi.fn(), listChannels: vi.fn() };
});
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>();
  return { ...actual, listHostedConnections: vi.fn() };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchProviderLink: vi.fn(),
    fetchProviderChain: vi.fn(),
    fetchWorkspace: vi.fn(),
    fetchProviderLimits: vi.fn(),
    putProviderBudget: vi.fn(),
    deleteProviderLink: vi.fn(),
    putProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
  };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: vi.fn(), putProviderDefaultAi: vi.fn() };
});

vi.mock("@momo/core/features/ai/personalKeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/ai/personalKeys")>();
  return {
    ...actual,
    listPersonalKeys: vi.fn(async () => []),
    listMyPersonalKeys: vi.fn(async () => []),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const BOSS = "00000000-0000-7000-8000-000000000102";
const AGENT = "00000000-0000-7000-8000-000000000301";

function human(id: string, name: string, role: RosterMember["role"]): RosterMember {
  return {
    id, workspaceId: WS, kind: "human", status: "active", displayName: name, handle: name, role,
    channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  };
}
const AGENT_MEMBER: RosterMember = {
  ...human(AGENT, "김인턴", "member"),
  kind: "agent",
};

const KEY_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1",
  endpointLabel: "https://api.anthropic.com/v1",
  bearerConfigured: true,
  bearerLast4: "7c1e",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: 1_790_000_000_000,
  diagnostics: [] as string[],
  credentialKind: "bearer",
};

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a", refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session() },
            createElement(AiTeamKeysPane, { offline: false, workspaceId: WS, memberId: ME })
          )
        )
      )
    );
  });
  return host;
}
const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
async function until(id: string): Promise<HTMLElement> {
  await rtlWaitFor(() => {
    if (!q(id)) throw new Error(id);
  });
  return q(id) as HTMLElement;
}


beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

const LIMITS = {
  schema: "momo.provider_limits.v0",
  monthStartMs: 1,
  computedAtMs: 2,
  companies: [
    {
      company: "anthropic" as const,
      monthlyBudgetMicroUsd: 100_000_000,
      spendEstimate: { microUsd: 32_500_000, runs: 9, promptTokens: 1, completionTokens: 1, unpricedRuns: 2, unpricedModels: ["claude-mystery-9"] },
    },
    { company: "openai" as const, spendEstimate: { microUsd: 0, runs: 0, promptTokens: 0, completionTokens: 0, unpricedRuns: 0, unpricedModels: [] } },
    { company: "xai" as const, spendEstimate: { microUsd: 0, runs: 0, promptTokens: 0, completionTokens: 0, unpricedRuns: 0, unpricedModels: [] } },
    { company: "openrouter" as const, spendEstimate: { microUsd: 0, runs: 0, promptTokens: 0, completionTokens: 0, unpricedRuns: 0, unpricedModels: [] } },
  ],
};

function probeOf(head: Record<string, unknown>) {
  return {
    schema: "momo.provider_link.test.v0",
    ok: true,
    source: "database",
    mode: "external-hermes",
    endpointLabel: "https://api.anthropic.com/v1",
    checkedAtMs: 1_790_000_100_000,
    cascadeOk: true,
    entries: [
      { position: 0, source: "provider_link", mode: "external-hermes", endpointLabel: "x", enabled: true, ok: true, disposition: "ok", probe: { outcome: "ok", method: "models", latencyMs: 5, probedAtMs: 1, cached: false, ...head } },
    ],
  };
}

beforeEach(() => {
  vi.mocked(fetchProviderLimits).mockReset();
  vi.mocked(fetchProviderLimits).mockResolvedValue(LIMITS);
  vi.mocked(putProviderBudget).mockReset();
  vi.mocked(fetchRoster).mockReset();
  vi.mocked(fetchRoster).mockResolvedValue([human(ME, "곽성재", "member"), human(BOSS, "박운영", "owner"), AGENT_MEMBER]);
  vi.mocked(listChannels).mockReset();
  vi.mocked(listChannels).mockResolvedValue([]);
  vi.mocked(listHostedConnections).mockReset();
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] });
  vi.mocked(fetchWorkspace).mockReset();
  vi.mocked(fetchWorkspace).mockResolvedValue({
    id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null,
    welcomePrompt: "", subscriptionAgentsEnabled: true,
  });
  vi.mocked(fetchProviderLink).mockReset();
  vi.mocked(fetchProviderLink).mockResolvedValue(KEY_LINK);
  vi.mocked(fetchProviderChain).mockReset();
  vi.mocked(fetchProviderChain).mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(fetchProviderDefaultAi).mockReset();
  vi.mocked(fetchProviderDefaultAi).mockResolvedValue({ teamAgent: null, summary: null });
  vi.mocked(putProviderDefaultAi).mockReset();
  vi.mocked(deleteProviderLink).mockReset();
  vi.mocked(putProviderLink).mockReset();
  vi.mocked(testProviderLink).mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("한도·남은 크레딧 블록", () => {
  it("확인 전에도 oort 추정과 월 크레딧이 보이고, 공급사 숫자는 아직이라고 말한다", async () => {
    mount();
    const block = await until("ai-link-limits");
    await rtlWaitFor(() => expect(q("ai-link-limits-estimate")).not.toBeNull());
    expect(q("ai-link-limits-checked")?.textContent).toBe("확인 전");
    expect(q("ai-link-limits-provider-note")?.textContent).toContain("아직 확인하지 않았어요");
    const estimate = q("ai-link-limits-estimate-lines")?.textContent ?? "";
    expect(estimate).toContain("이번 달 oort가 집계한 사용액약 $32.50");
    expect(estimate).toContain("적어 둔 월 크레딧$100.00");
    expect(estimate).toContain("남은 양(추정)약 $67.50");
    expect(q("ai-link-limits-ratio")?.textContent).toContain("약 33% 사용");
    // 추정 칸은 공급사 잔액이 아니라고 이름으로 말한다.
    expect(q("ai-link-limits-estimate")?.textContent).toContain("Anthropic 전체 · 공급사 잔액이 아니에요");
    expect(q("ai-link-limits-unpriced")?.textContent).toContain("claude-mystery-9");
    expect(q("ai-link-limits-provider-note")?.textContent).toContain("키가 유효해도 크레딧이 남았다는 뜻은 아니니");
    const link = q("ai-link-limits-console") as HTMLAnchorElement;
    expect(link.href).toBe("https://platform.claude.com/settings/billing");
    expect(link.rel).toContain("noopener");
    expect(block.textContent).toContain("일반 API 키로 알려 주지 않아요");
  });

  it("연결 확인 뒤: 공급사가 알려 준 한도 숫자와 확인 시각, 새로고침이 다시 읽는다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(
      probeOf({ rateLimit: { source: "anthropic-ratelimit", requestsLimit: 50, requestsRemaining: 49 } }) as never
    );
    mount();
    await until("ai-link-limits");
    act(() => q("ai-link-check")?.click());
    await rtlWaitFor(() => expect(q("ai-link-limits-provider-lines")?.textContent).toContain("요청 한도50 중 49 남음"));
    expect(q("ai-link-limits-checked")?.textContent).toContain("확인");
    expect(q("ai-link-limits-checked")?.textContent).not.toBe("확인 전");
    expect(vi.mocked(testProviderLink)).toHaveBeenCalledTimes(1);
    act(() => q("ai-link-limits-refresh")?.click());
    await rtlWaitFor(() => expect(vi.mocked(testProviderLink)).toHaveBeenCalledTimes(2));
    await rtlWaitFor(() => expect(vi.mocked(fetchProviderLimits).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("헤더가 없으면 숫자를 지어내지 않고 못 받았다고 말한다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(probeOf({}) as never);
    mount();
    await until("ai-link-limits");
    act(() => q("ai-link-check")?.click());
    await rtlWaitFor(() => expect(q("ai-link-limits-provider-note")?.textContent).toContain("이 확인 호출은 한도 숫자를 주지 않았어요"));
    expect(q("ai-link-limits-provider-lines")).toBeNull();
  });

  it("크레딧·결제 문제는 키 탓이 아니라고 사람 말로 보인다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue({
      ...probeOf({ outcome: "no_credit", httpStatus: 402 }),
      ok: false,
      reason: "provider_no_credit",
      entries: [],
    } as never);
    mount();
    await until("ai-link-limits");
    act(() => q("ai-link-check")?.click());
    await rtlWaitFor(() => expect(q("ai-link-probe-text")?.textContent).toContain("키는 맞지만 크레딧이나 결제에 문제가 있어요."));
    expect(q("ai-link-probe-text")?.textContent).toContain("콘솔의 결제");
    expect(q("ai-link-probe")?.getAttribute("data-tone")).toBe("bad");
  });

  it("월 크레딧을 적어 저장하면 서버에 달러로 보내고, 잘못된 값은 보내지 않는다", async () => {
    vi.mocked(putProviderBudget).mockResolvedValue({ ...LIMITS, companies: LIMITS.companies.map((c) => (c.company === "anthropic" ? { ...c, monthlyBudgetMicroUsd: 200_000_000 } : c)) });
    mount();
    await until("ai-link-limits");
    await rtlWaitFor(() => expect(q("ai-link-limits-budget")).not.toBeNull());
    const input = q("ai-link-limits-budget") as HTMLInputElement;
    const set = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      act(() => {
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    set("abc");
    act(() => q("ai-link-limits-budget-save")?.click());
    expect(vi.mocked(putProviderBudget)).not.toHaveBeenCalled();
    await rtlWaitFor(() => expect(host?.textContent).toContain("달러 금액"));
    set("200");
    act(() => q("ai-link-limits-budget-save")?.click());
    await rtlWaitFor(() => expect(vi.mocked(putProviderBudget)).toHaveBeenCalledWith("anthropic", 200));
    await rtlWaitFor(() => expect(q("ai-link-limits-estimate-lines")?.textContent).toContain("$200.00"));
  });

  it("같은 회사 키가 둘이면 회사 단위 추정은 첫 키 아래에서만 그리고 나머지는 어디 있는지만 말한다", async () => {
    vi.mocked(fetchProviderChain).mockResolvedValue({
      schema: "momo.provider_link.chain.v0",
      entries: [
        { position: 1, baseUrl: "https://api.anthropic.com/v1", endpointLabel: "x", mode: "external-hermes", enabled: true, bearerConfigured: true, bearerLast4: "9d2a", updatedAtMs: 1_790_000_000_000 },
      ],
    } as never);
    mount();
    await until("ai-link-limits");
    await rtlWaitFor(() => expect(q("ai-team-hop-limits")).not.toBeNull());
    await rtlWaitFor(() => expect(q("ai-link-limits-estimate")).not.toBeNull());
    expect(q("ai-team-hop-limits-estimate")).toBeNull();
    expect(q("ai-team-hop-limits-budget")).toBeNull();
    expect(q("ai-team-hop-limits-estimate-elsewhere")?.textContent).toContain("맨 위 Anthropic 키 아래에 있어요");
  });

  it("추정을 받는 동안은 불러오는 중이라고, 못 받았을 때만 못 불러왔다고 말한다", async () => {
    vi.mocked(fetchProviderLimits).mockReturnValue(new Promise(() => undefined));
    mount();
    await until("ai-link-limits");
    await rtlWaitFor(() => expect(q("ai-link-limits-estimate-loading")).not.toBeNull());
    expect(q("ai-link-limits-estimate-pending")).toBeNull();
  });

  it("추정을 불러오지 못해도 표와 공급사 숫자는 그대로고, 못 불러왔다고 말한다", async () => {
    vi.mocked(fetchProviderLimits).mockRejectedValue(new ApiError(500, "boom"));
    mount();
    await until("ai-link-limits");
    await rtlWaitFor(() => expect(q("ai-link-limits-estimate-pending")).not.toBeNull());
    expect(q("ai-link-limits-estimate")).toBeNull();
    expect(q("ai-link-row")).not.toBeNull();
  });

  it("비운영자에게는 블록도 추정 호출도 없다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    mount();
    await until("operator-notice");
    expect(q("ai-link-limits")).toBeNull();
    expect(vi.mocked(fetchProviderLimits)).not.toHaveBeenCalled();
  });
});
