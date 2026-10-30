import type { Expression, ExpressionAddPolicy, ExpressionList, ExpressionVersion } from "./types";

export interface ExpressionCache {
  workspaceId: string;
  memberId: string;
  version: ExpressionVersion | null;
  addPolicy: ExpressionAddPolicy;
  items: readonly Expression[];
}

export function emptyExpressionCache(workspaceId: string, memberId: string): ExpressionCache {
  return { workspaceId, memberId, version: null, addPolicy: "members", items: [] };
}

/** Decimal bigint versions never pass through a JS number. */
export function compareExpressionVersions(a: ExpressionVersion, b: ExpressionVersion): number {
  if (!/^(0|[1-9][0-9]*)$/.test(a) || !/^(0|[1-9][0-9]*)$/.test(b)) throw new Error("Invalid expression version");
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export interface ExpressionCacheUpdate {
  cache: ExpressionCache;
  applied: boolean;
  needsFullRefresh: boolean;
  /** Hosts must evict authenticated image bytes, including in-flight decodes. */
  evictImageIds: string[];
}

export function applyExpressionList(cache: ExpressionCache, list: ExpressionList): ExpressionCacheUpdate {
  const refused = (needsFullRefresh: boolean): ExpressionCacheUpdate => ({ cache, applied: false, needsFullRefresh, evictImageIds: [] });
  if (list.workspaceId !== cache.workspaceId) return refused(true);
  if (cache.version !== null && compareExpressionVersions(list.version, cache.version) < 0) return refused(false);
  if ((list.reset && list.baseVersion !== null) || (!list.reset && (cache.version === null || list.baseVersion !== cache.version))) return refused(true);
  const seenIds = new Set<string>();
  for (const item of list.items) {
    if (item.workspaceId !== list.workspaceId || compareExpressionVersions(item.version, list.version) > 0 ||
      (!list.reset && compareExpressionVersions(item.version, list.baseVersion!) <= 0) || seenIds.has(item.id)) return refused(true);
    seenIds.add(item.id);
  }
  const next = new Map<string, Expression>(list.reset ? [] : cache.items.map((item) => [item.id, item]));
  for (const item of list.items) {
    if (item.status === "active") next.set(item.id, item);
    else next.delete(item.id);
  }
  const names = new Set<string>();
  for (const item of next.values()) {
    if (names.has(item.name)) return refused(true);
    names.add(item.name);
    const prior = cache.items.find((previous) => previous.id === item.id);
    if (prior && prior.name !== item.name) return refused(true);
  }
  const evictImageIds = cache.items.filter((prior) => {
    const current = next.get(prior.id);
    return !current || JSON.stringify(current.media) !== JSON.stringify(prior.media);
  }).map((item) => item.id);
  return {
    applied: true, needsFullRefresh: false, evictImageIds,
    cache: { ...cache, version: list.version, addPolicy: list.addPolicy, items: [...next.values()].sort((a, b) => a.name.localeCompare(b.name, "en")) },
  };
}

export function expressionCacheNeedsRefresh(cache: ExpressionCache, workspaceId: string, version: ExpressionVersion): boolean {
  return workspaceId === cache.workspaceId && (cache.version === null || compareExpressionVersions(version, cache.version) > 0);
}
