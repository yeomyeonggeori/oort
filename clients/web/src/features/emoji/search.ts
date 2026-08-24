import type { CatalogEmoji } from "./catalog";

/** Lowercase, trim, strip colons so `:thumbsup:` and `thumbsup` match. */
export function normalizeEmojiQuery(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(":", "");
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
