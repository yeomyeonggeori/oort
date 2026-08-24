import { describe, expect, it } from "vitest";
import type { CatalogEmoji } from "./catalog";
import { emojiMatches, filterEmojis, normalizeEmojiQuery } from "./search";

const fixture: CatalogEmoji[] = [
  {
    glyph: "🎉",
    name: "party popper",
    shortcodes: ["tada"],
    keywords: ["celebrate", "hooray"],
    category: "activity",
  },
  {
    glyph: "👍",
    name: "thumbs up",
    shortcodes: ["+1", "thumbsup"],
    keywords: ["yes"],
    category: "people",
  },
  {
    glyph: "🍀",
    name: "four leaf clover",
    shortcodes: ["four_leaf_clover"],
    keywords: ["lucky"],
    category: "nature",
  },
];

describe("normalizeEmojiQuery", () => {
  it("strips colons and case so Slack shortcodes match", () => {
    expect(normalizeEmojiQuery(":Tada:")).toBe("tada");
    expect(normalizeEmojiQuery("  ThumbsUp ")).toBe("thumbsup");
  });
});

describe("emojiMatches", () => {
  it("matches name, shortcode, and keyword", () => {
    const party = fixture[0];
    expect(emojiMatches(party, "party")).toBe(true);
    expect(emojiMatches(party, "tada")).toBe(true);
    expect(emojiMatches(party, "hooray")).toBe(true);
    expect(emojiMatches(party, "clover")).toBe(false);
  });
});

describe("filterEmojis", () => {
  it("returns the whole catalog when the query is empty", () => {
    expect(filterEmojis(fixture, "   ")).toEqual(fixture);
  });

  it("filters to shortcode hits including colon wrapping", () => {
    expect(filterEmojis(fixture, ":thumbsup:").map((row) => row.glyph)).toEqual([
      "👍",
    ]);
  });
});
