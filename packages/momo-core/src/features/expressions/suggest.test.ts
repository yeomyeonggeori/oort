import { describe, expect, it } from "vitest";
import { FIXTURE_EXPRESSIONS } from "./fixtures";
import {
  EXPRESSION_SUGGEST_DEBOUNCE_MS,
  EXPRESSION_SUGGEST_LIMIT,
  EXPRESSION_SUGGEST_PER_KEYWORD,
  EXPRESSION_SUGGEST_WHOLE_TEXT_MAX,
  KEYWORD_ENDING_TABLE,
  canonicalKeyword,
  normalizeKeyword,
  suggestExpressionRow,
  suggestExpressions,
  isKeywordOnlyInput,
  planExpressionSuggest,
  suggestionKeywords,
  suggestionWordAtCaret,
  type ExpressionSuggestPlan,
  type ExpressionSuggestTrigger,
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
  it("문구 안의 낱말 모두를 나온 차례로(같은 낱말은 처음 자리 하나), 끝에 정리 뒤 8자 이하의 짧은 글은 글 전체도 낸다 (#5588)", () => {
    expect(suggestionKeywords("ㅋㅋ 개웃기네 진심")).toEqual(["ㅋㅋ", "개웃기네", "진심", "ㅋㅋ개웃기네진심"]);
    expect(suggestionKeywords("하 오늘 길다 한숨")).toEqual(["하", "오늘", "길다", "한숨", "하오늘길다한숨"]);
    expect(suggestionKeywords("한숨")).toEqual(["한숨"]);
    expect(suggestionKeywords("킹 받네")).toEqual(["킹", "받네", "킹받네"]);
    expect(suggestionKeywords("  배고프다 ... ")).toEqual(["배고파"]);
    // 9자 넘는 글은 글 전체를 내지 않는다. 반복을 줄인 꼴이 같으면 같은 낱말이다(ㅋㅋㅋ = ㅋㅋ).
    expect(suggestionKeywords("오늘 점심 뭐 먹을지 모르겠다 한숨")).toEqual(["오늘", "점심", "뭐", "먹을지", "모르겠다", "한숨"]);
    expect(suggestionKeywords("ㅋㅋ 진심 ㅋㅋㅋ!")).toEqual(["ㅋㅋ", "진심", "ㅋㅋ진심ㅋㅋ"]);
    expect(suggestionKeywords("")).toEqual([]);
    expect(suggestionKeywords("   ")).toEqual([]);
    expect(suggestionKeywords("?!")).toEqual([]);
    expect(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX).toBe(8);
  });
});

