import { describe, expect, it } from "vitest";
import { emptyExpressionFavorites, toggleExpressionFavorite } from "./favorites";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import {
  buildExpressionSections,
  EXPRESSION_GRID_COLS,
  EXPRESSION_RECENT_MAX,
  expressionSectionNameKey,
  isContextMenuSummonKey,
  moveGridPosition,
  type ExpressionSection,
} from "./gridSections";
import type { Expression, ExpressionImage, ExpressionKind, ExpressionMedia } from "./types";
import { emptyExpressionUsage, recordExpressionUse } from "./usage";

// 그림 격자의 구역 (owner 2026-11-07, #5453): 최근 -> 즐겨찾기 -> 세트별 -> 기타. 검색어가 있으면 결과 하나. 방향키는 구역을 이어 붙인 격자처럼 움직인다.

const png: ExpressionImage = { mime: "image/png", sha256: "a".repeat(64), bytes: 10, width: 300, height: 300, frameCount: 1, durationMs: 0 };
const media: ExpressionMedia = { small: png, large: png, thumb: png };
const make = (name: string, tags: string[] = [], kind: ExpressionKind = "sticker"): Expression => ({
  ...FIXTURE_EXPRESSIONS[0], id: `id-${name}`, name, displayName: name, tags, kind, media, status: "active",
});

const dam = ["dam_a", "dam_b", "dam_c"].map((name) => make(name, ["농담곰"]));
const chi = ["chi_a", "chi_b"].map((name) => make(name));
const solo = make("solo");
const ITEMS = [...dam, ...chi, solo];
// 「자주·최근」의 감쇠를 세는 기준 시각(#5503). 아래 오래된 시험들의 사용 시각(10~300ms)은 모두 이 시각보다 한참 앞이라 횟수가 같으면 **최근 순**이 그대로 드러난다.
const NOW = Date.UTC(2026, 10, 7, 12);
const DAY = 86_400_000;
const none = { usage: emptyExpressionUsage("w", "m"), favorites: emptyExpressionFavorites("w", "m"), nowMs: NOW };
const names = (section: ExpressionSection) => section.items.map((item) => item.name);
const shape = (sections: readonly ExpressionSection[]) => sections.map((section) => [section.id, section.kind, section.label, names(section)]);

describe("buildExpressionSections — 검색어가 없을 때", () => {
  it("쓴 적도 별표도 없으면 세트별 -> 기타뿐이고(세트는 코어 기본 차례 = 이름순), 세트 이름표는 공통 태그(없으면 앞머리)다", () => {
    expect(shape(buildExpressionSections(ITEMS, "emoticon", { query: "", ...none }))).toEqual([
      ["set:chi", "set", "chi", ["chi_a", "chi_b"]],
      ["set:dam", "set", "농담곰", ["dam_a", "dam_b", "dam_c"]],
      ["other", "other", null, ["solo"]],
    ]);
  });
  it("최근 -> 즐겨찾기 -> 세트별 -> 기타 차례이고, 최근은 마지막으로 쓴 시각 순, 즐겨찾기는 고른 차례다", () => {
    let usage = emptyExpressionUsage("w", "m");
    usage = recordExpressionUse(usage, "id-chi_a", 100);
    usage = recordExpressionUse(usage, "id-solo", 300);
    usage = recordExpressionUse(usage, "id-dam_b", 200);
    const favorites = ["id-dam_c", "id-chi_b"].reduce(toggleExpressionFavorite, emptyExpressionFavorites("w", "m"));
    const sections = buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites, nowMs: NOW });
    expect(sections.map((section) => section.id)).toEqual(["recent", "favorites", "set:chi", "set:dam", "other"]);
    expect(names(sections[0]!)).toEqual(["solo", "dam_b", "chi_a"]);
    expect(names(sections[1]!)).toEqual(["dam_c", "chi_b"]);
  });
  it("최근·즐겨찾기는 바로가기일 뿐이다 - 세트와 기타를 합치면 이 탭의 보관함 전체가 한 번씩 선다", () => {
    let usage = emptyExpressionUsage("w", "m");
    for (const item of ITEMS) usage = recordExpressionUse(usage, item.id, 10);
    const favorites = toggleExpressionFavorite(emptyExpressionFavorites("w", "m"), "id-solo");
    const sections = buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites, nowMs: NOW });
    const stored = sections.filter((section) => section.kind === "set" || section.kind === "other").flatMap(names);
    expect([...stored].sort()).toEqual(ITEMS.map((item) => item.name).sort());
    expect(new Set(stored).size).toBe(ITEMS.length);
  });
  it("최근 구역은 EXPRESSION_RECENT_MAX 개까지다", () => {
    const many = Array.from({ length: EXPRESSION_RECENT_MAX + 4 }, (_, i) => make(`item${String(i).padStart(2, "0")}`));
    let usage = emptyExpressionUsage("w", "m");
    many.forEach((item, i) => { usage = recordExpressionUse(usage, item.id, 10 + i); });
    const recent = buildExpressionSections(many, "emoticon", { query: "", usage, favorites: none.favorites, nowMs: NOW })[0]!;
    expect(recent.kind).toBe("recent");
    expect(recent.items).toHaveLength(EXPRESSION_RECENT_MAX);
    expect(recent.items[0]!.name).toBe(`item${String(many.length - 1).padStart(2, "0")}`);
  });
  it("지워지거나 이 탭에 없는 등록의 별표·기록은 구역에 서지 않는다 - 구역이 비면 구역도 없다", () => {
    const usage = recordExpressionUse(emptyExpressionUsage("w", "m"), "id-gone", 10);
    const favorites = toggleExpressionFavorite(emptyExpressionFavorites("w", "m"), "id-gone");
    expect(buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites, nowMs: NOW }).map((section) => section.id)).toEqual(["set:chi", "set:dam", "other"]);
    // 같은 등록이어도 다른 탭이면 이 탭의 구역에 서지 않는다(이모티콘 칸은 GIF 탭에 없다).
    expect(buildExpressionSections(ITEMS, "gif", { query: "", ...none })).toEqual([]);
  });
});

