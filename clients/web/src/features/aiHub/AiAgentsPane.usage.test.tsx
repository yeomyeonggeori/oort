// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRoster, type RosterMember } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { listHostedConnections } from "@momo/core/features/hostedAgents/api";
import { AGENT_USAGE_COPY as COPY, fetchAgentUsage, type AgentUsageResponse } from "@momo/core/features/settings/agentUsage";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AiAgentsPane } from "./AiAgentsPane";

// #4986. 에이전트 표의 비용 칸은 열 머리가 이미 「비용」인데 줄마다 「이번 달 비용·토큰·작업 수:」를 되풀이했고, 읽기가 실패하면
// 같은 오류 문장이 행마다 서서 열한 줄에 열한 번 나왔다(디자인 검수 M6). 이 시험은 표(`AiAgentsPane`) 안에서 그 부품이 어떻게
// 서는지를 잰다: 성공이면 짧은 기간 말 하나, 실패면 행에는 아무것도 없고 목록 위의 한 줄이 한 번 말한다.
vi.mock("@/lib/env", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/env")>(), get SUBSCRIPTION_AGENTS_BUILD_FLAG() { return true; } }));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@momo/core/lib/api")>(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@momo/core/features/settings/api")>(), fetchWorkspace: vi.fn() }));
vi.mock("@momo/core/features/hostedAgents/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@momo/core/features/hostedAgents/api")>(), listHostedConnections: vi.fn() }));
vi.mock("@momo/core/features/settings/agentUsage", async (importOriginal) => ({ ...await importOriginal<typeof import("@momo/core/features/settings/agentUsage")>(), fetchAgentUsage: vi.fn() }));
vi.mock("@/features/common/useOffline", () => ({ useOffline: () => false }));

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const AGENTS = ["a1", "a2", "a3"];
const person = (id: string): RosterMember => ({ id, workspaceId: WS, kind: "human", status: "active", displayName: "곽성재", handle: "seongjae", role: "owner", channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 });
const bot = (id: string, name: string): RosterMember => ({ ...person(id), kind: "agent", displayName: name, handle: name, role: undefined, paused: false, brain: "team_key", callableBy: "everyone" });
const metrics = { runs: 3, reportedRuns: 3, promptTokens: 1000, completionTokens: 20, cachedTokens: 0, costMicroUsd: 1_500_000, unpricedRuns: 0, unpricedModels: [] as string[], estimatedRuns: 0, source: "measured" as const };
const USAGE: AgentUsageResponse = {
  range: { from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day" },
  agents: AGENTS.map((id) => ({ ...metrics, agentMemberId: id })),
  totals: { mine: metrics, shared: metrics, workspace: metrics }, hiddenPersonalAgents: 0,
};
const session: SessionContextValue = {
  session: { accessToken: "access", refreshToken: "refresh", member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" }, realtimeWebSocketUrl: "wss://example.test/connection/websocket" },
  workspaceId: WS, realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
};

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => { root?.render(createElement(MemoryRouter, { initialEntries: ["/ai/agents"] }, createElement(QueryClientProvider, { client }, createElement(SessionProvider, { value: session }, createElement(AiAgentsPane))))); });
}
const lines = () => [...document.querySelectorAll<HTMLElement>('[data-testid="agent-month-usage"]')];

beforeAll(() => { act_.IS_REACT_ACT_ENVIRONMENT = true; window.HTMLElement.prototype.scrollIntoView ??= () => undefined; });
beforeEach(() => {
  vi.mocked(fetchRoster).mockResolvedValue([person(ME), bot("a1", "김인턴"), bot("a2", "기록봇"), bot("a3", "정리봇")]);
  vi.mocked(listHostedConnections).mockResolvedValue({ connections: [] } as never);
  vi.mocked(fetchWorkspace).mockResolvedValue({ id: WS, slug: "team", name: "우리 팀", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove(); root = null; host = null; document.body.innerHTML = "";
  vi.resetAllMocks();
});

describe("에이전트 표의 월 사용량 줄 (#4986)", () => {
  it("성공하면 행마다 짧은 기간 말로 시작하고 긴 머리말은 한 번도 되풀이하지 않는다", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(USAGE);
    mount();
    await waitFor(() => expect(lines()).toHaveLength(AGENTS.length));
    for (const line of lines()) {
      // 금액의 모양은 비용 서식 한 곳(#4982)의 몫이라 여기서는 단정하지 않는다.
      expect(line.textContent!.startsWith(COPY.period + " · 비용 ")).toBe(true);
      expect(line.classList.contains("break-keep")).toBe(true);
      expect(line.closest('[data-testid^="ai-agent-cost-"]'), "비용 칸 안에 선다").toBeTruthy();
    }
    expect(document.body.textContent).not.toContain(COPY.title);
  });

  it("읽기가 실패하면 행에는 오류 문장이 없고 목록 위 한 줄이 한 번 말하고 다시 불러오기도 하나다", async () => {
    vi.mocked(fetchAgentUsage).mockRejectedValue(new Error("unavailable"));
    mount();
    await waitFor(() => expect(document.body.textContent).toContain(COPY.error));
    expect(lines()).toHaveLength(0);
    // 행이 세 줄이어도 오류 문장은 한 번이다.
    expect(document.body.textContent!.split(COPY.error)).toHaveLength(2);
    // 그 한 줄이 다음 행동(다시 불러오기)을 곁에 둔다.
    const reloads = [...document.querySelectorAll("button")].filter((b) => b.textContent === "다시 불러오기");
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.closest('[role="status"], div')?.textContent).toContain(COPY.error);
  });

  it("읽는 동안에도 행마다 같은 로딩 문장을 되풀이하지 않는다", async () => {
    vi.mocked(fetchAgentUsage).mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(document.body.textContent).toContain(COPY.loading));
    expect(lines()).toHaveLength(0);
    expect(document.body.textContent!.split(COPY.loading)).toHaveLength(2);
  });
});
