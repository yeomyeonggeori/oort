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

// =============================================================================
// 검색 **순위**는 이 정본이 진다 (design-review #1930 H-1).
//
// 앞 판은 순위가 없었다: 글리프·이름·숏코드·키워드 중 하나라도 걸리면 카탈로그
// 순서 그대로 돌려줬고, 피커는 그 열을 격자로 전부 펼치니까 사람이 눈으로 골라
// 견딜 만했다. 컴포저 자동완성(#1930)이 같은 열의 **앞 여섯 줄만** 그리고
// **0번 줄을 Enter 의 기본값**으로 삼으면서 그 무순위가 값을 냈다 — 실측으로
// `:th` 여섯 줄에 숏코드에 `th` 가 든 줄이 하나도 없었고(전부 키워드 `teeth`),
// `:thu` 의 첫 줄은 🫰, 마지막 줄은 리투아니아 국기였다(li**thu**ania).
//
// 그래서 순위를 **소비자 쪽에서** 다시 매기지 않는다. 컴포저에서만 재정렬하면
// 같은 질의에 두 표면이 다른 첫 줄을 내놓고, 사람이 외운 근육이 표면마다
// 갈라진다. 순위는 여기 한 자리에 서고 피커도 함께 좋아진다.
//
// 등급의 뜻은 하나다: **사람이 친 글자에 가까운 신원부터**. 숏코드는 사람이
// 외워서 치는 이름이므로 이름·키워드보다 앞서고, 그 안에서 완전일치 > 접두 >
// 부분 순이다. 키워드는 카탈로그가 검색을 넓히려고 붙여 둔 연상어라 가장
// 뒤다 — `:thu` 가 ⚡(keyword `thunder`)를 못 찾는 것이 아니라 👍 뒤에 놓는다.
// 같은 등급 안에서는 카탈로그 순서를 지킨다(emojibase 순서 = 사람이 아는 순서).
// =============================================================================

/** 어느 등급에도 걸리지 않았다. `filterEmojis` 가 이 값을 떨어뜨린다. */
export const EMOJI_MATCH_MISS = Number.POSITIVE_INFINITY;

/** 질의가 맞춘 신원. 작을수록 앞줄. */
export const EMOJI_MATCH_RANK = {
  glyph: 0,
  shortcodeExact: 1,
  shortcodePrefix: 2,
  shortcodePart: 3,
  namePrefix: 4,
  namePart: 5,
  keywordPrefix: 6,
  keywordPart: 7,
} as const;

/**
 * 이 항목이 질의를 어떤 신원으로 맞췄나. `query`는 **정규화된** 값이다.
 *
 * 빈 질의는 전량이 같은 등급(0)이라 카탈로그 순서가 그대로 남는다.
 */
export function emojiMatchRank(entry: CatalogEmoji, query: string): number {
  if (!query) return EMOJI_MATCH_RANK.glyph;
  if (entry.glyph.includes(query)) return EMOJI_MATCH_RANK.glyph;
  let shortcode = EMOJI_MATCH_MISS;
  for (const code of entry.shortcodes) {
    if (code === query) return EMOJI_MATCH_RANK.shortcodeExact;
    if (code.startsWith(query)) shortcode = EMOJI_MATCH_RANK.shortcodePrefix;
    else if (shortcode === EMOJI_MATCH_MISS && code.includes(query)) {
      shortcode = EMOJI_MATCH_RANK.shortcodePart;
    }
  }
  if (shortcode !== EMOJI_MATCH_MISS) return shortcode;
  const name = entry.name.toLowerCase();
  if (name.startsWith(query)) return EMOJI_MATCH_RANK.namePrefix;
  if (name.includes(query)) return EMOJI_MATCH_RANK.namePart;
  let keyword = EMOJI_MATCH_MISS;
  for (const word of entry.keywords) {
    if (word.startsWith(query)) return EMOJI_MATCH_RANK.keywordPrefix;
    if (word.includes(query)) keyword = EMOJI_MATCH_RANK.keywordPart;
  }
  return keyword;
}

export function emojiMatches(entry: CatalogEmoji, query: string): boolean {
  return emojiMatchRank(entry, query) !== EMOJI_MATCH_MISS;
}

export function filterEmojis(
  entries: readonly CatalogEmoji[],
  rawQuery: string
): CatalogEmoji[] {
  const query = normalizeEmojiQuery(rawQuery);
  if (!query) return [...entries];
  const hits: Array<{ entry: CatalogEmoji; rank: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const rank = emojiMatchRank(entry, query);
    if (rank !== EMOJI_MATCH_MISS) hits.push({ entry, rank, index });
  });
  // 같은 등급의 동점은 카탈로그 순서로 깬다. `sort` 가 안정 정렬이어도 그 사실에
  // 기대지 않고 색인을 함께 비교한다 — 이 열의 첫 줄은 Enter 의 기본값이라
  // 「대개 그 순서」로는 부족하다.
  hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return hits.map((hit) => hit.entry);
}
