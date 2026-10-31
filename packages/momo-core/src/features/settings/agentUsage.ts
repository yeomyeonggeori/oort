import { authedRequest } from "../../lib/api";
import { formatMicroUsd, MICRO_USD_FLOOR } from "../timeline/agentCardModel";

/** Structural projection of usage.generated.ts. No identities are supplied by this endpoint. */
export interface AgentUsageMetrics {
  runs: number;
  reportedRuns: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
  unpricedRuns: number;
  unpricedModels: string[];
  estimatedRuns: number;
  source: "measured" | "self_reported" | null;
}
export interface SubscriptionFee { monthlyMicroUsd: number; label: string | null }
export interface AgentUsage extends AgentUsageMetrics {
  agentMemberId: string;
  subscriptionFee?: SubscriptionFee;
}
export interface AgentUsageResponse {
  range: { from: string; to: string; bucket: "day" | "week" | "month" };
  agents: AgentUsage[];
  totals: { mine: AgentUsageMetrics; shared: AgentUsageMetrics; workspace?: AgentUsageMetrics };
  hiddenPersonalAgents: number;
}

export const AGENT_USAGE_COPY = {
  title: "이번 달 비용·토큰·작업 수",
  /** 목록·표 안의 줄이 머리말 대신 붙이는 말. 표 머리가 이미 「비용」이라 긴 머리말을 줄마다 되풀이하지 않는다 (#4986). */
  period: "이번 달",
  report: "에이전트 월 보고",
  loading: "이번 달 사용량을 불러오고 있어요.",
  offline: "연결되면 이번 달 사용량을 불러올게요.",
  error: "이번 달 사용량을 불러오지 못했어요. 연결을 확인하고 다시 불러와 주세요.",
  unavailable: "볼 수 있는 사용량 정보가 없어요.",
  empty: "이번 달에 기록된 작업이 없어요.",
  note: "UTC 기준 월 보고예요. 비용은 토큰과 등록 가격으로 계산하며, 구독 정액은 더하지 않아요. 공급사 청구서와 다를 수 있어요.",
  subscription: "구독 정액 (월 USD)",
  saveError: "구독 정액을 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
  saved: "구독 정액을 저장했어요.",
  saveForbidden: "이 계정은 구독 정액을 고칠 수 없어요. 워크스페이스 관리자에게 부탁해 주세요.",
  saveConflict: "다른 곳에서 먼저 바뀌었어요. 다시 불러온 뒤에 고쳐 주세요.",
  rosterError: "에이전트 이름을 불러오지 못해서 줄마다 이름이 비어 있어요. 다시 불러와 주세요.",
} as const;

const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);
export function usageTags(row: AgentUsageMetrics): string[] {
  const tags: string[] = [];
  if (row.source === "self_reported") tags.push("자기 보고");
  if (row.estimatedRuns > 0 || row.unpricedRuns > 0) tags.push("추정");
  if (row.source === "measured" && row.estimatedRuns === 0 && row.unpricedRuns === 0 && row.reportedRuns === row.runs) tags.push("정확");
  return tags;
}

export function usageLine(row: AgentUsageMetrics): string {
  const tags = usageTags(row);
  // 「이상」 은 합계가 모자랄 수 있다는 말이다. 이미 「미만」 으로 상한을 말한 금액에는 붙이지 않는다(「$0.001 미만 이상」은 문장이 아니다).
  const atLeast = (row.estimatedRuns > 0 || row.unpricedRuns > 0 || row.reportedRuns < row.runs) && row.costMicroUsd >= MICRO_USD_FLOOR;
  // 같은 비용은 어디서나 같게 적힌다(#4982): 스레드 카드·결정 무대·웹 사용량이 쓰는 `formatMicroUsd` 하나뿐이다. 여기에 둘째 서식(Intl
  // 통화, 「US$1.234567」)이 있던 것이 한 금액을 두 모양으로 적던 원인이다.
  const parts = [
    row.reportedRuns > 0 ? `비용 ${formatMicroUsd(row.costMicroUsd)}${atLeast ? " 이상" : ""}` : "비용 미보고",
    row.reportedRuns > 0 ? `토큰 ${count(row.promptTokens + row.completionTokens)}` : "토큰 미보고",
    `작업 ${count(row.runs)}개`,
    ...tags,
  ];
  if (row.cachedTokens > 0) parts.push(`캐시 토큰 ${count(row.cachedTokens)} (입력에 포함)`);
  if (row.unpricedRuns > 0) parts.push(`가격 미등록 ${count(row.unpricedRuns)}개 (비용에서 제외)`);
  if (row.runs > row.reportedRuns) parts.push(`토큰 미보고 ${count(row.runs - row.reportedRuns)}개`);
  return parts.join(" · ");
}

