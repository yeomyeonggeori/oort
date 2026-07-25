// =============================================================================
// 사용량 요약의 순수 로직 (AX-7 1층 / MOMO-616).
//
// 계약 정본: docs/planning/handoffs/2026-07-25-usage-summary-contract.md
//   GET /v1/workspaces/:ws/usage/summary?from=<ISO>&to=<ISO>&bucket=day|week|month
//
// This file holds every decision the 사용량 panel makes, with no React and no
// network, so usageModel.test.ts can pin the contract against fixtures while the
// engine ticket (MOMO-615) implements the route in parallel.
//
// Three rules the numbers live under:
//   - nothing is derived that the server did not send. An absent field renders
//     as absent; a cost the server never reported is never extrapolated.
//   - `estimatedMicroUsd` is a SUBSET of `costMicroUsd` (was_estimated=true
//     부분합), so the confidence split is settled = total - estimated. Showing
//     them added together would double count and overstate the bill.
//   - budget state comes from the server's own `limit_state` (spent + reserved
//     vs limit, CostProjectionRoutes.limitState). The client never recomputes
//     which side of a limit a workspace is on.
// =============================================================================

/** Time grain the server aggregates into. `month` exists in the contract but
 *  is not offered for the 7/30-day ranges this panel asks for. */
export type UsageBucketUnit = "day" | "week" | "month";

export type BudgetState = "normal" | "soft_limit" | "hard_limit";

export interface UsageRange {
  from: string;
  to: string;
  bucket: UsageBucketUnit;
}

