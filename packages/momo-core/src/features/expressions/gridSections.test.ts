import { describe, expect, it } from "vitest";
import { emptyExpressionFavorites, toggleExpressionFavorite } from "./favorites";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import {
  buildExpressionSections,
  EXPRESSION_GRID_COLS,
  EXPRESSION_RECENT_MAX,
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
const none = { usage: emptyExpressionUsage("w", "m"), favorites: emptyExpressionFavorites("w", "m") };
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
    const sections = buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites });
    expect(sections.map((section) => section.id)).toEqual(["recent", "favorites", "set:chi", "set:dam", "other"]);
    expect(names(sections[0]!)).toEqual(["solo", "dam_b", "chi_a"]);
    expect(names(sections[1]!)).toEqual(["dam_c", "chi_b"]);
  });
  it("최근·즐겨찾기는 바로가기일 뿐이다 - 세트와 기타를 합치면 이 탭의 보관함 전체가 한 번씩 선다", () => {
    let usage = emptyExpressionUsage("w", "m");
    for (const item of ITEMS) usage = recordExpressionUse(usage, item.id, 10);
    const favorites = toggleExpressionFavorite(emptyExpressionFavorites("w", "m"), "id-solo");
    const sections = buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites });
    const stored = sections.filter((section) => section.kind === "set" || section.kind === "other").flatMap(names);
    expect([...stored].sort()).toEqual(ITEMS.map((item) => item.name).sort());
    expect(new Set(stored).size).toBe(ITEMS.length);
  });
  it("최근 구역은 EXPRESSION_RECENT_MAX 개까지다", () => {
    const many = Array.from({ length: EXPRESSION_RECENT_MAX + 4 }, (_, i) => make(`item${String(i).padStart(2, "0")}`));
    let usage = emptyExpressionUsage("w", "m");
    many.forEach((item, i) => { usage = recordExpressionUse(usage, item.id, 10 + i); });
    const recent = buildExpressionSections(many, "emoticon", { query: "", usage, favorites: none.favorites })[0]!;
    expect(recent.kind).toBe("recent");
    expect(recent.items).toHaveLength(EXPRESSION_RECENT_MAX);
    expect(recent.items[0]!.name).toBe(`item${String(many.length - 1).padStart(2, "0")}`);
  });
  it("지워지거나 이 탭에 없는 등록의 별표·기록은 구역에 서지 않는다 - 구역이 비면 구역도 없다", () => {
    const usage = recordExpressionUse(emptyExpressionUsage("w", "m"), "id-gone", 10);
    const favorites = toggleExpressionFavorite(emptyExpressionFavorites("w", "m"), "id-gone");
    expect(buildExpressionSections(ITEMS, "emoticon", { query: "", usage, favorites }).map((section) => section.id)).toEqual(["set:chi", "set:dam", "other"]);
    // 같은 등록이어도 다른 탭이면 이 탭의 구역에 서지 않는다(이모티콘 칸은 GIF 탭에 없다).
    expect(buildExpressionSections(ITEMS, "gif", { query: "", ...none })).toEqual([]);
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