export function agentUsageLine(row: AgentUsage, brain?: string): string {
  const base = row.runs === 0 ? AGENT_USAGE_COPY.empty : usageLine(row);
  return row.subscriptionFee
    ? `${base} · 구독 ${formatMicroUsd(row.subscriptionFee.monthlyMicroUsd)}/월`
    : brain === "subscription" ? `${base} · 구독 (정액 정보 없음)` : base;
}
export function hiddenUsageLabel(countHidden: number): string | null {
  return countHidden > 0 ? `숨겨진 개인 에이전트 ${count(countHidden)}개` : null;
}
export function usageForAgent(data: AgentUsageResponse, id: string): AgentUsage | undefined {
  return data.agents.find(row => row.agentMemberId.toLowerCase() === id.toLowerCase());
}

/** Blank clears; decimal USD is converted exactly at the six-digit wire precision. */
export function subscriptionAmount(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("0 이상의 USD 금액을 소수 여섯 자리까지 적어 주세요.");
  const [whole = "0", fraction = ""] = value.split(".");
  const micro = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(micro) || micro > 1_000_000_000_000) throw new Error("월 정액은 1,000,000 USD 이하로 적어 주세요.");
  return micro;
}

export function agentUsageKey(workspaceId: string) {
  // The UTC month is part of the cache identity, including across a month rollover.
  return ["agent-usage", workspaceId.toLowerCase(), new Date().toISOString().slice(0, 7)] as const;
}

export async function fetchAgentUsage(workspaceId: string): Promise<AgentUsageResponse> {
  const response = await authedRequest(`/v1/workspaces/${encodeURIComponent(workspaceId)}/usage/agents`);
  return parseAgentUsage(response.json<unknown>());
}
export async function saveSubscriptionFee(workspaceId: string, agentId: string, monthlyMicroUsd: number | null) {
  const response = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/subscription-fee`,
    { method: "PUT", body: JSON.stringify({ monthlyMicroUsd }), headers: { "Content-Type": "application/json" } },
  );
  const result = record(response.json<unknown>());
  if (typeof result.agentMemberId !== "string") throw new Error(COPY_ERROR);
  return { agentMemberId: result.agentMemberId, subscriptionFee: result.subscriptionFee === null ? null : fee(result.subscriptionFee) };
}

const COPY_ERROR = "사용량 응답을 읽지 못했어요.";
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(COPY_ERROR);
  return raw as Record<string, unknown>;
}
function number(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(COPY_ERROR);
  return value;
}
function fee(raw: unknown): SubscriptionFee {
  const row = record(raw);
  if (row.label !== null && typeof row.label !== "string") throw new Error(COPY_ERROR);
  return { monthlyMicroUsd: number(row, "monthlyMicroUsd"), label: row.label };
}
function metrics(raw: unknown): AgentUsageMetrics {
  const row = record(raw);
  if (row.source !== null && row.source !== "measured" && row.source !== "self_reported") throw new Error(COPY_ERROR);
  if (!Array.isArray(row.unpricedModels) || !row.unpricedModels.every(model => typeof model === "string")) throw new Error(COPY_ERROR);
  return {
    runs: number(row, "runs"), reportedRuns: number(row, "reportedRuns"),
    promptTokens: number(row, "promptTokens"), completionTokens: number(row, "completionTokens"),
    cachedTokens: number(row, "cachedTokens"), costMicroUsd: number(row, "costMicroUsd"),
    unpricedRuns: number(row, "unpricedRuns"), unpricedModels: row.unpricedModels,
    estimatedRuns: number(row, "estimatedRuns"), source: row.source,
  };
}
/** Missing or malformed facts fail closed, rather than becoming a false zero or workspace total. */
export function parseAgentUsage(raw: unknown): AgentUsageResponse {
  const root = record(raw);
  const range = record(root.range);
  const totals = record(root.totals);
  if (typeof range.from !== "string" || !Number.isFinite(Date.parse(range.from)) ||
      typeof range.to !== "string" || !Number.isFinite(Date.parse(range.to)) ||
      (range.bucket !== "day" && range.bucket !== "week" && range.bucket !== "month") ||
      !Array.isArray(root.agents)) throw new Error(COPY_ERROR);
  return {
    range: { from: range.from, to: range.to, bucket: range.bucket },
    agents: root.agents.map(rawRow => {
      const row = record(rawRow);
      if (typeof row.agentMemberId !== "string") throw new Error(COPY_ERROR);
      return { ...metrics(row), agentMemberId: row.agentMemberId.toLowerCase(),
        ...(row.subscriptionFee === undefined ? {} : { subscriptionFee: fee(row.subscriptionFee) }) };
    }),
    totals: { mine: metrics(totals.mine), shared: metrics(totals.shared),
      ...(totals.workspace === undefined ? {} : { workspace: metrics(totals.workspace) }) },
    hiddenPersonalAgents: number(root, "hiddenPersonalAgents"),
  };
}