// 이모티콘 탭 맨 위 「자주·최근」 (#5503, owner 2026-11-07): 정지 그림과 GIF 를 섞어 쓴 횟수와 최근을 함께 본 점수로 세운 12개. GIF 탭의 「최근」은 그대로다.
describe("buildExpressionSections — 이모티콘 탭 맨 위 「자주·최근」 (#5503)", () => {
  const gifImage: ExpressionImage = { ...png, mime: "image/gif", frameCount: 8, durationMs: 800 };
  const gifMedia: ExpressionMedia = { small: gifImage, large: gifImage, thumb: png };
  const makeGif = (name: string): Expression => ({ ...make(name), media: gifMedia });
  // 작은 팀 이모지: 종류가 `emoji` 라 이모지 칸(`team`)에 선다 - 이모티콘 탭의 어느 구역에도 없다.
  const makeEmoji = (name: string): Expression => make(name, [], "emoji");
  const useIt = (usage: ReturnType<typeof emptyExpressionUsage>, item: Expression, times: number, daysAgo: number) => {
    let next = usage;
    for (let i = 0; i < times; i += 1) next = recordExpressionUse(next, item.id, NOW - daysAgo * DAY);
    return next;
  };
  const top = (items: readonly Expression[], usage: ReturnType<typeof emptyExpressionUsage>, tab: "emoticon" | "gif" = "emoticon") =>
    buildExpressionSections(items, tab, { query: "", usage, favorites: none.favorites, nowMs: NOW }).find((section) => section.id === "recent");

  const still1 = make("still1");
  const still2 = make("still2");
  const gif1 = makeGif("gif1");
  const gif2 = makeGif("gif2");
  const tiny = makeEmoji("tiny");

  it("정지 그림과 GIF 를 섞어 횟수와 최근을 함께 본 점수로 세우고, 작은 팀 이모지는 많이 써도 뺀다", () => {
    let usage = emptyExpressionUsage("w", "m");
    usage = useIt(usage, gif1, 3, 2); // 3 x 0.5^(2/7) = 2.46
    usage = useIt(usage, still1, 1, 1); // 0.91
    usage = useIt(usage, still2, 1, 10); // 0.37
    usage = useIt(usage, gif2, 1, 20); // 0.14
    usage = useIt(usage, tiny, 50, 0); // 점수가 가장 높아도 이 칸의 후보가 아니다
    const section = top([still1, still2, gif1, gif2, tiny], usage)!;
    expect(section.kind).toBe("recent");
    expect(names(section)).toEqual(["gif1", "still1", "still2", "gif2"]);
  });

  it("GIF 는 이 탭의 세트·기타에는 없고(GIF 탭의 보관함) 이 칸에만 서며, 정지 그림은 이 칸과 아래 구역에 한 번씩 선다", () => {
    let usage = useIt(emptyExpressionUsage("w", "m"), gif1, 2, 1);
    usage = useIt(usage, still1, 1, 1);
    const sections = buildExpressionSections([still1, still2, gif1, tiny], "emoticon", { query: "", usage, favorites: none.favorites, nowMs: NOW });
    expect(names(sections[0]!)).toEqual(["gif1", "still1"]);
    const stored = sections.filter((section) => section.kind === "set" || section.kind === "other").flatMap(names);
    expect([...stored].sort()).toEqual(["still1", "still2"]); // 보관함은 정지 그림뿐 - 이 칸의 GIF 와 작은 이모지는 들어오지 않는다
  });

  it("12개까지이고, 정지 그림과 GIF 가 섞여 12개를 채운다", () => {
    const stills = Array.from({ length: 7 }, (_, i) => make(`s${i}`));
    const gifs = Array.from({ length: 7 }, (_, i) => makeGif(`g${i}`));
    // 정지 그림과 GIF 가 번갈아 반 날씩 더 오래된 차례로 한 번씩 쓰였다(14개).
    const mixed = stills.flatMap((still, i) => [still, gifs[i]!]);
    let usage = emptyExpressionUsage("w", "m");
    mixed.forEach((item, i) => { usage = useIt(usage, item, 1, i * 0.5); });
    const section = top(mixed, usage)!;
    // 7개씩이라 한 종류만으로는 12개가 안 차고, 점수 순서로 두 종류가 번갈아 섞여 12개가 된다.
    expect(names(section)).toEqual(["s0", "g0", "s1", "g1", "s2", "g2", "s3", "g3", "s4", "g4", "s5", "g5"]);
    expect(section.items).toHaveLength(EXPRESSION_RECENT_MAX);
  });

  it("숨기거나 지운 등록·보관함에 없는 기록은 서지 않고, 서 있을 것이 하나도 없으면 칸이 없다", () => {
    const hidden = { ...makeGif("hidden_gif"), status: "hidden" as const };
    const deleted = { ...make("deleted_still"), status: "deleted" as const };
    let usage = useIt(emptyExpressionUsage("w", "m"), hidden, 9, 0);
    usage = useIt(usage, deleted, 9, 0);
    usage = useIt(usage, make("gone"), 9, 0); // 보관함에 없는 기록
    usage = useIt(usage, still1, 1, 3);
    expect(names(top([hidden, deleted, still1, gif1], usage)!)).toEqual(["still1"]);
    // 후보와 맞는 기록이 없으면(작은 이모지·숨김만 썼다) 칸 자체가 없다.
    const onlyHidden = useIt(useIt(emptyExpressionUsage("w", "m"), tiny, 3, 0), hidden, 3, 0);
    expect(top([hidden, tiny, still1, gif1], onlyHidden)).toBeUndefined();
  });

  it("머리글의 사전 열쇠: 이모티콘 탭 맨 위 칸만 「자주·최근」이고, GIF 탭의 「최근」과 나머지 구역은 종류의 이름 그대로다", () => {
    let usage = useIt(emptyExpressionUsage("w", "m"), still1, 1, 1);
    usage = useIt(usage, gif1, 1, 1);
    const favorites = toggleExpressionFavorite(emptyExpressionFavorites("w", "m"), still1.id);
    const keys = (tab: "emoticon" | "gif") =>
      buildExpressionSections([still1, gif1], tab, { query: "", usage, favorites, nowMs: NOW }).map((section) => [section.id, section.kind, expressionSectionNameKey(section)]);
    expect(keys("emoticon")).toEqual([
      ["recent", "recent", "expressions.picker.sectionFrecent"], // id·종류는 그대로 `recent`, 머리글만 다른 말
      ["favorites", "favorites", "expressions.picker.sectionFavorites"],
      ["other", "other", "expressions.picker.sectionOther"],
    ]);
    expect(keys("gif")).toEqual([
      ["recent", "recent", "expressions.picker.sectionRecent"], // 마지막으로 쓴 순이라 「최근」
      ["other", "other", "expressions.picker.sectionOther"],
    ]);
    // 검색 결과와 세트는 사전 열쇠가 없다(결과는 이름이 없고, 세트는 데이터가 이름이다).
    expect(expressionSectionNameKey({ kind: "results" })).toBeNull();
    expect(expressionSectionNameKey({ kind: "set" })).toBeNull();
  });

  it("GIF 탭의 「최근」은 그대로다 - GIF 끼리 마지막으로 쓴 순이고 횟수·감쇠는 보지 않는다", () => {
    let usage = useIt(emptyExpressionUsage("w", "m"), gif1, 5, 10); // 자주: 이모티콘 탭 점수로는 5 x 0.37 = 1.86
    usage = useIt(usage, gif2, 1, 0); // 방금 한 번: 점수 1
    usage = useIt(usage, still1, 4, 0); // 정지 그림은 GIF 탭에 없다
    expect(names(top([still1, gif1, gif2], usage, "gif")!)).toEqual(["gif2", "gif1"]);
    expect(top([still1, gif1, gif2], usage, "gif")!.kind).toBe("recent");
    // 같은 기록이 이모티콘 탭에서는 점수 순이다 - 두 탭의 규칙이 서로 다르다는 증거.
    expect(names(top([still1, gif1, gif2], usage)!)).toEqual(["still1", "gif1", "gif2"]);
  });
});

