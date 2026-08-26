import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "./EmojiPickerDialog";
import {
  foldEmoji,
  parseCatalog,
  resolveCatalogEmoji,
  type CatalogEmoji,
} from "./catalog";

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL("./emojiCatalog.json", import.meta.url)), "utf8")
) as Parameters<typeof parseCatalog>[0];

describe("extracted emoji catalog", () => {
  const catalog = parseCatalog(raw);

  it("stays under the 120kB gzip budget", () => {
    const bytes = gzipSync(
      readFileSync(fileURLToPath(new URL("./emojiCatalog.json", import.meta.url)))
    ).length;
    expect(bytes).toBeGreaterThan(20_000);
    expect(bytes).toBeLessThanOrEqual(120 * 1024);
  });

  it("covers the curated 32-glyph seed, folding VS16", () => {
    const missing = PICKER_EMOJI.filter(
      (glyph) => !resolveCatalogEmoji(catalog, glyph)
    );
    expect(missing).toEqual([]);
  });

  it("does not duplicate folded glyphs", () => {
    const keys = catalog.map((entry: CatalogEmoji) => foldEmoji(entry.glyph));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
