import type { Expression, ExpressionAddPolicy, ExpressionImage, ExpressionList, ExpressionMedia, ExpressionVersion } from "./types";

const MEDIA_VARIANTS = ["small", "large", "thumb"] as const;
const IMAGE_FIELDS = ["mime", "sha256", "bytes", "width", "height", "frameCount", "durationMs"] as const satisfies readonly (keyof ExpressionImage)[];

/**
 * 두 그림 묶음이 같은 그림인가: 변형(small·large·thumb)마다 형식 · sha256 · 크기 · 장면 수 · 길이를 값으로 견준다(#5575).
 * 앞 판은 `JSON.stringify` 로 견줬다. 그 문자열은 키 차례를 따르므로, 같은 그림이라도 서버가 키를 다른 차례로 보내면(지금 서버는 이름 차례로
 * 고정이지만 계약은 차례를 정하지 않는다) 다시 읽을 때마다 「그림이 바뀌었다」가 되어 모든 그림을 걷었다(30초마다 · 창 포커스마다).
 */
export function sameExpressionMedia(a: ExpressionMedia | null, b: ExpressionMedia | null): boolean {
  if (a === null || b === null) return a === b;
  return MEDIA_VARIANTS.every((variant) => {
    const left = a[variant];
    const right = b[variant];
    if (left === undefined || right === undefined) return left === right;
    return IMAGE_FIELDS.every((field) => left[field] === right[field]);
  });
}

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

/**
 * Whether `next` is the catalogue version right after `prior`. Versions are decimal strings of a counter the server raises by exactly one per change
 * (`expression_catalog.version = version + 1`, one row lock), so nothing sits between two consecutive ones. A client may lay the response of ONE change
 * of its own over its cache as a delta (`prior -> next`) only then: any other pair means someone else's change slipped in between (a hide, a delete)
 * that this single response does not carry, and a cache that jumped over it keeps that registration `active` while later list reads never mention it
 * again (#5491 review 1, H-5491-1). A value that is not a decimal string is not "next" either (the caller then re-reads the list).
 */
export function isNextExpressionVersion(prior: ExpressionVersion, next: ExpressionVersion): boolean {
  const decimal = /^(0|[1-9][0-9]*)$/;
  if (!decimal.test(prior) || !decimal.test(next)) return false;
  // prior + 1 on the digits: a bigint version never passes through a JS number.
  const digits = prior.split("");
  let index = digits.length - 1;
  while (index >= 0 && digits[index] === "9") {
    digits[index] = "0";
    index -= 1;
  }
  if (index < 0) digits.unshift("1");
  else digits[index] = String(Number(digits[index]) + 1);
  return digits.join("") === next;
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
    return !current || !sameExpressionMedia(current.media, prior.media);
  }).map((item) => item.id);
  return {
    applied: true, needsFullRefresh: false, evictImageIds,
    cache: { ...cache, version: list.version, addPolicy: list.addPolicy, items: [...next.values()].sort((a, b) => a.name.localeCompare(b.name, "en")) },
  };
}

export function expressionCacheNeedsRefresh(cache: ExpressionCache, workspaceId: string, version: ExpressionVersion): boolean {
  return workspaceId === cache.workspaceId && (cache.version === null || compareExpressionVersions(version, cache.version) > 0);
}
