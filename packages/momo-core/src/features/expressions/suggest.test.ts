import { describe, expect, it } from "vitest";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import {
  EXPRESSION_SUGGEST_LIMIT,
  EXPRESSION_SUGGEST_WHOLE_TEXT_MAX,
  KEYWORD_ENDING_TABLE,
  canonicalKeyword,
  normalizeKeyword,
  suggestExpressions,
  suggestionKeywords,
} from "./suggest";
import type { Expression } from "./types";

// #5454 1단계. 11-06에 등록한 그림처럼 꼬리표가 5~6개인 항목을 만들어 쓴다. 그림 바이트는 없다:
// 미디어는 시험 고정값(메타데이터뿐)이고, 맞추기는 이름·표시 이름·꼬리표·종류만 읽는다.
const MEDIA_BASE = FIXTURE_EXPRESSIONS[1];
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const made = (n: number, name: string, displayName: string, tags: string[], over: Partial<Expression> = {}): Expression => ({
  ...MEDIA_BASE, id: uid(n), name, displayName, tags, kind: "sticker", ...over,
});
const ids = (items: readonly Pick<Expression, "id">[]) => items.map((item) => item.id);

const LAUGH = made(11, "belly_laugh", "빵터짐", ["ㅋㅋ", "웃음", "빵터짐", "웃겨", "꿀잼", "대박"]);
const SIGH = made(12, "deep_sigh", "한숨 푹", ["한숨", "ㅠㅠ", "지침", "퇴근", "하아", "피곤해"]);
const HUNGRY = made(13, "hungry_cat", "배고픈 고양이", ["배고픔", "밥", "허기", "꼬르륵", "점심", "먹고싶다"]);
const KING = made(14, "king_batne", "킹받네", ["킹받네", "약올림", "능청", "짜증", "얄미움"]);
const SLEEPY = made(15, "sleepy_panda", "졸린 판다", ["졸림", "잠", "하품", "피곤", "꿀잠"]);
/** 작은 팀 이모지: 꼬리표가 모두 맞아도 추천에서 빠진다. */
const TINY = made(16, "tiny_laugh", "작은 웃음", ["ㅋㅋ", "웃음", "한숨", "배고픔", "킹받네"], { kind: "emoji" });
const HIDDEN = made(17, "gone_laugh", "사라진 웃음", ["ㅋㅋ"], { status: "hidden", media: null });
const CATALOG = [TINY, HIDDEN, LAUGH, SIGH, HUNGRY, KING, SLEEPY];

describe("normalizeKeyword: 맞추기 전의 정리", () => {
  it("NFC → 반복 줄이기 → 띄어쓰기·문장부호 지우기 → 소문자 순서로 줄인다", () => {
    const rows: Array<[string, string]> = [
      ["ㅋㅋㅋㅋ", "ㅋㅋ"], ["ㅎㅎㅎ", "ㅎㅎ"], ["ㅠㅠㅠ", "ㅠㅠ"], ["아아아아아", "아아"], ["sooooo", "soo"], ["😂😂😂😂", "😂😂"],
      ["ㅋㅋ", "ㅋㅋ"], ["ㅋ", "ㅋ"], ["하하", "하하"],
      ["하 오늘 길다 한숨", "하오늘길다한숨"], [" 배 고파!!! ", "배고파"], ["ㅋㅋ~~ ^^", "ㅋㅋ"], ["Hello, World~", "helloworld"], ["🎉!", "🎉"],
      ["", ""], ["...", ""], ["   ", ""],
    ];
    for (const [text, want] of rows) expect(normalizeKeyword(text), text).toBe(want);
    // 끝말 정리표는 글자 꼴만 고치는 이 함수의 몫이 아니다.
    expect(normalizeKeyword("배고프다")).toBe("배고프다");
  });
  it("macOS식 NFD 입력도 같은 값이 된다: 분해된 글자는 NFC가 먼저여야 반복으로 보인다", () => {
    for (const word of ["배고파", "배고프다", "한숨", "하하하"]) {
      const decomposed = word.normalize("NFD");
      expect(decomposed, word).not.toBe(word);
      expect(normalizeKeyword(decomposed), word).toBe(normalizeKeyword(word));
    }
    expect(normalizeKeyword("하하하".normalize("NFD"))).toBe("하하");
  });
  it("띄어쓰기를 지운 뒤 붙는 반복도 줄이고, 두 번 정리해도 같다", () => {
    expect(normalizeKeyword("ㅋ ㅋ ㅋ ㅋ")).toBe("ㅋㅋ");
    expect(normalizeKeyword("ㅋㅋ.ㅋㅋ")).toBe("ㅋㅋ");
    for (const text of ["ㅋ ㅋ ㅋ ㅋ", "ㅠㅠㅠ ㅠㅠㅠ", "하 하 하", "AaA!!!", " 배고파요~~~ ", "🎉 🎉 🎉", "한숨".normalize("NFD")]) {
      expect(normalizeKeyword(normalizeKeyword(text)), text).toBe(normalizeKeyword(text));
    }
  });
});

