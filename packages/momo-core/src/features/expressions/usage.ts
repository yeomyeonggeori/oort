/** Device storage adapters persist this value under workspace + signed-in member. */
export interface ExpressionUsageEntry {
  id: string;
  count: number;
  lastUsedAtMs: number;
}
export interface ExpressionUsage {
  v: 1;
  workspaceId: string;
  memberId: string;
  entries: ExpressionUsageEntry[];
}
const MAX_ENTRIES = 1000;

export function emptyExpressionUsage(workspaceId: string, memberId: string): ExpressionUsage {
  return { v: 1, workspaceId, memberId, entries: [] };
}

/** Untrusted persisted input, including storage from another account, fails closed. */
export function restoreExpressionUsage(
  value: unknown, workspaceId: string, memberId: string,
): ExpressionUsage {
  const empty = emptyExpressionUsage(workspaceId, memberId);
  if (!value || typeof value !== "object") return empty;
  const data = value as Partial<ExpressionUsage>;
  if (data.v !== 1 || data.workspaceId !== workspaceId || data.memberId !== memberId || !Array.isArray(data.entries)) return empty;
  const seen = new Set<string>();
  const entries: ExpressionUsageEntry[] = [];
  for (const entry of data.entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id) ||
      !Number.isSafeInteger(entry.count) || entry.count < 1 ||
      !Number.isSafeInteger(entry.lastUsedAtMs) || entry.lastUsedAtMs < 0) continue;
    seen.add(entry.id);
    entries.push({ id: entry.id, count: entry.count, lastUsedAtMs: entry.lastUsedAtMs });
  }
  return { ...empty, entries: entries.sort(recentOrder).slice(0, MAX_ENTRIES) };
}

function recentOrder(a: ExpressionUsageEntry, b: ExpressionUsageEntry): number {
  return b.lastUsedAtMs - a.lastUsedAtMs || a.id.localeCompare(b.id, "en");
}

/** Call only after a send/reaction succeeds; opening a preview is not use. */
export function recordExpressionUse(usage: ExpressionUsage, id: string, atMs: number): ExpressionUsage {
  if (!id || !Number.isSafeInteger(atMs) || atMs < 0) return usage;
  const prior = usage.entries.find((entry) => entry.id === id);
  const entry = {
    id,
    count: Math.min(Number.MAX_SAFE_INTEGER, (prior?.count ?? 0) + 1),
    lastUsedAtMs: Math.max(prior?.lastUsedAtMs ?? 0, atMs),
  };
  return { ...usage, entries: [...usage.entries.filter((item) => item.id !== id), entry].sort(recentOrder).slice(0, MAX_ENTRIES) };
}

export function recentExpressions(usage: ExpressionUsage, availableIds?: ReadonlySet<string>): ExpressionUsageEntry[] {
  return usage.entries.filter((entry) => !availableIds || availableIds.has(entry.id)).slice().sort(recentOrder);
}

export function frequentExpressions(usage: ExpressionUsage, availableIds?: ReadonlySet<string>): ExpressionUsageEntry[] {
  return recentExpressions(usage, availableIds).sort((a, b) => b.count - a.count || recentOrder(a, b));
}

// -----------------------------------------------------------------------------
// 「자주·최근」 차례 (#5503, owner 2026-11-07). 쓴 횟수와 마지막으로 쓴 때를 **함께** 본다: 점수 = 횟수 × 0.5^(마지막으로 쓴 뒤 지난 날 / 반감기).
// 많이 쓴 것은 한동안 위에 남고, 오래 안 쓰면 반감기마다 절반씩 내려간다. 어제 한 번 쓴 것(0.91)이 한 달 전 열 번 쓴 것(0.51)보다 위지만,
// 사흘 전 열 번 쓴 것(7.4)은 어제 한 번 쓴 것보다 위다. 같은 점수는 최근에 쓴 것이 먼저다(`recentOrder`).
// 사용 기록은 항목마다 횟수와 마지막 시각 하나뿐이라, 감쇠는 마지막으로 쓴 때부터 센다(쓴 때마다의 기록은 남기지 않는다).
// -----------------------------------------------------------------------------

/** 점수가 절반이 되는 날 수. */
export const FRECENT_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 점수의 로그: ln(횟수 × 0.5^(일 / 반감기)). 점수를 그대로 곱하면 아주 오래된 기록이 0으로 뭉개져(부동소수점) 횟수의 차이가 사라지므로,
 * 로그로 비교한다 - 로그는 단조 증가라 차례는 점수와 같다. 시계가 어긋나 미래 시각이 적힌 기록은 방금 쓴 것으로 센다.
 */
function frecentRank(entry: ExpressionUsageEntry, nowMs: number): number {
  const days = Math.max(0, nowMs - entry.lastUsedAtMs) / MS_PER_DAY;
  return Math.log(Math.max(1, entry.count)) - (days / FRECENT_HALF_LIFE_DAYS) * Math.LN2;
}

/**
 * 쓴 횟수와 최근을 함께 본 차례(위가 먼저). `availableIds` 가 있으면 그 안의 것만 남긴다(지워지거나 숨겨진 등록을 거르는 일은 호출부가 정한 이 집합이 한다).
 * 순수 함수다: 기준 시각 `nowMs` 는 호출부가 준다 - 창이 열려 있는 동안 차례가 흔들리지 않으려면 열 때 한 번 정한 시각을 계속 넘기면 된다.
 */
export function frecentExpressions(
  usage: ExpressionUsage, availableIds: ReadonlySet<string> | undefined, nowMs: number,
): ExpressionUsageEntry[] {
  return recentExpressions(usage, availableIds)
    .sort((a, b) => frecentRank(b, nowMs) - frecentRank(a, nowMs) || recentOrder(a, b));
}
