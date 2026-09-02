import { describe, expect, it } from "vitest";
import type { CatalogEmoji } from "./catalog";
import { loadCatalog } from "./catalog";
import {
  EMOJI_MATCH_MISS,
  EMOJI_MATCH_RANK,
  emojiMatchRank,
  emojiMatches,
  filterEmojis,
  isEmojiSearchQuery,
  normalizeEmojiQuery,
} from "./search";

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

describe("isEmojiSearchQuery", () => {
  it("does not treat a lone colon as a search (Slack first keystroke)", () => {
    expect(isEmojiSearchQuery(":")).toBe(false);
    expect(isEmojiSearchQuery(" : ")).toBe(false);
    expect(isEmojiSearchQuery("")).toBe(false);
  });

  it("starts searching once a significant character remains", () => {
    expect(isEmojiSearchQuery("s")).toBe(true);
    expect(isEmojiSearchQuery(":s")).toBe(true);
    expect(isEmojiSearchQuery(":smile:")).toBe(true);
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

// -----------------------------------------------------------------------------
// 순위 (design-review #1930 H-1). 아래 표는 리뷰가 **실 카탈로그에서 실측한**
// 앞 여섯 줄이고, 그 줄들이 왜 결함이었는지가 그대로 시험 픽스처다.
// -----------------------------------------------------------------------------

const RANKED: CatalogEmoji[] = [
  {
    glyph: "🫰",
    name: "hand with index finger and thumb crossed",
    shortcodes: ["hand_with_index_finger_and_thumb_crossed"],
    keywords: ["snap"],
    category: "people",
  },
  {
    glyph: "👍",
    name: "thumbs up",
    shortcodes: ["+1", "thumbsup"],
    keywords: ["yes"],
    category: "people",
  },
  {
    glyph: "⚡",
    name: "high voltage",
    shortcodes: ["zap"],
    keywords: ["thunder", "thunderbolt"],
    category: "nature",
  },
  {
    glyph: "🇱🇹",
    name: "flag: Lithuania",
    shortcodes: ["flag-lt"],
    keywords: ["lt"],
    category: "flags",
  },
  {
    glyph: "⛈",
    name: "cloud with lightning and rain",
    shortcodes: ["thunder_cloud_and_rain"],
    keywords: ["storm"],
    category: "nature",
  },
];

describe("emojiMatchRank", () => {
  it("사람이 친 글자에 가까운 신원부터 등급을 매긴다", () => {
    const thumb = RANKED[1];
    expect(emojiMatchRank(thumb, "thumbsup")).toBe(EMOJI_MATCH_RANK.shortcodeExact);
    expect(emojiMatchRank(thumb, "thumb")).toBe(EMOJI_MATCH_RANK.shortcodePrefix);
    expect(emojiMatchRank(thumb, "sup")).toBe(EMOJI_MATCH_RANK.shortcodePart);
    expect(emojiMatchRank(RANKED[3], "flag:")).toBe(EMOJI_MATCH_RANK.namePrefix);
    expect(emojiMatchRank(RANKED[3], "thu")).toBe(EMOJI_MATCH_RANK.namePart);
    expect(emojiMatchRank(RANKED[2], "thunder")).toBe(EMOJI_MATCH_RANK.keywordPrefix);
    expect(emojiMatchRank(RANKED[2], "bolt")).toBe(EMOJI_MATCH_RANK.keywordPart);
    expect(emojiMatchRank(RANKED[2], "없는글자")).toBe(EMOJI_MATCH_MISS);
  });

  it("숏코드가 여럿이면 가장 높은 등급이 그 줄의 등급이다", () => {
    // `+1` 은 `1` 에 부분일치하고 `thumbsup` 은 접두다. 순서가 뒤라고 낮은
    // 등급으로 굳으면 `:thumb` 이 다른 줄 뒤로 밀린다.
    expect(emojiMatchRank(RANKED[1], "thumbs")).toBe(
      EMOJI_MATCH_RANK.shortcodePrefix
    );
  });
});

describe("filterEmojis 는 순위대로 돌려준다 (#1930 H-1)", () => {
  it("`thu` 의 첫 줄은 숏코드로 걸린 줄이다", () => {
    // 리뷰 실측: 앞 판은 카탈로그 순서 그대로라 첫 줄이 🫰(이름 부분일치)였고
    // 마지막 줄이 리투아니아 국기였다. 첫 줄은 Enter 의 기본값이다.
    expect(filterEmojis(RANKED, "thu").map((row) => row.glyph)).toEqual([
      "👍",
      "⛈",
      "🫰",
      "🇱🇹",
      "⚡",
    ]);
  });

  it("빈 질의는 카탈로그 순서를 건드리지 않는다", () => {
    expect(filterEmojis(RANKED, "  ")).toEqual(RANKED);
  });

  it("같은 등급은 카탈로그 순서로 남는다", () => {
    // ⛈(`thunder_cloud_and_rain`)와 👍(`thumbsup`)는 둘 다 숏코드 접두다.
    // 동점을 순위가 다시 섞으면 사람이 외운 열이 매 검색마다 달라진다.
    expect(
      filterEmojis([RANKED[4], RANKED[1]], "thu").map((row) => row.glyph)
    ).toEqual(["⛈", "👍"]);
    expect(
      filterEmojis([RANKED[1], RANKED[4]], "thu").map((row) => row.glyph)
    ).toEqual(["👍", "⛈"]);
  });
});

describe("실 카탈로그에서 첫 줄이 상식이다 (#1930 H-1 실측표)", () => {
  it("`th` 의 여섯 줄이 전부 숏코드로 걸리고 thinking 이 그 안에 든다", async () => {
    const catalog = await loadCatalog();
    const top = filterEmojis(catalog, "th").slice(0, 6);
    // 앞 판의 여섯 줄: 😀 😃 😄 😁 😆 😅 — 전부 키워드 `teeth` 였고 숏코드에
    // `th` 가 든 줄이 하나도 없었다.
    for (const entry of top) {
      expect(
        entry.shortcodes.some((code) => code.startsWith("th")),
        entry.shortcodes.join(",")
      ).toBe(true);
    }
    expect(top.map((entry) => entry.shortcodes[0])).toContain("thinking_face");
  });

  it("`thu` 의 첫 줄은 👍 계열이다", async () => {
    const catalog = await loadCatalog();
    const [first] = filterEmojis(catalog, "thu");
    expect(first.shortcodes).toContain("thumbsup");
  });

  it("`ok` 는 여섯 줄 안에 ok_hand 를 준다", async () => {
    const catalog = await loadCatalog();
    const top = filterEmojis(catalog, "ok").slice(0, 6);
    expect(top.map((entry) => entry.shortcodes[0])).toContain("ok_hand");
  });

  it("`hi` 의 여섯 줄이 키워드로만 걸린 줄로 채워지지 않는다", async () => {
    const catalog = await loadCatalog();
    const top = filterEmojis(catalog, "hi").slice(0, 6);
    // 앞 판: 😆 🤣 😂 🫣 🤫 🤔 (전부 키워드).
    for (const entry of top) {
      expect(
        entry.shortcodes.some((code) => code.startsWith("hi")),
        entry.shortcodes.join(",")
      ).toBe(true);
    }
  });
});