describe("KEYWORD_ENDING_TABLE: 끝말 정리표", () => {
  it("키와 값은 정리된 꼴이고, 한 꼴은 한 낱말로만 모이며, 모은 낱말이 다른 낱말로 다시 모이지 않는다", () => {
    const forms = Object.values(KEYWORD_ENDING_TABLE).flat();
    for (const [canonical, list] of Object.entries(KEYWORD_ENDING_TABLE)) {
      expect(normalizeKeyword(canonical), canonical).toBe(canonical);
      expect(list.length, canonical).toBeGreaterThan(0);
      for (const form of list) expect(normalizeKeyword(form), form).toBe(form);
    }
    expect(new Set(forms).size).toBe(forms.length);
    for (const canonical of Object.keys(KEYWORD_ENDING_TABLE)) expect(forms).not.toContain(canonical);
  });
  it("표에 있는 꼴만 모은다: 배고프다·배고픔·배고파요 → 배고파, 졸려요 → 졸려, 그 밖의 낱말은 그대로", () => {
    const rows: Array<[string, string]> = [
      ["배고프다", "배고파"], ["배고픔", "배고파"], ["배고파요", "배고파"], ["배고파", "배고파"], ["배 고프다!", "배고파"],
      ["졸려요", "졸려"], ["졸려", "졸려"], ["배고프다".normalize("NFD"), "배고파"],
      ["배고파서", "배고파서"], ["한숨", "한숨"], ["ㅋㅋㅋㅋ", "ㅋㅋ"], ["Hello", "hello"],
      // 보통 객체의 상속 멤버(constructor)를 표 안의 낱말로 읽지 않는다.
      ["constructor", "constructor"], ["__proto__", "proto"],
    ];
    for (const [text, want] of rows) expect(canonicalKeyword(text), text).toBe(want);
  });
});

describe("suggestionKeywords: 입력에서 맞춰 볼 낱말", () => {
  it("마지막 낱말, 그리고 정리 뒤 8자 이하의 짧은 글은 글 전체도 낸다", () => {
    expect(suggestionKeywords("하 오늘 길다 한숨")).toEqual(["한숨", "하오늘길다한숨"]);
    expect(suggestionKeywords("한숨")).toEqual(["한숨"]);
    expect(suggestionKeywords("킹 받네")).toEqual(["받네", "킹받네"]);
    expect(suggestionKeywords("  배고프다 ... ")).toEqual(["배고파"]);
    expect(suggestionKeywords("오늘 점심 뭐 먹을지 모르겠다 한숨")).toEqual(["한숨"]);
    expect(suggestionKeywords("")).toEqual([]);
    expect(suggestionKeywords("   ")).toEqual([]);
    expect(suggestionKeywords("?!")).toEqual([]);
    expect(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX).toBe(8);
  });
});

