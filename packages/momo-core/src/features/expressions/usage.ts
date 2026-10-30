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
