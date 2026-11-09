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

  it("줄의 낱말(✕ 가 끄는 것) = 그림에 맞은 낱말 모두: 안 맞은 낱말은 없고, 같은 그림이라 빠졌거나 상한에 밀린 낱말은 있다", () => {
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
