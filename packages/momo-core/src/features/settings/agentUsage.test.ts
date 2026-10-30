import { describe, expect, it, vi } from "vitest";
import { authedRequest } from "../../lib/api";
import {
  agentUsageLine, fetchAgentUsage, hiddenUsageLabel, parseAgentUsage,
  saveSubscriptionFee, subscriptionAmount, usageForAgent, usageLine, usageTags, usageUsd,
  type AgentUsageMetrics, type AgentUsageResponse,
} from "./agentUsage";

vi.mock("../../lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/api")>(), authedRequest: vi.fn(),
}));
const measured: AgentUsageMetrics = {
  runs: 2, reportedRuns: 2, promptTokens: 1000, completionTokens: 250, cachedTokens: 500,
  costMicroUsd: 1234567, unpricedRuns: 0, unpricedModels: [], estimatedRuns: 0, source: "measured",
};
const response: AgentUsageResponse = {
  range: { from: "2026-10-01T00:00:00Z", to: "2026-10-30T00:00:00Z", bucket: "day" },
  agents: [{ ...measured, agentMemberId: "ABC" }], totals: { mine: measured, shared: measured }, hiddenPersonalAgents: 3,
};

describe("agent usage model A", () => {
  it("formats micro USD, tokens without cache double counting, and honest source tags", () => {
    expect(usageUsd(1)).toContain("0.000001");
    expect(usageLine(measured)).toContain("토큰 1,250");
    expect(usageLine(measured)).toContain("캐시 토큰 500 (입력에 포함)");
    expect(usageTags(measured)).toEqual(["정확"]);
    const mixed = { ...measured, source: "self_reported" as const, estimatedRuns: 1, unpricedRuns: 1 };
    expect(usageTags(mixed)).toEqual(["자기 보고", "추정"]);
    expect(usageLine(mixed)).toContain("이상");
    expect(usageLine(mixed)).toContain("가격 미등록 1개 (비용에서 제외)");
    expect(usageTags({ ...measured, unpricedRuns: 1 })).not.toContain("정확");
  });
  it("keeps explicit zero distinct from unreported and subscription separate from spend", () => {
    expect(usageLine({ ...measured, promptTokens: 0, completionTokens: 0, costMicroUsd: 0 })).toContain("토큰 0");
    expect(usageLine({ ...measured, reportedRuns: 0, promptTokens: 0, completionTokens: 0 })).toContain("토큰 미보고");
    expect(usageTags({ ...measured, reportedRuns: 1 })).not.toContain("정확");
    const line = agentUsageLine({ ...measured, agentMemberId: "a", subscriptionFee: {monthlyMicroUsd: 20_000_000, label: null} });
    expect(line).toContain("1.234567"); expect(line).toContain("구독 US$20.00/월");
    expect(agentUsageLine({...measured, agentMemberId: "a"}, "subscription")).toContain("구독 (정액 정보 없음)");
  });
  it("retains only the server's visible set and count, without synthesizing workspace totals or identities", () => {
    const parsed = parseAgentUsage({ ...response, hiddenNames: ["private"] });
    expect(parsed.totals).not.toHaveProperty("workspace");
    expect(parsed.agents).toHaveLength(1);
    expect(usageForAgent(parsed, "AbC")?.agentMemberId).toBe("abc");
    expect(usageForAgent(parsed, "hidden")).toBeUndefined();
    expect(hiddenUsageLabel(parsed.hiddenPersonalAgents)).toBe("숨겨진 개인 에이전트 3개");
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(parseAgentUsage({...response, totals: {...response.totals, workspace: measured}}).totals.workspace).toEqual(measured);
  });
  it("rejects sabotaged missing, negative, nonnumeric or unknown source facts rather than fabricating zeros", () => {
    for (const sabotage of [{runs: undefined}, {costMicroUsd: -1}, {reportedRuns: "2"}, {source: "exact"}]) {
      expect(() => parseAgentUsage({...response, agents: [{...response.agents[0], ...sabotage}]})).toThrow();
    }
    expect(() => parseAgentUsage({...response, agents: undefined})).toThrow();
    expect(() => parseAgentUsage({...response, totals: {...response.totals, workspace: null}})).toThrow();
  });
  it("converts decimal fees exactly, supports clearing and rejects invalid amounts", () => {
    expect(subscriptionAmount("20.000001")).toBe(20_000_001);
    expect(subscriptionAmount("0")).toBe(0);
    expect(subscriptionAmount(" ")).toBeNull();
    for (const bad of ["-1", "1e2", "1.0000001", "NaN", "9007199254740992", "1000000.000001"]) expect(() => subscriptionAmount(bad)).toThrow();
  });
  it("reads the existing endpoint and writes a fee or explicit clear through authenticated transport", async () => {
    vi.mocked(authedRequest).mockResolvedValue({json: () => response} as never);
    expect((await fetchAgentUsage("w")).hiddenPersonalAgents).toBe(3);
    expect(authedRequest).toHaveBeenLastCalledWith("/v1/workspaces/w/usage/agents");
    vi.mocked(authedRequest).mockResolvedValue({json: () => ({agentMemberId: "a", subscriptionFee: null})} as never);
    await saveSubscriptionFee("w", "a", null);
    expect(authedRequest).toHaveBeenLastCalledWith("/v1/workspaces/w/agents/a/subscription-fee", expect.objectContaining({method: "PUT", body: '{"monthlyMicroUsd":null}'}));
  });
});