describe("suggestExpressions: 맞추기", () => {
  it("ㅋㅋㅋㅋ·하 오늘 길다 한숨·배고파·배고프다가 맞는 큰 그림을 낸다(꼬리표 「배고픔」도 접어서 맞는다)", () => {
    expect(ids(suggestExpressions("ㅋㅋㅋㅋ", CATALOG))).toEqual([LAUGH.id]);
    expect(ids(suggestExpressions("하 오늘 길다 한숨", CATALOG))).toEqual([SIGH.id]);
    for (const text of ["배고파", "배고프다", "배고파요", "배고프네~~~", "배고파".normalize("NFD"), "  배고프다 ... "]) {
      expect(ids(suggestExpressions(text, CATALOG)), text).toEqual([HUNGRY.id]);
    }
    expect(ids(suggestExpressions("피곤하다", CATALOG))).toEqual([SIGH.id]);
    // 정확히 같을 때만 맞는다: 낱말의 일부나 더 긴 낱말은 줄을 띄우지 않는다.
    for (const text of ["배고", "한", "ㅋ", "배고파서"]) expect(suggestExpressions(text, CATALOG), text).toEqual([]);
  });
  it("짧은 글은 글 전체도 맞추고(8자 경계), 긴 글은 마지막 낱말만 맞춘다", () => {
    const eight = made(21, "eight_chars", "오늘도수고했어요", ["토닥", "응원", "고생", "퇴근", "칭찬"]);
    const nine = made(22, "nine_chars", "오늘도수고많았어요", ["토닥", "응원", "고생", "퇴근", "칭찬"]);
    expect(Array.from(normalizeKeyword("오늘도 수고 했어요"))).toHaveLength(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX);
    expect(Array.from(normalizeKeyword("오늘도 수고 많았어요"))).toHaveLength(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX + 1);
    expect(ids(suggestExpressions("오늘도 수고 했어요", [eight, nine]))).toEqual([eight.id]);
    expect(suggestExpressions("오늘도 수고 많았어요", [eight, nine])).toEqual([]);
    expect(ids(suggestExpressions("킹 받네", CATALOG))).toEqual([KING.id]);
    // 점심은 꼬리표지만 마지막 낱말도 글 전체도 아니다.
    expect(suggestExpressions("오늘 점심 뭐 먹지", CATALOG)).toEqual([]);
    expect(ids(suggestExpressions("오늘 점심 뭐 먹지 하 배고파", CATALOG))).toEqual([HUNGRY.id]);
  });
  it("맞는 것이 없거나 비었거나 꺼 둔 낱말이면 빈 배열이고, 최근·즐겨찾기는 맞지 않는 것을 들이지 않는다", () => {
    for (const text of ["오늘 점심 뭐 먹지", "안녕하세요", "", "   ", "...", "ㅡㅡ"]) expect(suggestExpressions(text, CATALOG), text).toEqual([]);
    expect(suggestExpressions("오늘 점심 뭐 먹지", CATALOG, { recent: [LAUGH.id, SIGH.id], favorites: [KING.id] })).toEqual([]);
    expect(suggestExpressions("한숨", [])).toEqual([]);
    // 꺼 둔 낱말: 친 그대로 넣어도, 같은 낱말의 다른 꼴이어도 막힌다. 마지막 낱말·글 전체 어느 쪽이든.
    expect(suggestExpressions("한숨", CATALOG, { muted: ["한숨"] })).toEqual([]);
    expect(suggestExpressions("배고파", CATALOG, { muted: ["배고프다"] })).toEqual([]);
    expect(suggestExpressions("ㅋㅋㅋㅋ", CATALOG, { muted: ["ㅋㅋ!"] })).toEqual([]);
    expect(suggestExpressions("킹 받네", CATALOG, { muted: ["킹받네"] })).toEqual([]);
    expect(suggestExpressions("하 오늘 길다 한숨", CATALOG, { muted: ["오늘", "배고파", ""] }).map((item) => item.id)).toEqual([SIGH.id]);
  });
  it("작은 이모지 종류와 active가 아닌 항목은 빼고, 종류가 없는 옛 등록은 큰 그림으로 센다", () => {
    expect(suggestExpressions("ㅋㅋ", [TINY])).toEqual([]);
    expect(ids(suggestExpressions("ㅋㅋ", [TINY, HIDDEN, LAUGH]))).toEqual([LAUGH.id]);
    expect(suggestExpressions("ㅋㅋ", [{ ...LAUGH, status: "deleted", media: null }])).toEqual([]);
    const { kind: _kind, ...legacy } = LAUGH;
    expect(ids(suggestExpressions("ㅋㅋ", [legacy]))).toEqual([LAUGH.id]);
    // 실제 보관함 고정값: 움직이는 팀 이모지(party_parrot)도 작은 종류라 빠진다. 그림 문자 꼬리표는 정리에서 살아남는다.
    expect(suggestExpressions("축하", FIXTURE_EXPRESSIONS)).toEqual([]);
    expect(ids(suggestExpressions("👍", FIXTURE_EXPRESSIONS))).toEqual([FIXTURE_EXPRESSIONS[2].id]);
    expect(ids(suggestExpressions("놀람", FIXTURE_EXPRESSIONS))).toEqual([FIXTURE_EXPRESSIONS[1].id]);
  });
  it("순서는 꼬리표 → 이름·표시 이름 → 최근 → 즐겨찾기, 같은 항목은 한 번, 보관함 차례와 무관하다", () => {
    const tagOnly = made(31, "a_tag_only", "에이", ["ㅋㅋ", "웃음", "에이", "하나", "둘"]);
    const nameAndRecent = made(32, "b_name", "ㅋㅋ", ["웃음", "비", "하나", "둘", "셋"]);
    const tagAndFavorite = made(33, "c_favorite", "씨", ["ㅋㅋ", "웃음", "씨", "하나", "둘"]);
    const tagAndRecent = made(34, "d_recent", "디", ["ㅋㅋ", "웃음", "디", "하나", "둘"]);
    const plain = made(35, "e_plain", "이", ["ㅋㅋ", "웃음", "이", "하나", "둘"]);
    const scrambled = [plain, nameAndRecent, tagOnly, tagAndFavorite, tagAndRecent];
    const options = { recent: [nameAndRecent.id, tagAndRecent.id], favorites: [tagAndFavorite.id] };
    // 최근에 쓴 이름 맞음(b)도 꼬리표 맞음 뒤다. 꼬리표 맞음 안에서는 최근(d) → 즐겨찾기(c) → 이름순(a, e).
    expect(ids(suggestExpressions("ㅋㅋ", scrambled, options))).toEqual([tagAndRecent.id, tagAndFavorite.id, tagOnly.id, plain.id, nameAndRecent.id]);
    expect(ids(suggestExpressions("ㅋㅋ", [...scrambled].reverse(), options))).toEqual(ids(suggestExpressions("ㅋㅋ", scrambled, options)));
    expect(ids(suggestExpressions("ㅋㅋ", scrambled, { ...options, limit: 3 }))).toEqual([tagAndRecent.id, tagAndFavorite.id, tagOnly.id]);
    // 최근·즐겨찾기가 없으면 꼬리표 맞음 뒤 이름 맞음, 같은 칸은 이름순이다.
    expect(ids(suggestExpressions("ㅋㅋ", scrambled))).toEqual([tagOnly.id, tagAndFavorite.id, tagAndRecent.id, plain.id, nameAndRecent.id]);

    // 같은 항목은 한 번: 마지막 낱말과 글 전체가 모두 맞고, 이름도 맞고, 최근·즐겨찾기에도 있고, 보관함에 두 번 들어 있어도.
    const twice = made(41, "twice", "ㅎㅎ", ["ㅎㅎ", "ㅋㅋㅎㅎ", "웃음", "하나", "둘"]);
    expect(suggestionKeywords("ㅋㅋ ㅎㅎ")).toEqual(["ㅎㅎ", "ㅋㅋㅎㅎ"]);
    expect(ids(suggestExpressions("ㅋㅋ ㅎㅎ", [twice, twice, { ...twice }], { recent: [twice.id, twice.id], favorites: [twice.id] }))).toEqual([twice.id]);

    // 개수: 기본 5, limit이 1보다 작거나 숫자가 아니면 빈 배열.
    const many = Array.from({ length: 7 }, (_, index) => made(60 + index, `many_${index}`, `많음 ${index}`, ["ㅋㅋ", "웃음", "하나", "둘", "셋"]));
    expect(EXPRESSION_SUGGEST_LIMIT).toBe(5);
    expect(suggestExpressions("ㅋㅋ", many)).toHaveLength(5);
    expect(suggestExpressions("ㅋㅋ", many, { limit: 2 })).toHaveLength(2);
    expect(suggestExpressions("ㅋㅋ", many, { limit: 0 })).toEqual([]);
    expect(suggestExpressions("ㅋㅋ", many, { limit: Number.NaN })).toEqual([]);
  });
  it("받은 값을 바꾸지 않는다(얼린 입력이 그대로이고, 돌려주는 것은 보관함의 항목 그대로)", () => {
    const frozen = Object.freeze(CATALOG.map((item) => Object.freeze({ ...item, tags: Object.freeze([...item.tags]) as string[] })));
    const options = Object.freeze({ recent: Object.freeze([LAUGH.id]), favorites: Object.freeze([SIGH.id]), muted: Object.freeze(["졸려"]) });
    const before = JSON.stringify([frozen, options]);
    const hits = suggestExpressions("ㅋㅋㅋㅋ", frozen, options);
    expect(JSON.stringify([frozen, options])).toBe(before);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(frozen[2]);
  });
});