export interface UsageTotals {
  /** was_estimated 포함 합계. */
  costMicroUsd: number;
  /** was_estimated=true 부분합, i.e. the part of the total that is not billed yet. */
  estimatedMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageBucket {
  start: string;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageByModel {
  model: string;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageByAgent {
  /** Server UUID: compare with uuidEq, never ===. Kept lower-cased on parse. */
  agentMemberId: string;
  displayName: string;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageBudget {
  grain: string;
  limitMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  state: BudgetState;
  periodStart: string;
}

export interface UsageSummary {
  range: UsageRange;
  totals: UsageTotals;
  buckets: UsageBucket[];
  byModel: UsageByModel[];
  byAgent: UsageByAgent[];
  budget: UsageBudget | null;
}

// ---- parsing ---------------------------------------------------------------
//
// Tolerant on absence, strict on shape. The contract lets the engine tune field
// names as it lands, and a panel that throws on one unexpected key would take
// the whole settings route down; a panel that invents numbers would lie. So a
// missing list reads as an empty list, a missing number reads as 0, and a body
// that is not an object at all is refused.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(source: Record<string, unknown> | null, key: string): number {
  const raw = source?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function str(source: Record<string, unknown> | null, key: string): string {
  const raw = source?.[key];
  return typeof raw === "string" ? raw : "";
}

function list(source: Record<string, unknown> | null, key: string): unknown[] {
  const raw = source?.[key];
  return Array.isArray(raw) ? raw : [];
}

function parseBucketUnit(raw: string): UsageBucketUnit {
  return raw === "week" || raw === "month" ? raw : "day";
}

function parseBudgetState(raw: string): BudgetState {
  return raw === "soft_limit" || raw === "hard_limit" ? raw : "normal";
}

export function parseUsageSummary(raw: unknown): UsageSummary {
  const root = asRecord(raw);
  if (!root) throw new Error("사용량 응답을 읽지 못했습니다.");

  const range = asRecord(root["range"]);
  const totals = asRecord(root["totals"]);
  const budget = asRecord(root["budget"]);

  return {
    range: {
      from: str(range, "from"),
      to: str(range, "to"),
      bucket: parseBucketUnit(str(range, "bucket")),
    },
    totals: {
      costMicroUsd: num(totals, "costMicroUsd"),
      estimatedMicroUsd: num(totals, "estimatedMicroUsd"),
      promptTokens: num(totals, "promptTokens"),
      completionTokens: num(totals, "completionTokens"),
    },
    buckets: list(root, "buckets").map((item) => {
      const row = asRecord(item);
      return {
        start: str(row, "start"),
        costMicroUsd: num(row, "costMicroUsd"),
        promptTokens: num(row, "promptTokens"),
        completionTokens: num(row, "completionTokens"),
      };
    }),
    byModel: list(root, "byModel").map((item) => {
      const row = asRecord(item);
      return {
        model: str(row, "model"),
        costMicroUsd: num(row, "costMicroUsd"),
        promptTokens: num(row, "promptTokens"),
        completionTokens: num(row, "completionTokens"),
      };
    }),
    byAgent: list(root, "byAgent").map((item) => {
      const row = asRecord(item);
      return {
        // Lower-cased on the way in: the server returns upper-case UUIDs and
        // this id is a React key and a roster join key.
        agentMemberId: str(row, "agentMemberId").toLowerCase(),
        displayName: str(row, "displayName"),
        costMicroUsd: num(row, "costMicroUsd"),
        promptTokens: num(row, "promptTokens"),
        completionTokens: num(row, "completionTokens"),
      };
    }),
    budget: budget
      ? {
          grain: str(budget, "grain"),
          limitMicroUsd: num(budget, "limitMicroUsd"),
          spentMicroUsd: num(budget, "spentMicroUsd"),
          reservedMicroUsd: num(budget, "reservedMicroUsd"),
          state: parseBudgetState(str(budget, "state")),
          periodStart: str(budget, "periodStart"),
        }
      : null,
  };
}

// ---- the query the panel asks ----------------------------------------------

export type UsagePeriodId = "7d" | "30d";

export interface UsagePeriod {
  id: UsagePeriodId;
  label: string;
  days: number;
}

/** Two ranges, not a date picker: this is a settings panel, not a report tool.
 *  Both are far inside the contract's 93-day ceiling. */
export const USAGE_PERIODS: UsagePeriod[] = [
  { id: "7d", label: "7일", days: 7 },
  { id: "30d", label: "30일", days: 30 },
];

export interface UsageBucketChoice {
  id: UsageBucketUnit;
  label: string;
}

export const USAGE_BUCKETS: UsageBucketChoice[] = [
  { id: "day", label: "일별" },
  { id: "week", label: "주별" },
];

export interface UsageQuery {
  from: string;
  to: string;
  bucket: UsageBucketUnit;
}

const DAY_MS = 86_400_000;

export function usageQuery(
  period: UsagePeriodId,
  bucket: UsageBucketUnit,
  nowMs: number
): UsageQuery {
  const days = USAGE_PERIODS.find((p) => p.id === period)?.days ?? 30;
  return {
    from: new Date(nowMs - days * DAY_MS).toISOString(),
    to: new Date(nowMs).toISOString(),
    bucket,
  };
}

// ---- formatting -------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar day from an ISO instant. Unparseable input is returned as is
 *  rather than rendered as "Invalid Date". */
export function formatIsoDay(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local day and clock, used for "언제 확인한 값인가". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${formatIsoDay(d.toISOString())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRange(range: UsageRange): string {
  const unit = USAGE_BUCKETS.find((b) => b.id === range.bucket)?.label ?? "일별";
  return `${formatIsoDay(range.from)} ~ ${formatIsoDay(range.to)} · ${unit}`;
}

/** One bucket's label, at the grain the bucket actually covers. */
export function formatBucketStart(start: string, bucket: UsageBucketUnit): string {
  const day = formatIsoDay(start);
  if (bucket === "week") return `${day} 주`;
  if (bucket === "month") return day.slice(0, 7);
  return day;
}

/** Whole-percent share, floored so a rounded 100% never hides a remainder. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.floor((part / whole) * 100);
}

export function relativeSince(thenMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - thenMs);
  if (elapsed < 60_000) return "방금";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

// ---- derivations the panel renders ------------------------------------------

/** A period with no ledger rows is a 200 with zeros (contract), not a 404. */
export function isEmptyUsage(summary: UsageSummary): boolean {
  return (
    summary.totals.costMicroUsd === 0 &&
    summary.totals.promptTokens === 0 &&
    summary.totals.completionTokens === 0 &&
    summary.byModel.length === 0 &&
    summary.byAgent.length === 0
  );
}

/**
 * Settled versus estimated. `estimatedMicroUsd` is the part of the total the
 * provider has not reconciled yet, so the settled part is the difference; it is
 * clamped at 0 because a server that reports an estimate larger than the total
 * is reporting something we must not turn into a negative charge.
 */
export interface CostConfidence {
  settledMicroUsd: number;
  estimatedMicroUsd: number;
  estimatedPercent: number;
  allSettled: boolean;
}

export function costConfidence(totals: UsageTotals): CostConfidence {
  const estimated = Math.max(0, totals.estimatedMicroUsd);
  const settled = Math.max(0, totals.costMicroUsd - estimated);
  return {
    settledMicroUsd: settled,
    estimatedMicroUsd: estimated,
    estimatedPercent: percentOf(estimated, totals.costMicroUsd),
    allSettled: estimated === 0,
  };
}

/** The most expensive bucket in the range, or null when nothing was spent. */
export function peakBucket(buckets: UsageBucket[]): UsageBucket | null {
  let peak: UsageBucket | null = null;
  for (const bucket of buckets) {
    if (bucket.costMicroUsd <= 0) continue;
    if (!peak || bucket.costMicroUsd > peak.costMicroUsd) peak = bucket;
  }
  return peak;
}

/** Bar length for a breakdown row: share of the largest row, not of the total,
 *  so a long tail is still readable. Returns 0..100 for a <progress> value. */
export function barShare(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(1, Math.round((value / max) * 100));
}

export function largestCost(rows: { costMicroUsd: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.costMicroUsd), 0);
}

// ---- budget ------------------------------------------------------------------

export interface BudgetStatus {
  tone: "ok" | "warn" | "danger";
  label: string;
  detail: string;
  /** spent + reserved, the same figure the server compares against the limit. */
  observedMicroUsd: number;
  /** 0..100 for the <progress> value; over-limit clamps to 100. */
  usedPercent: number;
}

const GRAIN_LABELS: Record<string, string> = {
  workspace: "워크스페이스 전체",
  agent: "에이전트별",
  channel: "채널별",
  workspace_agent: "워크스페이스의 에이전트별",
  agent_channel: "에이전트와 채널별",
};

export function budgetGrainLabel(grain: string): string {
  return GRAIN_LABELS[grain] ?? grain;
}

/**
 * Budget copy. It states where the number stands and what to do next, and it
 * does NOT claim the server blocks anything: `limit_state` is a projection over
 * the ledger, and enforcement is a separate contract that does not exist yet.
 * Saying "실행이 막힙니다" here would be a story the system does not back.
 */
export function budgetStatus(
  budget: UsageBudget,
  formatCost: (microUsd: number) => string
): BudgetStatus {
  const observed = budget.spentMicroUsd + budget.reservedMicroUsd;
  const limit = formatCost(budget.limitMicroUsd);
  const used = formatCost(observed);
  const usedPercent = Math.min(100, percentOf(observed, budget.limitMicroUsd));

  if (budget.state === "hard_limit") {
    return {
      tone: "danger",
      label: "한도 도달",
      detail: `예약을 포함한 사용액 ${used}이 한도 ${limit}에 닿았습니다. 예산을 다시 정하거나 다음 기간을 기다리세요.`,
      observedMicroUsd: observed,
      usedPercent,
    };
  }
  if (budget.state === "soft_limit") {
    return {
      tone: "warn",
      label: "주의",
      detail: `한도 ${limit} 중 ${used}을 썼습니다. 소프트 한도를 넘었습니다.`,
      observedMicroUsd: observed,
      usedPercent,
    };
  }
  return {
    tone: "ok",
    label: "한도 안",
    detail: `한도 ${limit} 중 ${used}을 썼습니다.`,
    observedMicroUsd: observed,
    usedPercent,
  };
}

// ---- failure copy -----------------------------------------------------------

/**
 * Two answers this endpoint gives that a generic "HTTP 404" would waste.
 *
 * 404 is the live case while the engine ticket lands: a server built before the
 * route existed answers 404, and "이 서버에는 아직 없다" plus what to do is a
 * useful sentence where a status code is not. 400 is the contract's own range
 * ceiling (93일), which the person can fix from the control right above.
 */
export function usageErrorCopy(status: number | null, fallback: string): string {
  if (status === 404) {
    return "이 서버는 아직 사용량 집계를 제공하지 않습니다. 서버를 업데이트한 뒤 다시 열어보세요.";
  }
  if (status === 400) {
    return "서버가 이 기간을 받지 않았습니다. 기간을 좁혀 다시 시도하세요.";
  }
  return fallback;
}

// ---- 마지막 확인값 (the durability layer, P15) --------------------------------
//
// A failed read does not blank a surface that already had an answer. The last
// successful response per workspace is kept in memory with the instant it
// arrived, and the panel renders it with that instant stated: cached content
// keeps rendering, undimmed, and the person is told it is not live.
//
// Memory only, never storage: this is a session-lifetime durability aid, and
// `forgetUsage()` runs on sign-out beside queryClient.clear() so no workspace's
// costs survive into the next session in the same tab.

export interface LastKnownUsage {
  summary: UsageSummary;
  checkedAtMs: number;
}

const lastKnown = new Map<string, LastKnownUsage>();

function workspaceKey(workspaceId: string): string {
  return workspaceId.toLowerCase();
}

export function rememberUsage(
  workspaceId: string,
  summary: UsageSummary,
  checkedAtMs: number
): void {
  lastKnown.set(workspaceKey(workspaceId), { summary, checkedAtMs });
}

export function recallUsage(workspaceId: string): LastKnownUsage | null {
  return lastKnown.get(workspaceKey(workspaceId)) ?? null;
}

/** All workspaces, or one. Called on sign-out. */
export function forgetUsage(workspaceId?: string): void {
  if (workspaceId === undefined) lastKnown.clear();
  else lastKnown.delete(workspaceKey(workspaceId));
}

// ---- which of the four states the panel is in --------------------------------

export interface UsageViewInput {
  /** react-query isPending: no answer yet for the range currently selected. */
  pending: boolean;
  data: UsageSummary | null;
  /** When `data` arrived. react-query keeps data across a failed refetch, and
   *  that data is by definition a last-known value, not a live one. */
  dataUpdatedAtMs: number;
  /** Already mapped to Korean copy by the caller (errorMessage in ./model). */
  errorMessage: string | null;
  /** Realtime rail is down. REST may still answer, so this only decides copy. */
  offline: boolean;
  lastKnown: LastKnownUsage | null;
  nowMs: number;
}

export type UsageView =
  | { kind: "loading" }
  | { kind: "ready"; summary: UsageSummary; empty: boolean }
  | {
      kind: "last-known";
      summary: UsageSummary;
      empty: boolean;
      notice: string;
      checkedAtMs: number;
    }
  | { kind: "error"; message: string };

const OFFLINE_REASON = "연결이 끊겼습니다.";
const OFFLINE_EMPTY =
  "연결이 끊겼습니다. 다시 연결되면 사용량을 불러옵니다.";

function lastKnownView(
  cached: LastKnownUsage,
  reason: string,
  nowMs: number
): UsageView {
  return {
    kind: "last-known",
    summary: cached.summary,
    empty: isEmptyUsage(cached.summary),
    notice: `${reason} 마지막으로 확인한 값(${relativeSince(
      cached.checkedAtMs,
      nowMs
    )})을 표시합니다.`,
    checkedAtMs: cached.checkedAtMs,
  };
}

/**
 * Fresh data always wins. A failure falls back to the last confirmed answer
 * when there is one, and only says "불러오지 못했습니다" with nothing to show
 * when there is not. A range that is still loading shows bars rather than the
 * previous range's numbers, because a stale total under a new range label is
 * the one thing worse than waiting.
 */
export function usageView(input: UsageViewInput): UsageView {
  if (input.data) {
    // A refresh that failed leaves the previous answer on screen. It keeps
    // rendering, but it is labelled: silently passing an old total off as the
    // current bill is the failure mode this whole fallback exists to prevent.
    if (input.errorMessage) {
      return lastKnownView(
        { summary: input.data, checkedAtMs: input.dataUpdatedAtMs || input.nowMs },
        input.errorMessage,
        input.nowMs
      );
    }
    return {
      kind: "ready",
      summary: input.data,
      empty: isEmptyUsage(input.data),
    };
  }
  if (input.errorMessage) {
    return input.lastKnown
      ? lastKnownView(input.lastKnown, input.errorMessage, input.nowMs)
      : { kind: "error", message: input.errorMessage };
  }
  if (input.pending) return { kind: "loading" };
  if (input.offline) {
    return input.lastKnown
      ? lastKnownView(input.lastKnown, OFFLINE_REASON, input.nowMs)
      : { kind: "error", message: OFFLINE_EMPTY };
  }
  return { kind: "loading" };
}
