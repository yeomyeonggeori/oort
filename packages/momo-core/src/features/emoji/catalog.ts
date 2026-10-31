export const EMOJI_CATEGORY_IDS = [
  "people",
  "nature",
  "foods",
  "activity",
  "places",
  "objects",
  "symbols",
  "flags",
] as const;

export type EmojiCategoryId = (typeof EMOJI_CATEGORY_IDS)[number];

export type CatalogEmoji = {
  glyph: string;
  name: string;
  shortcodes: string[];
  keywords: string[];
  category: EmojiCategoryId;
  skins?: string[];
  /** CLDR Korean name; English name remains stable for existing consumers. */
  koreanName?: string;
  /** Unicode Emoji version, not the Unicode scalar version. */
  version?: number;
  skinVersions?: number[];
};

export type RawCatalog = {
  v: number;
  metadata?: Record<
    string,
    { ko: string; version: number; skinVersions?: number[] }
  >;
  items: Array<
    | [string, string, string[], string[], number]
    | [string, string, string[], string[], number, string[]]
  >;
};

export function parseCatalog(raw: RawCatalog): CatalogEmoji[] {
  return raw.items.flatMap((row) => {
    const [glyph, name, shortcodes, keywords, categoryIndex, skins] = row;
    const category = EMOJI_CATEGORY_IDS[categoryIndex];
    if (!glyph || !name || !category) return [];
    const entry: CatalogEmoji = { glyph, name, shortcodes, keywords, category };
    const meta = raw.metadata?.[glyph];
    if (meta) {
      entry.koreanName = meta.ko;
      entry.version = meta.version;
      entry.skinVersions = meta.skinVersions;
    }
    if (skins && skins.length === 5) entry.skins = skins;
    return [entry];
  });
}

/** Strip VS16 so 👍 and 👍️ compare as the same picker identity. */
export function foldEmoji(value: string): string {
  return value.replaceAll("\uFE0F", "");
}

export function resolveCatalogEmoji(
  entries: readonly CatalogEmoji[],
  glyph: string
): CatalogEmoji | undefined {
  const folded = foldEmoji(glyph);
  return (
    entries.find((entry) => foldEmoji(entry.glyph) === folded) ??
    entries.find((entry) =>
      entry.skins?.some((skin) => foldEmoji(skin) === folded)
    )
  );
}

export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export function displayGlyph(entry: CatalogEmoji, tone: SkinTone): string {
  if (tone === 0 || !entry.skins) return entry.glyph;
  return entry.skins[tone - 1] ?? entry.glyph;
}

/** Labels are shared; platform icons belong to each client. */
export const EMOJI_CATEGORIES = [
  { id: "frequent", label: "자주 씀" },
  { id: "people", label: "사람" },
  { id: "nature", label: "자연" },
  { id: "foods", label: "음식" },
  { id: "activity", label: "활동" },
  { id: "places", label: "장소" },
  { id: "objects", label: "물건" },
  { id: "symbols", label: "기호" },
  { id: "flags", label: "깃발" },
] as const;

/** Only offer glyphs the host can draw. Unknown versions fail closed. */
export function supportedEmojis(
  entries: readonly CatalogEmoji[],
  maxVersion: number
): CatalogEmoji[] {
  return entries
    .filter(
      (entry) => entry.version !== undefined && entry.version <= maxVersion
    )
    .map((entry) =>
      entry.skins
        ? {
            ...entry,
            skins: entry.skins.map((skin, index) =>
              (entry.skinVersions?.[index] ?? Infinity) <= maxVersion
                ? skin
                : entry.glyph
            ),
          }
        : entry
    );
}

/** Web keeps its verified Emoji 17 font baseline and legacy v1 retry payloads.
 * Newer data stays in the shared catalog; hosts only offer versions they can draw.
 */
export function parseWebCatalog(raw: RawCatalog): CatalogEmoji[] {
  const entries = parseCatalog(raw);
  return raw.v === 1 ? entries : supportedEmojis(entries, 17);
}
