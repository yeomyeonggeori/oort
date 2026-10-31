// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  AGENT_USAGE_COPY as COPY, fetchAgentUsage, saveSubscriptionFee,
  type AgentUsageResponse,
} from "@momo/core/features/settings/agentUsage";
import type { components } from "@/lib/usage.generated";
import { AgentMonthlyReport, AgentUsageLine } from "./AgentUsage";

vi.mock("@momo/core/features/settings/agentUsage", async importOriginal => ({
  ...await importOriginal<typeof import("@momo/core/features/settings/agentUsage")>(),
  fetchAgentUsage: vi.fn(), saveSubscriptionFee: vi.fn(),
}));
vi.mock("@/app/session", () => ({useSession: () => ({workspaceId: "w"})}));
vi.mock("@/features/workspace/useWorkspace", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/workspace/useWorkspace")>(),
  useDirectory: () => ({directory: makeDirectory([
    {id: "a", displayName: "기록 도우미", handle: "scribe", kind: "agent", callableBy: "everyone"} as never,
    {id: "b", displayName: "개인 도우미", handle: "personal", kind: "agent", callableBy: "owner_only"} as never,
  ])}),
}));

type Generated = components["schemas"]["AgentUsageResponse"];
// Both directions pin the core projection to the unchanged #4816 generated contract.
const sameContract: AgentUsageResponse extends Generated ? Generated extends AgentUsageResponse ? true : never : never = true;
const metrics: components["schemas"]["AgentUsageMetrics"] = {
  runs: 1, reportedRuns: 1, promptTokens: 1000, completionTokens: 20, cachedTokens: 50,
  costMicroUsd: 1000000, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 0, source: "measured",
};
function data(admin = false): Generated {
  return {range: {from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day"},
    agents: [{...metrics, agentMemberId: "a"}, {...metrics, agentMemberId: "b"}],
    totals: {mine: metrics, shared: metrics, ...(admin ? {workspace: metrics} : {})}, hiddenPersonalAgents: admin ? 0 : 3};
}
let client: QueryClient;
function mount(line = false) {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  return render(<QueryClientProvider client={client}>{line ? <AgentUsageLine agentId="A" /> : <AgentMonthlyReport workspaceId="w" />}</QueryClientProvider>);
}
afterEach(() => {cleanup(); client?.clear(); onlineManager.setOnline(true); vi.resetAllMocks();});

describe("agent month usage", () => {
  it("has loading, error/retry, empty and offline states", async () => {
    vi.mocked(fetchAgentUsage).mockReturnValueOnce(new Promise(() => {}));
    const mounted = mount();
    expect(screen.getByText(COPY.loading)).toBeTruthy();
    mounted.unmount(); client.clear();
    vi.mocked(fetchAgentUsage).mockRejectedValueOnce(new Error("unavailable"));
    mount();
    await screen.findByText(COPY.error);
    vi.mocked(fetchAgentUsage).mockResolvedValue({...data(), agents: []});
    fireEvent.click(screen.getByRole("button", {name: "다시 불러오기"}));
    await screen.findByText(COPY.empty);
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByRole("button", {name: "다시 불러오기"}));
    await screen.findByText(COPY.offline);
  });
  it("honors the generated model A: hidden count only, no workspace total or fee controls for members", async () => {
    expect(sameContract).toBe(true);
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount();
    await screen.findByText("숨겨진 개인 에이전트 3개");
    expect(screen.queryByText(/워크스페이스 전체/)).toBeNull();
    expect(screen.queryByLabelText(COPY.subscription)).toBeNull();
    expect(screen.getAllByText(/정확/).length).toBeGreaterThan(0);
    expect(screen.getByText("기록 도우미 (@scribe)")).toBeTruthy();
  });
  it("lets admins save/clear shared fees and keeps a refused draft for retry", async () => {
    vi.mocked(fetchAgentUsage).mockResolvedValue(data(true)); mount();
    const input = await screen.findByLabelText(COPY.subscription);
    expect(screen.getAllByLabelText(COPY.subscription)).toHaveLength(1);
    fireEvent.change(input, {target: {value: "20.000001"}});
    vi.mocked(saveSubscriptionFee).mockRejectedValueOnce(new Error("403"));
    fireEvent.click(screen.getByRole("button", {name: "저장"}));
    await screen.findByText(COPY.saveError);
    expect((input as HTMLInputElement).value).toBe("20.000001");
    vi.mocked(saveSubscriptionFee).mockResolvedValue({agentMemberId: "a", subscriptionFee: null});
    fireEvent.change(input, {target: {value: ""}});
    fireEvent.click(screen.getByRole("button", {name: "저장"}));
    await waitFor(() => expect(saveSubscriptionFee).toHaveBeenLastCalledWith("w", "a", null));
    await screen.findByText(COPY.saved);
  });
  it("carries no edge inset of its own: hub cells and rows give it theirs, so a second one would double it (#4912 R12)", async () => {
    // 프로필 대화의 틀(`AgentProfileDialog.usage.test.tsx`)만 `className` 으로 여백을 준다. 부품 기본에 `px-4` 를 넣으면
    // 허브 표 칸(`AiAgentsPane`)·허브 상세(`AgentHubRoute`)의 줄이 안으로 한 번 더 들어간다.
    vi.mocked(fetchAgentUsage).mockResolvedValue(data()); mount(true);
    const line = await screen.findByTestId("agent-month-usage");
    expect([...line.classList].filter(token => /^-?(?:p|px|pl|ps|m|mx|ml|ms)-/.test(token))).toEqual([]);
  });
  it("joins profiles case-insensitively and labels mixed/self-reported costs honestly", async () => {
    const response = data();
    response.agents[0] = {...response.agents[0]!, source: "self_reported", estimatedRuns: 1, subscriptionFee: {monthlyMicroUsd: 20000000, label: null}};
    vi.mocked(fetchAgentUsage).mockResolvedValue(response); mount(true);
    const line = await screen.findByTestId("agent-month-usage");
    await waitFor(() => expect(line.textContent).toContain("자기 보고 · 추정"));
    expect(line.textContent).toContain("구독 $20.00/월");
    expect(line.textContent).not.toContain("정확");
  });
});
