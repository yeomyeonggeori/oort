import type { CatalogEmoji } from "./catalog";

/** Lowercase, trim, strip colons so `:thumbsup:` and `thumbsup` match. */
export function normalizeEmojiQuery(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(":", "");
}

/**
 * 검색 모드 여부. 필드가 비어 있지 않은지가 아니라 **정규화된 질의**다.
 *
 * Slack 사용자는 숏코드 근육으로 `:`를 먼저 누른다. 콜론을 벗기면 빈 문자열인데
 * `query.trim().length > 0`은 그 한 글자를 검색으로 보고 카탈로그 전량(실측
 * 1914칸 / 패널 3841 노드 / 34화면, design-review #1746 H-2)을 그렸다. 콜론만
 * 있는 입력은 카테고리 탭을 유지한다. 의미 있는 글자(`s`, `:smile`)부터 필터.
 */
export function isEmojiSearchQuery(raw: string): boolean {
  return normalizeEmojiQuery(raw).length > 0;
}

export function emojiMatches(entry: CatalogEmoji, query: string): boolean {
  if (!query) return true;
  if (entry.glyph.includes(query)) return true;
  if (entry.name.toLowerCase().includes(query)) return true;
  if (entry.shortcodes.some((code) => code.includes(query))) return true;
  if (entry.keywords.some((keyword) => keyword.includes(query))) return true;
  return false;
}

export function filterEmojis(
  entries: readonly CatalogEmoji[],
  rawQuery: string
): CatalogEmoji[] {
  const query = normalizeEmojiQuery(rawQuery);
  if (!query) return [...entries];
  return entries.filter((entry) => emojiMatches(entry, query));
}
