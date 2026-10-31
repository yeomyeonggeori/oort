import { describe, expect, it, vi } from "vitest";
import raw from "./emojiCatalog.json";
import {
  displayGlyph,
  foldEmoji,
  parseCatalog,
  resolveCatalogEmoji,
  supportedEmojis,
  type RawCatalog,
} from "./catalog";
import { filterEmojis } from "./search";
import {
  createEmojiFrequencyStore,
  createEmojiSkinToneStore,
  parseEmojiCounts,
} from "./preferences";
import { iosEmojiVersion } from "./support";

const catalog = parseCatalog(raw as unknown as RawCatalog);

describe("shared Unicode emoji (#4322)", () => {
  it("keeps the complete generated inventory, Korean names and all eight categories", () => {
    expect(raw.source).toBe("emojibase-data@18.0.0");
    expect(catalog).toHaveLength(2303);
    expect(new Set(catalog.map((entry) => foldEmoji(entry.glyph))).size).toBe(
      catalog.length
    );
    expect(new Set(catalog.map((entry) => entry.category)).size).toBe(8);
    expect(
      catalog.every(
        (entry) => entry.koreanName && typeof entry.version === "number"
      )
    ).toBe(true);
    expect(resolveCatalogEmoji(catalog, "🫫")?.version).toBe(18);
    // Mixed tones are separately selectable; the global tone never rewrites them.
    const mixed = resolveCatalogEmoji(catalog, "🫱🏻‍🫲🏿")!;
    expect(mixed.glyph).toBe("🫱🏻‍🫲🏿");
    expect(displayGlyph(mixed, 3)).toBe(mixed.glyph);
  });

  it("finds Korean, English, colon shortcodes and glyphs with the existing ordering", () => {
    for (const query of ["엄지", ":thumbsup:", "👍"]) {
      expect(
        filterEmojis(catalog, query).some((entry) => foldEmoji(entry.glyph) === "👍")
      ).toBe(true);
    }
    expect(filterEmojis(catalog, ":thu")[0].glyph).toBe("👍️");
    expect(filterEmojis(catalog, "없는이모지검색어")).toEqual([]);
  });

  it("filters unsupported versions and unsupported skin sequences without hiding the base", () => {
    const old = supportedEmojis(catalog, 13.1);
    expect(resolveCatalogEmoji(old, "🫫")).toBeUndefined();
    expect(resolveCatalogEmoji(old, "🫱🏻‍🫲🏿")).toBeUndefined();
    const handshake = resolveCatalogEmoji(old, "🤝")!;
    expect(handshake).toBeDefined();
    expect(displayGlyph(handshake, 1)).toBe("🤝"); // skin sequences arrived in Emoji 14
    expect(
      displayGlyph(resolveCatalogEmoji(supportedEmojis(catalog, 14), "🤝")!, 1)
    ).toBe("🤝🏻");
    expect(iosEmojiVersion("18.3")).toBe(15.1);
    expect(iosEmojiVersion("18.4.1")).toBe(16);
    expect(iosEmojiVersion("26.3")).toBe(16);
    expect(iosEmojiVersion("26.4")).toBe(17);
    expect(iosEmojiVersion("99.0")).toBe(17);
    expect(iosEmojiVersion("unknown")).toBe(0);
  });

  it("persists frequency, survives a new store, and keeps count ahead of recency", () => {
    let saved: string | null = null;
    const storage = {
      read: () => saved,
      write: (value: string | null) => {
        saved = value;
      },
    };
    const store = createEmojiFrequencyStore(storage);
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    store.record("🎉");
    store.record("🎉");
    store.record("👍");
    expect(store.frequent(3, ["👀", "🎉"])).toEqual(["🎉", "👍", "👀"]);
    const stable = store.snapshot();
    expect(store.snapshot()).toBe(stable);
    expect(createEmojiFrequencyStore(storage).frequent()).toEqual(["🎉", "👍"]);
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.record("👍");
    expect(notify).toHaveBeenCalledTimes(3);
    expect(store.snapshot()).not.toBe(stable);
  });

  it("rejects corrupt preferences and preserves selection when storage fails", () => {
    expect(parseEmojiCounts("{broken")).toEqual({});
    expect(parseEmojiCounts("[]")).toEqual({});
    expect(parseEmojiCounts('{"👍":2,"🎉":-1,"👀":"9","😄":null}')).toEqual({
      "👍": 2,
    });
    const storage = {
      read: () => "99",
      write: () => {
        throw new Error("device full");
      },
    };
    const tone = createEmojiSkinToneStore(storage);
    expect(tone.snapshot()).toBe(0);
    tone.set(4);
    expect(tone.snapshot()).toBe(4);
    const frequency = createEmojiFrequencyStore(storage);
    frequency.record("🎉");
    expect(frequency.frequent()).toEqual(["🎉"]);
  });
});
