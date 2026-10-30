import type { Expression } from "./types";
import type { ExpressionUsage } from "./usage";

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
export function koreanInitials(value: string): string {
  return Array.from(value.normalize("NFC"), (char) => {
    const code = char.codePointAt(0)! - 0xac00;
    return code >= 0 && code <= 11171 ? INITIALS[Math.floor(code / 588)] : char;
  }).join("");
}

function normalized(value: string): string {
  return value.normalize("NFC").toLowerCase().trim();
}

/** Stable rank: exact name, name prefix, exact tag, substring/initials, use count. */
export function searchExpressions(
  expressions: readonly Expression[], query: string, usage?: ExpressionUsage,
): Expression[] {
  const q = normalized(query);
  const initialQuery = /^[ㄱ-ㅎ]+$/.test(q);
  const counts = new Map(usage?.entries.map((entry) => [entry.id, entry.count]));
  const rank = (item: Expression): number => {
    if (!q) return 0;
    const names = [normalized(item.name), normalized(item.displayName)];
    if (names.some((name) => name === q)) return 0;
    if (names.some((name) => name.startsWith(q))) return 1;
    const tags = item.tags.map(normalized);
    if (tags.includes(q)) return 2;
    if ([...names, ...tags].some((text) => text.includes(q))) return 3;
    if (initialQuery && [...names, ...tags].some((text) => koreanInitials(text).includes(q))) return 3;
    return Infinity;
  };
  return expressions.filter((item) => item.status === "active")
    .map((item) => ({ item, rank: rank(item) })).filter((hit) => Number.isFinite(hit.rank))
    .sort((a, b) => a.rank - b.rank || (counts.get(b.item.id) ?? 0) - (counts.get(a.item.id) ?? 0) ||
      a.item.name.localeCompare(b.item.name, "en") || a.item.id.localeCompare(b.item.id, "en"))
    .map((hit) => hit.item);
}