describe("EXPRESSION_SUGGEST_DEBOUNCE_MS: 화면이 기다리는 시간", () => {
  // #5476 계약: 「약 0.3초 멈추면」 줄을 띄운다. 웹(과 이어서 폰)이 이 값 하나를 읽으므로 계약 숫자를 여기서 못 박는다.
  it("입력이 멈춘 뒤 맞추기까지 0.3초다", () => {
    expect(EXPRESSION_SUGGEST_DEBOUNCE_MS).toBe(300);
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
  it("짧은 글은 글 전체도 맞추고(8자 경계), 긴 글은 낱말마다 맞춘다", () => {
    const eight = made(21, "eight_chars", "오늘도수고했어요", ["토닥", "응원", "고생", "퇴근", "칭찬"]);
    const nine = made(22, "nine_chars", "오늘도수고많았어요", ["토닥", "응원", "고생", "퇴근", "칭찬"]);
    expect(Array.from(normalizeKeyword("오늘도 수고 했어요"))).toHaveLength(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX);
    expect(Array.from(normalizeKeyword("오늘도 수고 많았어요"))).toHaveLength(EXPRESSION_SUGGEST_WHOLE_TEXT_MAX + 1);
    expect(ids(suggestExpressions("오늘도 수고 했어요", [eight, nine]))).toEqual([eight.id]);
    expect(suggestExpressions("오늘도 수고 많았어요", [eight, nine])).toEqual([]);
    expect(ids(suggestExpressions("킹 받네", CATALOG))).toEqual([KING.id]);
    // 문구 안의 낱말도 맞춘다(#5588): 점심은 마지막 낱말도 글 전체도 아니지만 꼬리표다. 같은 그림이 두 낱말(점심·배고파)에 맞아도 한 번이다.
    expect(ids(suggestExpressions("오늘 점심 뭐 먹지", CATALOG))).toEqual([HUNGRY.id]);
    expect(ids(suggestExpressions("오늘 점심 뭐 먹지 하 배고파", CATALOG))).toEqual([HUNGRY.id]);
  });
  it("맞는 것이 없거나 비었거나 꺼 둔 낱말이면 빈 배열이고, 최근·즐겨찾기는 맞지 않는 것을 들이지 않는다", () => {
    for (const text of ["오늘 저녁 뭐 먹지", "안녕하세요", "", "   ", "...", "ㅡㅡ"]) expect(suggestExpressions(text, CATALOG), text).toEqual([]);
    expect(suggestExpressions("오늘 저녁 뭐 먹지", CATALOG, { recent: [LAUGH.id, SIGH.id], favorites: [KING.id] })).toEqual([]);
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
    expect(suggestionKeywords("ㅋㅋ ㅎㅎ")).toEqual(["ㅋㅋ", "ㅎㅎ", "ㅋㅋㅎㅎ"]);
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

// #5588 (owner 2026-11-09): 「여러 키워드에 걸릴 경우엔 관련한 이모티콘들을 한꺼번에 보여주면 좋겠어. e.g. ㅋㅋ 개웃기네 진심 → ㅋㅋ 진심 합쳐서 보여주기」.
// 낱말이 나온 차례로 묶고, 여러 낱말이 그림을 내면 낱말마다 1~2개, 줄 전체는 5개. 하나뿐이면 5개까지 채운다(위 「ㅋㅋ」 7개 → 5개 그대로).
describe("여러 낱말: 낱말이 나온 차례로 묶고 낱말마다 1~2개, 줄 전체 5개", () => {
  const laugh = (n: number) => made(100 + n, `k${n}`, `웃음${n}`, ["ㅋㅋ"]);
  const sincere = (n: number) => made(110 + n, `s${n}`, `진심${n}`, ["진심"]);
  const tired = (n: number) => made(120 + n, `t${n}`, `지침${n}`, ["피곤"]);
  const sleepy = (n: number) => made(130 + n, `z${n}`, `잠${n}`, ["졸림"]);
  const wow = (n: number) => made(140 + n, `w${n}`, `와${n}`, ["대박"]);
  const yum = (n: number) => made(150 + n, `y${n}`, `냠${n}`, ["맛있다"]);
  const three = <T>(make: (n: number) => T) => [make(1), make(2), make(3)];
  const K = three(laugh);
  const S = three(sincere);
  const T = three(tired);
  const Z = three(sleepy);
  const W = three(wow);
  const Y = three(yum);
  const ALL = [...Y, ...W, ...Z, ...T, ...S, ...K];

  it("「ㅋㅋ 개웃기네 진심」 → ㅋㅋ 쪽 둘 다음 진심 쪽 둘(맞는 것이 없는 「개웃기네」는 자리를 먹지 않는다)", () => {
    expect(EXPRESSION_SUGGEST_PER_KEYWORD).toBe(2);
    expect(ids(suggestExpressions("ㅋㅋ 개웃기네 진심", ALL))).toEqual(ids([K[0], K[1], S[0], S[1]]));
    // 차례는 글의 차례다: 낱말을 바꿔 치면 묶음도 바뀐다.
    expect(ids(suggestExpressions("진심 개웃기네 ㅋㅋㅋㅋ", ALL))).toEqual(ids([S[0], S[1], K[0], K[1]]));
  });

  it("낱말 셋은 2·2·1, 넷은 2·1·1·1, 다섯은 1씩 - 앞 낱말부터 하나씩 돌고 남는 자리에 둘째를 세운다", () => {
    expect(ids(suggestExpressions("ㅋㅋ 진심 피곤", ALL))).toEqual(ids([K[0], K[1], S[0], S[1], T[0]]));
    expect(ids(suggestExpressions("ㅋㅋ 진심 피곤 졸림", ALL))).toEqual(ids([K[0], K[1], S[0], T[0], Z[0]]));
    expect(ids(suggestExpressions("ㅋㅋ 진심 피곤 졸림 대박", ALL))).toEqual(ids([K[0], S[0], T[0], Z[0], W[0]]));
    // 여섯째 낱말은 자리가 없다(줄 전체 5개).
    expect(ids(suggestExpressions("ㅋㅋ 진심 피곤 졸림 대박 맛있다", ALL))).toEqual(ids([K[0], S[0], T[0], Z[0], W[0]]));
    expect(EXPRESSION_SUGGEST_LIMIT).toBe(5);
  });

  it("낱말 하나에 그림이 하나뿐이어도 다른 낱말이 그 자리를 더 갖지 않는다(낱말마다 최대 2개)", () => {
    expect(ids(suggestExpressions("ㅋㅋ 진심", [...K, S[0]]))).toEqual(ids([K[0], K[1], S[0]]));
  });

  it("같은 그림은 한 번: 앞 낱말이 세운 그림은 뒤 낱말의 몫을 먹지 않고, 뒤 낱말이 새 그림을 못 내면 앞 낱말로 5개까지 채운다", () => {
    const both = made(160, "a_both", "둘다", ["ㅋㅋ", "진심"]);
    // ㅋㅋ: both(이름순 맨 앞) → k1. 진심: both 는 이미 섰으니 건너뛰고 s1 → s2. 줄에 both 는 한 번.
    const row = suggestExpressions("ㅋㅋ 진심", [...S, both, ...K]);
    expect(ids(row)).toEqual(ids([both, K[0], S[0], S[1]]));
    expect(new Set(ids(row)).size).toBe(row.length);
    // 「ㅋㅋ 웃음」: 웃음 쪽 그림이 ㅋㅋ 쪽에 이미 다 섰다 → 그림을 낸 낱말은 ㅋㅋ 하나 → 다섯까지 채운다(낱말을 하나 더 쳤다고 줄이 줄지 않는다).
    const many = Array.from({ length: 6 }, (_, index) => made(170 + index, `m${index}`, `많음${index}`, index === 0 ? ["ㅋㅋ", "웃음"] : ["ㅋㅋ"]));
    expect(suggestExpressions("ㅋㅋ 웃음", many)).toHaveLength(EXPRESSION_SUGGEST_LIMIT);
    expect(ids(suggestExpressions("ㅋㅋ 웃음", many))).toEqual(ids(suggestExpressions("ㅋㅋ", many)));
  });

  it("꺼 둔 낱말은 그 낱말만 뺀다: 「ㅋㅋ」를 꺼도 「ㅋㅋ 진심」은 진심 쪽을 낸다(남은 낱말이 하나면 5개까지)", () => {
    expect(ids(suggestExpressions("ㅋㅋ 진심", ALL, { muted: ["ㅋㅋㅋ"] }))).toEqual(ids(S));
    expect(ids(suggestExpressions("ㅋㅋ 개웃기네 진심", ALL, { muted: ["진심!"] }))).toEqual(ids(K));
    expect(suggestExpressions("ㅋㅋ 진심", ALL, { muted: ["ㅋㅋ", "진심"] })).toEqual([]);
    // 꺼 둔 낱말과 다른 낱말에 함께 맞는 그림은 다른 낱말 쪽으로 선다(그림을 끈 것이 아니라 낱말을 껐다).
    const both = made(160, "a_both", "둘다", ["ㅋㅋ", "진심"]);
    expect(ids(suggestExpressions("ㅋㅋ 진심", [both, ...K], { muted: ["ㅋㅋ"] }))).toEqual([both.id]);
  });

  it("줄의 낱말(줄을 띄울 낱말을 고르는 목록) = 그림에 맞은 낱말 모두: 안 맞은 낱말은 없고, 같은 그림이라 빠졌거나 상한에 밀린 낱말은 있다", () => {
    expect(suggestExpressionRow("ㅋㅋ 개웃기네 진심", ALL).keywords).toEqual(["ㅋㅋ", "진심"]);
    // 낱말은 정리한 꼴이다(졸림 → 졸려, 끝말 정리표).
    expect(suggestExpressionRow("ㅋㅋ 진심 피곤 졸림 대박 맛있다", ALL).keywords).toEqual(["ㅋㅋ", "진심", "피곤", "졸려", "대박", "맛있다"]);
    expect(suggestExpressionRow("킹 받네", CATALOG).keywords).toEqual(["킹받네"]);
    expect(suggestExpressionRow("ㅋㅋ 진심", ALL, { muted: ["ㅋㅋ"] }).keywords).toEqual(["진심"]);
    expect(suggestExpressionRow("오늘 저녁 뭐 먹지", CATALOG)).toEqual({ items: [], keywords: [] });
    // 빈 줄은 부를 때마다 새 값이다(돌려준 배열을 고쳐도 다음 결과가 오염되지 않는다).
    const empty = suggestExpressionRow("", CATALOG);
    empty.items.push(LAUGH);
    empty.keywords.push("ㅋㅋ");
    expect(suggestExpressionRow("", CATALOG)).toEqual({ items: [], keywords: [] });
  });
});

// #5588 (owner 2026-11-09): 「누르면 해당 단어만 넣은 경우엔 이모티콘이 대체하는걸로(채팅없이), 해당 단어를 포함하는 문구의 경우엔 대체하지 않고 이모티콘만 추가하는 형태로」.
describe("isKeywordOnlyInput: 누를 때 글을 바꾸는가(낱말뿐) 더하는가(문구)", () => {
  it("글 전체를 맞추기와 같은 정리로 줄인 꼴이 그 그림의 낱말이면 낱말뿐(바꾸기), 문구면 아니다(더하기)", () => {
    const rows: Array<[string, Expression, "replace" | "add"]> = [
      ["ㅋㅋ", LAUGH, "replace"],
      ["ㅋㅋㅋㅋ!!", LAUGH, "replace"],
      ["  ㅋ ㅋ ㅋ ㅋ  ", LAUGH, "replace"],
      ["ㅋㅋ ㅋㅋ", LAUGH, "replace"],
      ["ㅋㅋㅋ~~ ^^", LAUGH, "replace"],
      ["ㅋㅋㅋ".normalize("NFD"), LAUGH, "replace"],
      ["배고프다", HUNGRY, "replace"], // 끝말 정리표: 배고프다 → 배고파 ← 꼬리표 「배고픔」
      ["빵터짐", LAUGH, "replace"], // 표시 이름으로 맞은 낱말
      ["킹 받네", KING, "replace"], // 글 전체(킹받네)로 맞은 그림
      ["ㅋㅋ 개웃기네 진심", LAUGH, "add"],
      ["ㅋㅋ 진심", LAUGH, "add"],
      ["ㅋㅋ😂", LAUGH, "add"],
      ["오늘 점심 뭐 먹지 하 배고파", HUNGRY, "add"],
      ["하 오늘 길다 한숨", SIGH, "add"],
      // 이 그림의 낱말이 아니면(다른 낱말로 맞은 그림) 낱말뿐인 글이어도 바꾸지 않는다.
      ["한숨", LAUGH, "add"],
      // 비었거나 정리하면 비는 글은 바꿀 낱말이 없다.
      ["", LAUGH, "add"],
      ["!!", LAUGH, "add"],
    ];
    for (const [text, item, want] of rows) expect(isKeywordOnlyInput(text, item) ? "replace" : "add", `${text} → ${item.name}`).toBe(want);
  });
  it("「킹 받네」 줄에서 글 전체로 맞은 그림은 바꾸고, 한 낱말(받네)로만 맞은 그림은 더한다", () => {
    const part = made(180, "part_only", "받네곰", ["받네"]);
    const row = suggestExpressions("킹 받네", [KING, part]);
    expect(ids(row)).toEqual([part.id, KING.id]);
    expect(row.map((item) => isKeywordOnlyInput("킹 받네", item))).toEqual([false, true]);
  });
});

// =============================================================================
// #5602 M1 (owner 2026-11-09 「추천안대로」): 방금 친 낱말이 키워드일 때만 줄이 선다. 시험 이름의 「표 N」은 설계 검토(Fable 11-10) 3절 (a)의 가장자리 표
// 줄 차례다(1 방금 친 낱말 · 2 띄어쓰기 뒤 · 3 글 전체 · 4 문장부호 · 5 가운데 고치기 · 6 지우기 · 7 한글 조합 · 8 보이는 것 · 9 Esc·이번만 닫기 ·
// 10 Esc 뒤 띄어쓰기 · 11 ✕). 「정함」은 표가 열어 둔 곳을 이 칸이 정한 것이다(인계의 planner 확인 목록과 같다).
// =============================================================================
describe("planExpressionSuggest: 방금 친 낱말이 키워드일 때만 (#5602 M1)", () => {
  const SINCERE = made(18, "sincere_dog", "진심멍", ["진심"]);
  const PART = made(19, "part_only", "받네곰", ["받네"]);
  const LIB = [...CATALOG, SINCERE];

  /** 화면 흉내: 쉼마다 `planExpressionSuggest` 를 부르고 닫힘을 다음 부름에 넘긴다. 쉼 사이에 글이 바뀌므로 줄은 쉼마다 새로 선다 → 줄이 선 쉼의 수 = 줄이 선 횟수. */
  function screen(catalog: readonly Expression[] = LIB) {
    let dismissal: ExpressionSuggestTrigger | null = null;
    let current: ExpressionSuggestPlan<Expression> | null = null;
    let shown = 0;
    const muted: string[] = [];
    return {
      pause(text: string, caret?: number | null) {
        current = planExpressionSuggest({ text, caret, dismissal }, catalog, { muted });
        dismissal = current.dismissal;
        if (current.items.length > 0) shown += 1;
        return current;
      },
      /** Esc·폰 「이번만 닫기」: 지금 줄을 띄운 낱말을 닫아 둔다. */
      dismiss() {
        if (current?.trigger) dismissal = current.trigger;
        current = null;
      },
      /** ✕: 지금 줄을 띄운 낱말 하나를 이 대화에서 끈다. */
      mute() {
        if (current?.trigger) muted.push(current.trigger.keyword);
        current = null;
      },
      get shown() {
        return shown;
      },
      get muted() {
        return [...muted];
      },
    };
  }
  const plan = (text: string, caret?: number | null, catalog: readonly Expression[] = LIB) => planExpressionSuggest({ text, caret }, catalog);

  it("확인 숫자: 「ㅋㅋ 개웃기네 진심」을 낱말마다 쉬며 치면(쉼 7번) 줄이 선 횟수 2(옛 규칙 7) - 끝의 줄에는 ㅋㅋ 쪽과 진심 쪽이 함께 있다", () => {
    const pauses = ["ㅋㅋ", "ㅋㅋ 개", "ㅋㅋ 개웃", "ㅋㅋ 개웃기네", "ㅋㅋ 개웃기네 ", "ㅋㅋ 개웃기네 진", "ㅋㅋ 개웃기네 진심"];
    // 옛 규칙(문구 안 어느 낱말이든 맞으면 선다): 7번 다.
    expect(pauses.filter((text) => suggestExpressionRow(text, LIB).items.length > 0)).toHaveLength(7);
    const view = screen();
    const plans = pauses.map((text) => view.pause(text));
    expect(view.shown).toBe(2);
    expect(plans.map((step) => step.items.length > 0)).toEqual([true, false, false, false, false, false, true]);
    expect(ids(plans[6].items)).toEqual(ids([LAUGH, SINCERE]));
    expect(plans[6].trigger).toEqual({ keyword: "진심", wordIndex: 2 });
  });

  it("확인 숫자: 「ㅋㅋ」에서 Esc → 「ㅋㅋㅋ」 0번, 이어서 「ㅋㅋㅋ 진심」 1번(ㅋㅋ 쪽도 함께 선다)", () => {
    const view = screen();
    expect(ids(view.pause("ㅋㅋ").items)).toEqual(ids([LAUGH]));
    view.dismiss();
    const before = view.shown;
    view.pause("ㅋㅋㅋ");
    expect(view.shown - before).toBe(0);
    const after = view.pause("ㅋㅋㅋ 진심");
    expect(view.shown - before).toBe(1);
    expect(ids(after.items)).toEqual(ids([LAUGH, SINCERE]));
    expect(after.dismissal).toBeNull(); // 다른 키워드를 쳐서 풀렸다
  });

  it("표 1 방금 친 낱말 = 캐럿 바로 앞 글자를 품은 띄어쓰기 없는 조각(가운데여도 조각 전체) - 캐럿을 모르면 글 끝이고, 글 밖의 캐럿은 글 안으로 당긴다", () => {
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", 6)).toEqual({ keyword: "ㅋㅋ", wordIndex: 1 });
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", 4)).toEqual({ keyword: "ㅋㅋ", wordIndex: 1 }); // 「오늘 ㅋ|ㅋㅋ」
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", 2)).toEqual({ keyword: "오늘", wordIndex: 0 });
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", 1)).toEqual({ keyword: "오늘", wordIndex: 0 });
    for (const unknown of [undefined, null, Number.NaN, 99]) expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", unknown), String(unknown)).toEqual({ keyword: "ㅋㅋ", wordIndex: 1 });
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", -3)).toBeNull();
    expect(suggestionWordAtCaret("오늘 ㅋㅋㅋ", 0)).toBeNull();
    // 줄: 끝 낱말이 키워드면 캐럿을 몰라도 선다. 앞 낱말만 키워드면 캐럿이 거기 있을 때만.
    expect(plan("오늘 ㅋㅋ", null).trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: 1 });
    expect(plan("ㅋㅋ 오늘 점심 뭐 먹지", null).items).toEqual([]);
    expect(plan("ㅋㅋ 오늘 점심 뭐 먹지", 2).trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: 0 });
  });

  it("표 1 (정함) 캐럿이 띄어쓰기 바로 뒤 낱말 앞이면(「ㅋㅋ |진심」) 붙은 낱말이 없다 - 그 자리에서 방금 친 것은 띄어쓰기다", () => {
    expect(suggestionWordAtCaret("ㅋㅋ 진심", 3)).toBeNull();
    expect(plan("ㅋㅋ 오늘 진심", 6).items).toEqual([]); // 「ㅋㅋ 오늘 |진심」
    expect(plan("ㅋㅋ 오늘 진심", 8).trigger).toEqual({ keyword: "진심", wordIndex: 2 });
  });

  it("표 1 (정함) 정리해서 비는 조각(「!!」·「...」)은 낱말이 아니고 몇째 낱말인지도 세지 않는다", () => {
    expect(suggestionWordAtCaret("ㅋㅋ !! 진심")).toEqual({ keyword: "진심", wordIndex: 1 });
    expect(suggestionWordAtCaret("ㅋㅋ ...")).toBeNull();
    expect(suggestionWordAtCaret("... ㅋㅋ")).toEqual({ keyword: "ㅋㅋ", wordIndex: 0 });
  });

  it("표 2 「ㅋㅋ」 뒤 띄어쓰기: 붙은 낱말이 없어 그 낱말로는 안 서지만, 짧은 글은 글 전체 규칙으로 계속 선다 - 긴 글은 안 선다", () => {
    expect(suggestionWordAtCaret("ㅋㅋ ")).toBeNull();
    expect(plan("ㅋㅋ ").trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: null });
    expect(ids(plan("ㅋㅋ ").items)).toEqual(ids([LAUGH]));
    expect(plan("ㅋㅋ 오늘 점심 뭐 먹지 ").items).toEqual([]); // 정리 뒤 8자를 넘는다
    expect(plan("ㅋㅋ 오늘 ").items).toEqual([]); // 짧아도 글 전체(ㅋㅋ오늘)는 키워드가 아니다
  });

  it("표 3 글 전체 맞춤(정리 뒤 8자 이하, 「킹 받네」)은 캐럿과 무관하게 선다 - 「낱말뿐이면 바꾸기」 길이 살아 있다", () => {
    for (const caret of [0, 1, 2, 4, null]) {
      const step = plan("킹 받네", caret);
      expect(step.trigger, String(caret)).toEqual({ keyword: "킹받네", wordIndex: null });
      expect(ids(step.items), String(caret)).toEqual([KING.id]);
      expect(isKeywordOnlyInput("킹 받네", step.items[0])).toBe(true);
    }
  });

  it("표 3 (정함) 방금 친 낱말과 글 전체가 둘 다 키워드면 방금 친 낱말이 줄을 띄운다(✕·Esc 는 그 낱말에 걸린다)", () => {
    const step = plan("킹 받네", null, [KING, PART]);
    expect(step.trigger).toEqual({ keyword: "받네", wordIndex: 1 });
    expect(ids(step.items)).toEqual([PART.id, KING.id]); // 보이는 것은 맞은 낱말 모두
  });

  it("표 4 문장부호(「ㅋㅋㅋㅋ!!」)는 정리가 지우므로 같은 낱말이다", () => {
    expect(plan("ㅋㅋㅋㅋ!!").trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: 0 });
    expect(plan("진심 ㅋㅋㅋ~~").trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: 1 });
    expect(plan("ㅋㅋ!! 진심?!").trigger).toEqual({ keyword: "진심", wordIndex: 1 });
  });

  it("표 5 글 가운데를 고칠 때는 캐럿이 있는 낱말만 본다 - 끝 낱말이 키워드여도 가운데를 고치는 동안은 안 서고, 가운데 낱말이 키워드면 선다", () => {
    expect(plan("오늘 저녁 ㅋㅋ", 2).items).toEqual([]);
    expect(plan("오늘 저녁 ㅋㅋ", 5).items).toEqual([]);
    const middle = plan("진심 저녁 ㅋㅋ", 2);
    expect(middle.trigger).toEqual({ keyword: "진심", wordIndex: 0 });
    expect(ids(middle.items)).toEqual(ids([SINCERE, LAUGH]));
  });

  it("표 6 지우기(백스페이스): 지운 뒤 캐럿에 붙은 낱말이 키워드면 새로 친 것과 같게 선다", () => {
    const view = screen();
    for (const text of ["오늘 한숨 쉬", "오늘 한숨 "]) expect(view.pause(text).items).toEqual([]);
    expect(view.pause("오늘 한숨").trigger).toEqual({ keyword: "한숨", wordIndex: 1 });
    expect(ids(view.pause("오늘 한숨").items)).toEqual(ids([SIGH]));
  });

  it("표 7 한글 조합 중은 따로 다루지 않는다: 조합 중간 꼴(ㅈ·지·진·진ㅅ·진시)은 키워드가 아니라 줄이 없고, 다 친 낱말(진심)에서 선다 - NFD 로 와도 같다", () => {
    const view = screen();
    const steps = ["ㅋㅋ ㅈ", "ㅋㅋ 지", "ㅋㅋ 진", "ㅋㅋ 진ㅅ", "ㅋㅋ 진시", "ㅋㅋ 진심"].map((text) => view.pause(text).items.length > 0);
    expect(steps).toEqual([false, false, false, false, false, true]);
    expect(plan("ㅋㅋ 진심".normalize("NFD")).trigger).toEqual({ keyword: "진심", wordIndex: 1 });
  });

  it("표 8 뜨면 보이는 것은 문구 안에서 맞은 낱말 모두의 그림이다(지금 `suggestExpressionRow` 그대로)", () => {
    for (const text of ["ㅋㅋ 개웃기네 진심", "진심 개웃기네 ㅋㅋ", "한숨 ㅋㅋ 배고파"]) {
      expect(ids(plan(text).items), text).toEqual(ids(suggestExpressionRow(text, LIB).items));
    }
    expect(ids(plan("한숨 ㅋㅋ 배고파").items)).toEqual(ids([SIGH, LAUGH, HUNGRY]));
  });

  it("표 9 Esc·이번만 닫기는 (낱말, 자리)를 기억한다: 같은 자리의 같은 낱말은 늘려도 닫힌 채, 다른 키워드·다른 자리의 같은 낱말에서 풀린다", () => {
    const view = screen();
    view.pause("ㅋㅋ");
    view.dismiss();
    expect(view.pause("ㅋㅋㅋ").items).toEqual([]);
    expect(view.pause("ㅋㅋㅋㅋ!!").items).toEqual([]);
    // 키워드가 아닌 낱말을 쳐도 풀리지 않는다: 지우고 돌아와도 닫힌 채다.
    expect(view.pause("ㅋㅋㅋ 오").items).toEqual([]);
    expect(view.pause("ㅋㅋㅋ").items).toEqual([]);
    // 같은 낱말이라도 다른 자리면 다른 키워드를 친 것이다.
    const again = view.pause("ㅋㅋㅋ 오늘 ㅋㅋ");
    expect(again.trigger).toEqual({ keyword: "ㅋㅋ", wordIndex: 2 });
    expect(again.dismissal).toBeNull();
    // 풀린 뒤에는 처음 자리로 돌아가도 선다.
    expect(view.pause("ㅋㅋㅋ").items.length).toBeGreaterThan(0);
  });

  it("표 9 보내거나 다 지우면 닫힘이 풀린다(빈 글·띄어쓰기뿐인 글)", () => {
    for (const blank of ["", "   "]) {
      const view = screen();
      view.pause("ㅋㅋ");
      view.dismiss();
      expect(view.pause("ㅋㅋ").items).toEqual([]);
      expect(view.pause(blank)).toEqual({ items: [], trigger: null, dismissal: null });
      expect(view.pause("ㅋㅋ").items.length, JSON.stringify(blank)).toBeGreaterThan(0);
    }
  });

  it("표 9 (정함) 방금 친 낱말이 닫혀 있으면 글 전체 낱말로 내려가지 않는다(「킹 받네」: 받네를 닫으면 킹받네로도 같은 글에 다시 서지 않는다)", () => {
    const view = screen([KING, PART]);
    expect(view.pause("킹 받네").trigger).toEqual({ keyword: "받네", wordIndex: 1 });
    view.dismiss();
    expect(view.pause("킹 받네").items).toEqual([]);
  });

  it("표 10 Esc 뒤 띄어쓰기(「ㅋㅋ 」): 닫힘은 정리한 꼴로 기억해서 글 전체로 맞은 같은 낱말도 닫힌 채다 - (정함) 거꾸로 글 전체에서 닫고 한 낱말로 쳐도 닫힌 채다", () => {
    const view = screen();
    view.pause("ㅋㅋ");
    view.dismiss();
    expect(view.pause("ㅋㅋ ").items).toEqual([]);
    expect(view.pause("ㅋㅋㅋ  ").items).toEqual([]);
    const reverse = screen();
    expect(reverse.pause("킹 받네").trigger).toEqual({ keyword: "킹받네", wordIndex: null });
    reverse.dismiss();
    expect(reverse.pause("킹받네").items).toEqual([]);
    expect(reverse.pause("킹받네 ㅋㅋ").items.length).toBeGreaterThan(0);
  });

  it("표 11 ✕ 는 줄을 띄운 낱말 하나만 끈다: 「ㅋㅋ 개웃기네 진심」에서 끄면 진심만 - 그 뒤 진심은 0번, ㅋㅋ 는 선다(진심 쪽 그림 없이)", () => {
    const view = screen();
    view.pause("ㅋㅋ 개웃기네 진심");
    view.mute();
    expect(view.muted).toEqual(["진심"]);
    const before = view.shown;
    expect(view.pause("진심").items).toEqual([]);
    expect(view.pause("ㅋㅋ 개웃기네 진심!!").items).toEqual([]);
    expect(view.shown - before).toBe(0);
    const laugh = view.pause("진심 ㅋㅋ");
    expect(ids(laugh.items)).toEqual(ids([LAUGH]));
  });

  it("표 11 ✕ 는 글 전체로 맞았으면 그 낱말을 끈다 - (정함) 방금 친 낱말을 껐으면 같은 글이 글 전체 규칙으로 다시 서지 않는다", () => {
    const whole = screen();
    whole.pause("킹 받네");
    whole.mute();
    expect(whole.muted).toEqual(["킹받네"]);
    expect(whole.pause("킹받네").items).toEqual([]);
    const both = screen([KING, PART]);
    both.pause("킹 받네");
    both.mute();
    expect(both.muted).toEqual(["받네"]);
    expect(both.pause("킹 받네").items).toEqual([]);
    expect(both.pause("킹 받네", 1).trigger).toEqual({ keyword: "킹받네", wordIndex: null }); // 캐럿이 「킹」에 있으면 방금 친 낱말은 킹(키워드 아님)이고 글 전체가 선다
  });

  it("돌려준 값은 넘긴 닫힘을 바꾸지 않고, 같은 값을 넣으면 같은 답이다", () => {
    const held = Object.freeze({ keyword: "ㅋㅋ", wordIndex: 0 });
    const first = planExpressionSuggest({ text: "ㅋㅋㅋ", caret: 3, dismissal: held }, LIB);
    const second = planExpressionSuggest({ text: "ㅋㅋㅋ", caret: 3, dismissal: held }, LIB);
    expect(first).toEqual(second);
    expect(first.dismissal).toBe(held);
    expect(held).toEqual({ keyword: "ㅋㅋ", wordIndex: 0 });
  });
});
