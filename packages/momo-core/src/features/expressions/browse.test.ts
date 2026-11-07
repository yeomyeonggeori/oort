import { describe, expect, it } from "vitest";
import { expressionBrowseQuery, orderExpressionsForTab } from "./browse";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import type { Expression, ExpressionImage, ExpressionKind, ExpressionMedia } from "./types";
import { recordExpressionUse, emptyExpressionUsage, type ExpressionUsage } from "./usage";

// 한 탭의 차례 (#5453): 검색어가 없으면 즐겨찾기 → 최근 → 나머지, 있으면 코어 검색의 관련도 차례 그대로. 탭 밖의 등록은 들이지 않는다.

const png: ExpressionImage = { mime: "image/png", sha256: "a".repeat(64), bytes: 10, width: 300, height: 300, frameCount: 1, durationMs: 0 };
const gif: ExpressionImage = { mime: "image/gif", sha256: "b".repeat(64), bytes: 10, width: 300, height: 300, frameCount: 4, durationMs: 400 };
const mediaOf = (large: ExpressionImage): ExpressionMedia => ({ small: large, large, thumb: png });
const make = (name: string, kind: ExpressionKind, large: ExpressionImage = png, extra: Partial<Expression> = {}): Expression => ({
  ...FIXTURE_EXPRESSIONS[0], id: `id-${name}`, name, displayName: name, tags: [], kind, media: mediaOf(large), status: "active", ...extra,
});

const aa = make("aa_cat", "sticker");
const bb = make("bb_dog", "sticker");
const cc = make("cc_fox", "sticker");
const dd = make("dd_owl", "sticker");
const spin = make("ee_spin", "sticker", gif);
const smile = make("ff_smile", "emoji");
const ITEMS = [aa, bb, cc, dd, spin, smile];
const ids = (list: readonly Expression[]) => list.map((entry) => entry.name);

function usedAt(...uses: Array<[Expression, number]>): ExpressionUsage {
  return uses.reduce((usage, [entry, at]) => recordExpressionUse(usage, entry.id, at), emptyExpressionUsage("w", "m"));
}

describe("검색어가 없으면 즐겨찾기 → 최근 → 나머지", () => {
  it("탭 몫만 남기고, 쓴 적도 별표도 없으면 코어 검색의 기본 차례(이름순)다", () => {
    expect(ids(orderExpressionsForTab(ITEMS, "emoticon"))).toEqual(["aa_cat", "bb_dog", "cc_fox", "dd_owl"]);
    expect(ids(orderExpressionsForTab(ITEMS, "gif"))).toEqual(["ee_spin"]);
    expect(ids(orderExpressionsForTab(ITEMS, "emoji"))).toEqual(["ff_smile"]);
  });
  it("최근에 쓴 것이 많이 쓴 것보다 먼저다(마지막 사용 시각 내림차순)", () => {
    // dd는 한 번, aa는 세 번 썼지만 dd가 더 최근이다.
    const usage = usedAt([aa, 10], [aa, 20], [aa, 30], [dd, 100]);
    expect(ids(orderExpressionsForTab(ITEMS, "emoticon", { usage }))).toEqual(["dd_owl", "aa_cat", "bb_dog", "cc_fox"]);
  });
  it("즐겨찾기는 고른 차례로 최근보다 앞에 서고, 즐겨찾기이면서 최근인 것은 한 번만 선다", () => {
    const usage = usedAt([bb, 10], [dd, 50]);
    const out = orderExpressionsForTab(ITEMS, "emoticon", { usage, favorites: [cc.id, dd.id] });
    expect(ids(out)).toEqual(["cc_fox", "dd_owl", "bb_dog", "aa_cat"]);
    expect(new Set(ids(out)).size).toBe(out.length);
  });
  it("이 탭에 없는 별표·숨겨진 등록·모르는 id는 건너뛴다", () => {
    const hidden = make("gg_gone", "sticker", png, { status: "hidden" });
    const out = orderExpressionsForTab([...ITEMS, hidden], "emoticon", { favorites: [spin.id, hidden.id, "nope", aa.id] });
    expect(ids(out)).toEqual(["aa_cat", "bb_dog", "cc_fox", "dd_owl"]);
  });
  it("차례만 바꾸고 등록은 같은 객체이며 빠지는 것이 없다", () => {
    const out = orderExpressionsForTab(ITEMS, "emoticon", { favorites: [dd.id] });
    expect(out[0]).toBe(dd);
    expect(new Set(out)).toEqual(new Set([aa, bb, cc, dd]));
  });
});

describe("검색어가 있으면 관련도 차례 그대로다", () => {
  it("즐겨찾기도 최근도 관련도를 앞지르지 못한다", () => {
    const exact = make("cat", "sticker");
    const prefix = make("cat_party", "sticker");
    const tagged = make("zz_other", "sticker", png, { tags: ["cat"] });
    const usage = usedAt([tagged, 500], [prefix, 400]);
    const out = orderExpressionsForTab([tagged, prefix, exact], "emoticon", { query: "cat", usage, favorites: [tagged.id] });
    expect(ids(out)).toEqual(["cat", "cat_party", "zz_other"]);
  });
  it("앞뒤 콜론은 이름 검색으로 읽고, 다른 탭의 일치는 들이지 않는다", () => {
    expect(expressionBrowseQuery(":aa_cat:")).toBe("aa_cat");
    expect(ids(orderExpressionsForTab(ITEMS, "emoticon", { query: ":aa_cat:" }))).toEqual(["aa_cat"]);
    expect(orderExpressionsForTab(ITEMS, "gif", { query: "aa_cat" })).toEqual([]);
  });
});