describe("buildExpressionSections — 검색어가 있을 때", () => {
  it("구역 없이 결과 하나이고, 맞는 것이 없으면 구역이 없다", () => {
    const found = buildExpressionSections(ITEMS, "emoticon", { query: "dam_b", ...none });
    expect(shape(found)).toEqual([["results", "results", null, ["dam_b"]]]);
    expect(buildExpressionSections(ITEMS, "emoticon", { query: "zzzz", ...none })).toEqual([]);
  });
});

describe("moveGridPosition — 구역을 이어 붙인 격자 위의 방향키", () => {
  // 구역 크기 [8, 3, 1]: 첫 구역은 6 + 2 두 줄. 열은 6.
  const sizes = [8, 3, 1];
  const at = (section: number, index: number) => ({ section, index });
  it("열 수는 팝오버 기준 6이다", () => {
    expect(EXPRESSION_GRID_COLS).toBe(6);
  });
  it("좌우: 한 칸씩 가고, 구역 끝에서는 이웃 구역으로 넘어가며, 격자 끝에서는 멈춘다", () => {
    expect(moveGridPosition(sizes, at(0, 0), "ArrowRight")).toEqual(at(0, 1));
    expect(moveGridPosition(sizes, at(0, 7), "ArrowRight")).toEqual(at(1, 0));
    expect(moveGridPosition(sizes, at(1, 0), "ArrowLeft")).toEqual(at(0, 7));
    expect(moveGridPosition(sizes, at(2, 0), "ArrowRight")).toBeNull();
    expect(moveGridPosition(sizes, at(0, 0), "ArrowLeft")).toBeNull();
  });
  it("위아래: 같은 열의 다음 줄로 가고, 아래 줄이 짧으면 그 줄의 끝으로, 구역 경계에서는 이웃 구역의 같은 열로 넘어간다", () => {
    expect(moveGridPosition(sizes, at(0, 1), "ArrowDown")).toEqual(at(0, 7));
    expect(moveGridPosition(sizes, at(0, 4), "ArrowDown")).toEqual(at(0, 7)); // 둘째 줄은 2칸뿐
    expect(moveGridPosition(sizes, at(0, 7), "ArrowDown")).toEqual(at(1, 1));
    expect(moveGridPosition(sizes, at(0, 6), "ArrowDown")).toEqual(at(1, 0));
    expect(moveGridPosition(sizes, at(1, 2), "ArrowDown")).toEqual(at(2, 0)); // 다음 구역이 1칸뿐이면 그 칸
    expect(moveGridPosition(sizes, at(2, 0), "ArrowDown")).toBeNull();
    expect(moveGridPosition(sizes, at(0, 7), "ArrowUp")).toEqual(at(0, 1));
    expect(moveGridPosition(sizes, at(1, 1), "ArrowUp")).toEqual(at(0, 7)); // 이웃 구역의 마지막 줄 같은 열(없으면 끝)
    expect(moveGridPosition(sizes, at(0, 2), "ArrowUp")).toBeNull();
  });
  it("Home/End는 격자 전체의 처음과 끝이고, 다른 키와 빈 구역은 움직이지 않는다", () => {
    expect(moveGridPosition(sizes, at(1, 1), "Home")).toEqual(at(0, 0));
    expect(moveGridPosition(sizes, at(1, 1), "End")).toEqual(at(2, 0));
    expect(moveGridPosition(sizes, at(1, 1), "a")).toBeNull();
    expect(moveGridPosition([0, 3], at(1, 0), "ArrowLeft")).toBeNull(); // 앞 구역이 비어 있으면 건너뛴다 -> 갈 곳 없음
    expect(moveGridPosition([0, 3], at(1, 0), "Home")).toBeNull(); // 이미 처음
    expect(moveGridPosition([], at(0, 0), "ArrowRight")).toBeNull();
  });
});

describe("isContextMenuSummonKey — 칸 메뉴를 키보드로 부르는 키 (#5486)", () => {
  const press = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    isContextMenuSummonKey({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  it("전용 메뉴 키와 Shift+F10 만 부른다", () => {
    expect(press("ContextMenu")).toBe(true);
    expect(press("F10", { shiftKey: true })).toBe(true);
    expect(press("F10")).toBe(false);
    expect(press("m")).toBe(false);
    expect(press("Enter")).toBe(false);
    expect(press("ArrowDown", { shiftKey: true })).toBe(false);
  });
  it("Ctrl·Alt·⌘ 이 함께 눌린 F10 은 다른 단축키의 몫이라 부르지 않는다", () => {
    for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) expect(press("F10", { shiftKey: true, [mod]: true })).toBe(false);
  });
});
