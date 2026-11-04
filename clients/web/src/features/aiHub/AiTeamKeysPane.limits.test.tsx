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
  putProviderLink,
  testProviderLink,
} from "@momo/core/features/settings/api";
import { fetchProviderDefaultAi, putProviderDefaultAi } from "@momo/core/features/settings/defaultAi";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiTeamKeysPane } from "./AiTeamKeysPane";

// =============================================================================
// 「팀 AI 키」: 「한도·남은 크레딧」 블록을 걷고 콘솔 링크 한 줄만 남긴다 (#4110).
// Anthropic·OpenAI는 일반 API 키로 잔액·한도를 알려 주지 않는다. 화면은 숫자를 지어내지 않고
// 공급사 결제 화면으로만 보낸다.
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
    deleteProviderLink: vi.fn(),
    putProviderLink: vi.fn(),
    testProviderLink: vi.fn(),
  };
});
vi.mock("@momo/core/features/settings/defaultAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/defaultAi")>();
  return { ...actual, fetchProviderDefaultAi: vi.fn(), putProviderDefaultAi: vi.fn() };
});
// 「사용 한도」 칸(#5026)은 이 시험의 주제가 아니다: 한도 읽기를 모르는 서버처럼 답해 칸이 서지 않게 한다. 실제 네트워크로
// 가면 읽기 실패 안내(role="alert")가 이 화면의 다른 경고보다 앞에 서서 단정을 가로챈다. `vi.fn()` 이 아니라 평범한 함수인 까닭:
// `resetAllMocks` 가 구현을 비우면 `undefined` 가 돌아와 칸이 오류로 읽는다.
vi.mock("@momo/core/features/settings/teamAiLimits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/teamAiLimits")>();
  return { ...actual, fetchTeamAiLimitsBag: () => Promise.resolve({}) };
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

describe("키 줄 아래의 콘솔 링크 (#4110)", () => {
  it("Anthropic 키: 콘솔 링크 한 줄만 있고 한도·추정·월 크레딧 칸은 없다", async () => {
    mount();
    const link = (await until("ai-link-limits")) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.textContent).toContain("Anthropic 콘솔에서 크레딧 보기");
    expect(link.href).toBe("https://platform.claude.com/settings/billing");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    const text = host?.textContent ?? "";
    for (const gone of ["한도·남은 크레딧", "공급사가 알려 준 숫자", "oort 추정", "월 크레딧", "남은 양(추정)"]) {
      expect(text).not.toContain(gone);
    }
    expect(q("ai-link-limits-budget")).toBeNull();
    expect(q("ai-link-limits-estimate")).toBeNull();
    expect(q("ai-link-limits-refresh")).toBeNull();
    // 추정 호출도 하지 않는다.
    expect(vi.mocked(fetchProviderLimits)).not.toHaveBeenCalled();
  });

  it("OpenAI 키도 같은 규칙: 결제 화면 링크 한 줄", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue({ ...KEY_LINK, baseUrl: "https://api.openai.com/v1", endpointLabel: "https://api.openai.com/v1" });
    mount();
    const link = (await until("ai-link-limits")) as HTMLAnchorElement;
    expect(link.textContent).toContain("OpenAI 결제 화면 열기");
    expect(link.href).toBe("https://platform.openai.com/settings/organization/billing/overview");
  });

  it("알려진 공급사 주소가 아니면 보낼 곳이 없으니 링크도 없다", async () => {
    vi.mocked(fetchProviderLink).mockResolvedValue({ ...KEY_LINK, baseUrl: "https://llm.corp.example/v1", endpointLabel: "https://llm.corp.example/v1" });
    mount();
    await until("ai-link-row");
    expect(q("ai-link-limits")).toBeNull();
  });

  it("연결 확인 뒤에도 공급사 숫자 칸은 생기지 않는다", async () => {
    vi.mocked(testProviderLink).mockResolvedValue(
      probeOf({ rateLimit: { source: "anthropic-ratelimit", requestsLimit: 50, requestsRemaining: 49 } }) as never
    );
    mount();
    await until("ai-link-limits");
    act(() => q("ai-link-check")?.click());
    await rtlWaitFor(() => expect(vi.mocked(testProviderLink)).toHaveBeenCalledTimes(1));
    await until("ai-link-probe-text");
    expect(host?.textContent).not.toContain("요청 한도");
    expect(host?.textContent).not.toContain("공급사가 알려 준 숫자");
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

  it("같은 회사 키가 둘이면 키마다 콘솔 링크 한 줄씩", async () => {
    vi.mocked(fetchProviderChain).mockResolvedValue({
      schema: "momo.provider_link.chain.v0",
      entries: [
        { position: 1, baseUrl: "https://api.anthropic.com/v1", endpointLabel: "x", mode: "external-hermes", enabled: true, bearerConfigured: true, bearerLast4: "9d2a", updatedAtMs: 1_790_000_000_000 },
      ],
    } as never);
    mount();
    await until("ai-link-limits");
    const hop = (await until("ai-team-hop-limits")) as HTMLAnchorElement;
    expect(hop.href).toBe("https://platform.claude.com/settings/billing");
    expect(q("ai-team-hop-limits-estimate-elsewhere")).toBeNull();
  });

  it("비운영자에게는 링크도 추정 호출도 없다", async () => {
    vi.mocked(fetchProviderLink).mockRejectedValue(new ApiError(403, "forbidden"));
    mount();
    await until("operator-notice");
    expect(q("ai-link-limits")).toBeNull();
    expect(vi.mocked(fetchProviderLimits)).not.toHaveBeenCalled();
  });
});
