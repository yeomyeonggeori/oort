import { expressionKindOf } from "./kind";
import type { ExpressionKind, ExpressionStatus } from "./types";

// =============================================================================
// 입력 글로 이모티콘·GIF 추천: 정리·맞추기 함수 (#5454 1단계, owner 2026-11-07).
//
// 글을 치다 잠깐 멈추면 입력창 위에 맞는 큰 그림 몇 개를 띄우는 기능의 **순수 부분**이다. 화면(웹·폰의 추천 줄)은
// 2단계가 이 모듈을 불러 쓴다. 이 파일이 가진 것은 넷이다:
//   1. 정리: `normalizeKeyword` — 입력 글과 보관함의 꼬리표·이름을 같은 꼴로 줄인다.
//   2. 끝말 정리표: `KEYWORD_ENDING_TABLE` — 흔한 끝말 몇 개를 한 낱말로 모은다(배고프다·배고픔 → 배고파).
//   3. 맞추기: `suggestExpressionRow`·`suggestExpressions` — 문구 안의 **모든 낱말**에 맞는 큰 그림을 낱말이 나온 차례로 묶어 한 줄에 세운다
//      (#5588, owner 2026-11-09 「여러 키워드에 걸릴 경우엔 관련한 이모티콘들을 한꺼번에」: 「ㅋㅋ 개웃기네 진심」 → ㅋㅋ 쪽 + 진심 쪽).
//   4. 누를 때: `isKeywordOnlyInput` — 글이 그 낱말뿐이면 글을 그림으로 **바꾸고**, 문구 안의 낱말이면 글을 두고 그림을 **더한다**(#5588).
//
// 입력한 글은 **기기 밖으로 나가지 않는다**(owner 2026-11-07 결정: 맞추기는 기기 안에서만). 이 모듈은 네트워크·저장소·시계를 만지지
// 않고 받은 값을 바꾸지 않는 순수 함수라, 글을 서버나 Hermes로 보낼 길이 처음부터 없다. 맞추는 상대도 기기에 있는 보관함
// (이름·표시 이름·꼬리표)뿐이다. DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다. 사람이 읽는 문장은 여기 없다(사전이 가진다).
// =============================================================================

/** 한 번에 추천하는 그림 수의 기본값(입력창 위 한 줄에 3~5개). 여러 낱말이 걸려도 줄 전체가 이 수를 넘지 않는다. */
export const EXPRESSION_SUGGEST_LIMIT = 5;
/**
 * 여러 낱말이 그림을 낼 때 낱말 하나가 줄에 세우는 그림 수의 상한(#5588). 낱말마다 1개씩 먼저 돌고 남는 자리에 2번째를 세운다(낱말 셋이면 2·2·1,
 * 넷이면 2·1·1·1, 다섯 이상이면 앞의 다섯 낱말이 1개씩). 그림을 낸 낱말이 **하나뿐이면** 이 상한 없이 줄 전체(`EXPRESSION_SUGGEST_LIMIT`)까지 채운다 —
 * 「ㅋㅋ」 하나만 친 줄은 예전처럼 5개다.
 */
export const EXPRESSION_SUGGEST_PER_KEYWORD = 2;
/**
 * 입력이 멈춘 뒤 추천을 맞춰 보기까지 기다리는 시간(밀리초, 0.3초). 화면이 쓴다(#5476): 이 값만큼 아무것도 안 치면 줄을 띄우고, 그 안에 한 글자라도 더 치면
 * 줄이 사라지고 기다림이 처음부터 다시 시작한다. 맞추는 함수는 기다리지 않는다: 시계는 화면 몫이다(웹과 폰이 같은 값을 쓰도록 여기 둔다).
 */
export const EXPRESSION_SUGGEST_DEBOUNCE_MS = 300;
/** 정리한 글이 이 글자 수(코드 포인트) 이하면 낱말마다에 더해 글 전체도 맞춰 본다(두 낱말짜리 꼬리표·이름: 「킹 받네」 → 「킹받네」). */
export const EXPRESSION_SUGGEST_WHOLE_TEXT_MAX = 8;

/**
 * 같은 글자가 3번 이상 이어진 덩이. `u`라서 한 글자는 코드 포인트다(😂😂😂😂도 한 글자의 반복). 한글 낱자(ㅋ·ㅎ·ㅠ)와
 * 음절(아·하), 영문·숫자가 모두 같은 규칙이다. 줄바꿈은 `.`에 안 잡히지만 어차피 아래에서 지워진 뒤 한 번 더 줄인다.
 */
const REPEATED_CHAR = /(.)\1{2,}/gu;
/**
 * 지울 것: 띄어쓰기(전각 공백 포함)와 문장부호, 그리고 채팅에서 문장부호처럼 쓰는 기호(~ ^ + = 따위: 수학 기호 Sm·수정 기호 Sk·통화 기호 Sc).
 * 그림 문자(\p{So})는 지우지 않는다 — 꼬리표가 🎉·👍인 그림이 있고, 지우면 글이 통째로 비어 맞는 것이 사라진다.
 */
const SPACE_OR_PUNCTUATION = /[\s\p{P}\p{Sm}\p{Sk}\p{Sc}]/gu;

const collapseRepeats = (text: string): string => text.replace(REPEATED_CHAR, "$1$1");

/**
 * 맞추기 전에 하는 정리. 순서는 NFC → 반복 줄이기 → 띄어쓰기·문장부호 지우기 → 소문자다.
 * - NFC가 맨 앞인 까닭: macOS 입력은 NFD로 올 수 있고, 분해된 「하하하」는 초성·중성이 번갈아 나열돼 반복으로 보이지 않는다.
 * - 반복 줄이기: 같은 글자가 3번 이상이면 2번으로(ㅋㅋㅋㅋ → ㅋㅋ, ㅠㅠㅠ → ㅠㅠ, 아아아아 → 아아). 2번 이하는 그대로다.
 * - 마지막에 반복 줄이기를 한 번 더 한다. 띄어쓰기를 지우면 떨어져 있던 같은 글자가 붙어(「ㅋ ㅋ ㅋ ㅋ」) 다시 3번 이상이 되기
 *   때문이다. 이 덕에 두 번 정리해도 같은 값이다(멱등) — 정리한 낱말을 다시 정리하는 곳(꺼 둔 낱말 비교)이 어긋나지 않는다.
 * 끝말 정리표는 여기 들어 있지 않다: 이 함수는 글자 꼴만 고치고 낱말을 바꾸지 않는다(`canonicalKeyword`가 표까지 쓴다).
 */
export function normalizeKeyword(text: string): string {
  const withoutRepeats = collapseRepeats(text.normalize("NFC"));
  return collapseRepeats(withoutRepeats.replace(SPACE_OR_PUNCTUATION, "").toLowerCase());
}

/**
 * 끝말 정리표: 정리한 낱말이 이 표의 값 가운데 하나면 키로 바꿔서 맞춘다. 키 = 모은 낱말, 값 = 그 낱말로 모이는 꼴들.
 * - 작게 시작한다. **일반 규칙으로 넓히지 않는다**(「요」를 떼는 식의 끝말 규칙은 틀린 낱말을 만든다) — 한 낱말씩 적는다.
 * - 입력 글과 보관함의 꼬리표·이름 **양쪽에** 적용한다. 꼬리표가 「배고픔」인 그림에 「배고파」·「배고프다」가 모두 맞는다.
 * - 키와 값은 모두 `normalizeKeyword`를 거친 꼴(띄어쓰기·대문자·3번 이상 반복 없음)로 적는다. 아니면 영영 안 맞는다(시험이 잰다).
 * - 꼬리표를 채우는 일은 Hermes가 세트를 제안할 때 한다(#5442). 여기는 입력 쪽의 변형을 모으는 자리다.
 */
export const KEYWORD_ENDING_TABLE: Readonly<Record<string, readonly string[]>> = {
  배고파: ["배고프다", "배고픔", "배고파요", "배고프네"],
  졸려: ["졸리다", "졸림", "졸려요", "졸리네"],
  피곤해: ["피곤하다", "피곤함", "피곤해요", "피곤하네"],
  힘들어: ["힘들다", "힘듦", "힘들어요", "힘드네"],
  슬퍼: ["슬프다", "슬픔", "슬퍼요", "슬프네"],
};

/** 꼴 → 모은 낱말. 보통 객체가 아니라 Map이다: 영어 낱말 `constructor`가 객체의 상속 멤버를 집어 오면 안 된다. */
const CANONICAL_BY_FORM: ReadonlyMap<string, string> = new Map(
  Object.entries(KEYWORD_ENDING_TABLE).flatMap(([canonical, forms]) => forms.map((form) => [form, canonical] as const)),
);

const foldEnding = (normalized: string): string => CANONICAL_BY_FORM.get(normalized) ?? normalized;

/** 정리(`normalizeKeyword`) 뒤 끝말 정리표까지 적용한 꼴. 입력 글·꼬리표·이름·꺼 둔 낱말을 모두 이 꼴로 맞춘다. */
export function canonicalKeyword(text: string): string {
  return foldEnding(normalizeKeyword(text));
}

const codePointLength = (text: string): number => Array.from(text).length;

/**
 * 입력 글이 맞춰 보는 낱말들(모두 `canonicalKeyword` 꼴, 중복 없음, 빈 것 없음). 차례가 줄의 차례다(#5588):
 * 앞은 **띄어쓰기로 나눈 낱말 모두**, 글에 나온 차례대로다(「ㅋㅋ 개웃기네 진심」 → ㅋㅋ, 개웃기네, 진심). 정리해서 비는 조각(「...」)은 빠지고
 * 같은 낱말이 다시 나오면 처음 자리 하나만 남는다.
 * 끝은 **글 전체**: 정리한 글이 `EXPRESSION_SUGGEST_WHOLE_TEXT_MAX`자 이하이고 앞의 낱말과 다를 때만(두 낱말짜리 꼬리표·이름을 위해서).
 * 비면 맞출 것이 없다.
 */
export function suggestionKeywords(input: string): string[] {
  const keywords = new Set<string>();
  for (const word of input.split(/\s+/u)) {
    const keyword = canonicalKeyword(word);
    if (keyword !== "") keywords.add(keyword);
  }
  const whole = normalizeKeyword(input);
  if (whole !== "" && codePointLength(whole) <= EXPRESSION_SUGGEST_WHOLE_TEXT_MAX) keywords.add(foldEnding(whole));
  return [...keywords];
}

/**
 * 맞추는 보관함의 한 항목. `Expression` 그대로 넘기면 된다(미디어는 읽지 않는다). 종류는 `expressionKindOf`가 읽으므로 없는
 * 옛 응답도 큰 그림이다(J6). `status`가 있으면 `active`만 맞춘다 — 지운·숨긴 항목은 보일 그림이 없다.
 */
export interface ExpressionSuggestCandidate {
  id: string;
  name: string;
  displayName: string;
  tags: readonly string[];
  kind?: ExpressionKind;
  status?: ExpressionStatus;
}

export interface ExpressionSuggestOptions {
  /** 최근 쓴 표현의 id, 가장 최근 것이 앞. `recentExpressions(usage).map((entry) => entry.id)`로 만든다. */
  recent?: readonly string[];
  /** 즐겨찾기 표현의 id. */
  favorites?: readonly string[];
  /**
   * 추천을 꺼 둔 낱말. 친 그대로 넣어도 된다(같은 정리를 거쳐 비교한다). 여기 있는 낱말은 맞추지 않는다 — 같은 글의 **다른 낱말은 그대로 맞춘다**
   * (「ㅋㅋ」를 껐어도 「ㅋㅋ 진심」은 진심 쪽 그림을 낸다, #5588). 그림이 꺼 둔 낱말과 다른 낱말에 함께 맞으면 다른 낱말 쪽으로 선다.
   */
  muted?: readonly string[];
  /** 최대 개수. 기본 `EXPRESSION_SUGGEST_LIMIT`(5). 1보다 작으면 빈 결과. */
  limit?: number;
}

/** 꼬리표가 정확히 맞은 것. */
const TIER_TAG = 0;
/** 이름·표시 이름이 정확히 맞은 것(꼬리표는 안 맞음). */
const TIER_NAME = 1;

/**
 * 한 항목이 맞는 꼴들과 그 칸: 꼬리표 꼴은 칸 0, 이름·표시 이름 꼴은 칸 1(같은 꼴이 꼬리표에도 있으면 꼬리표 칸). 맞추기와 누를 때(`isKeywordOnlyInput`)가
 * **같은 이 표**를 읽는다. 정확히 같을 때만 맞는다 — 부분 일치는 글을 치는 도중 아무 때나 줄을 띄운다.
 */
function matchKeys(item: ExpressionSuggestCandidate): Map<string, number> {
  const keys = new Map<string, number>();
  for (const tag of item.tags) keys.set(canonicalKeyword(tag), TIER_TAG);
  for (const name of [item.name, item.displayName]) {
    const key = canonicalKeyword(name);
    if (!keys.has(key)) keys.set(key, TIER_NAME);
  }
  keys.delete("");
  return keys;
}

/** 한 낱말 안의 줄 세우기: 칸 → 최근 쓴 것(`recent` 앞 순서) → 즐겨찾기 → 이름 → id. 보관함이 어떤 차례로 와도 같은 결과다. */
interface Hit<T> {
  item: T;
  tier: number;
  recent: number;
  favorite: boolean;
}
const byRank = <T extends ExpressionSuggestCandidate>(a: Hit<T>, b: Hit<T>): number =>
  a.tier - b.tier || a.recent - b.recent || Number(b.favorite) - Number(a.favorite) ||
  a.item.name.localeCompare(b.item.name, "en") || a.item.id.localeCompare(b.item.id, "en");

/**
 * 낱말별로 줄 세운 그림들(낱말 차례)에서 줄 하나를 고른다. 낱말마다 1개씩 차례로 돌고, 다시 한 바퀴 돌며 2번째를 세운다(`EXPRESSION_SUGGEST_PER_KEYWORD`).
 * 앞 낱말이 이미 세운 그림은 건너뛰고 그 낱말의 몫을 쓰지 않는다(같은 그림은 한 번). 두 바퀴 뒤에 그림을 세운 낱말이 **하나뿐이면** 그 낱말로 상한까지 채운다.
 * 줄의 차례는 낱말 차례로 묶은 것이다(앞 낱말의 그림들 → 다음 낱말의 그림들).
 */
function pickRow<T extends ExpressionSuggestCandidate>(ranked: readonly (readonly T[])[], limit: number): T[] {
  const picked: T[][] = ranked.map(() => []);
  const cursor = ranked.map(() => 0);
  const taken = new Set<string>();
  let total = 0;
  const takeNext = (group: number): boolean => {
    const list = ranked[group];
    while (cursor[group] < list.length && taken.has(list[cursor[group]].id)) cursor[group] += 1;
    if (cursor[group] >= list.length) return false;
    const item = list[cursor[group]];
    cursor[group] += 1;
    taken.add(item.id);
    picked[group].push(item);
    total += 1;
    return true;
  };
  for (let round = 0; round < EXPRESSION_SUGGEST_PER_KEYWORD; round += 1) {
    for (let group = 0; group < ranked.length && total < limit; group += 1) takeNext(group);
  }
  const contributing = picked.flatMap((list, group) => (list.length > 0 ? [group] : []));
  if (contributing.length === 1) while (total < limit && takeNext(contributing[0])) continue;
  return picked.flat();
}

/** 줄 하나: 세울 그림들과, 이 글에서 그림에 맞은 낱말들. */
export interface ExpressionSuggestRow<T> {
  /** 줄에 세울 그림들(보관함의 항목 그대로, 같은 항목은 한 번, 낱말 차례로 묶음). 없으면 빈 배열이다. */
  items: T[];
  /**
   * 이 글에서 그림 하나라도 맞은 낱말들(`suggestionKeywords` 차례, 꺼 둔 낱말은 없다). 줄의 ✕(이 낱말 추천 끄기)가 **이것을** 끈다: 맞지 않은 낱말
   * (「오늘」·「뭐」)까지 끄지 않고, 같은 그림이라 줄에서 빠졌거나 상한에 밀린 낱말까지는 끈다 — 끈 뒤 같은 글에 줄이 다시 서지 않게.
   */
  keywords: string[];
}

/** 빈 줄. 부를 때마다 새 배열이다(돌려준 배열을 호출한 쪽이 고쳐도 다음 결과가 오염되지 않게). */
const noRow = <T>(): ExpressionSuggestRow<T> => ({ items: [], keywords: [] });

/**
 * 입력 글에 맞는 큰 이모티콘·GIF 줄 하나(#5454, 여러 낱말 #5588).
 *
 * - 맞추는 말: `suggestionKeywords(input)` — 문구 안의 낱말 모두(나온 차례), 그리고 짧은 글이면 글 전체. 정확히 같을 때만 맞는다. 꺼 둔 낱말(`muted`)은 뺀다.
 * - 대상: 큰 이모티콘과 GIF만. 작은 이모지 종류(`expressionKindOf` = emoji)와 active가 아닌 항목은 뺀다.
 * - 줄: 낱말이 나온 차례로 묶고, 낱말 하나 안에서는 꼬리표 정확히 맞음 → 이름·표시 이름 맞음, 같은 칸 안에서는 최근 쓴 것(`recent` 앞 순서) → 즐겨찾기 →
 *   이름·id 순이다. 여러 낱말이 그림을 내면 낱말마다 1~2개(`EXPRESSION_SUGGEST_PER_KEYWORD`), 하나뿐이면 상한까지, 줄 전체는 `limit`(기본 5)까지다.
 *   **`recent`·`favorites`는 순서만 바꾼다 — 맞지 않는 항목을 채워 넣지 않는다.**
 * - 맞는 것이 없거나, 글이 비었거나, 낱말이 모두 꺼져 있으면 빈 줄이다.
 * 값을 바꾸지 않는 순수 함수다. 네트워크·저장소를 쓰지 않는다.
 */
export function suggestExpressionRow<T extends ExpressionSuggestCandidate>(
  input: string,
  catalog: readonly T[],
  options: ExpressionSuggestOptions = {},
): ExpressionSuggestRow<T> {
  const limit = Math.floor(options.limit ?? EXPRESSION_SUGGEST_LIMIT);
  if (!(limit >= 1)) return noRow();
  const muted = new Set((options.muted ?? []).map(canonicalKeyword));
  const keywords = suggestionKeywords(input).filter((keyword) => !muted.has(keyword));
  if (keywords.length === 0) return noRow();

  const wanted = new Set(keywords);
  const recentAt = new Map<string, number>();
  (options.recent ?? []).forEach((id, index) => {
    if (!recentAt.has(id)) recentAt.set(id, index);
  });
  const favorites = new Set(options.favorites ?? []);

  const seen = new Set<string>();
  const hitsByKeyword = new Map<string, Array<Hit<T>>>();
  for (const item of catalog) {
    if (seen.has(item.id)) continue;
    if (expressionKindOf(item) === "emoji") continue;
    if (item.status !== undefined && item.status !== "active") continue;
    let matched = false;
    for (const [key, tier] of matchKeys(item)) {
      if (!wanted.has(key)) continue;
      matched = true;
      const hits = hitsByKeyword.get(key) ?? [];
      hits.push({ item, tier, recent: recentAt.get(item.id) ?? Number.MAX_SAFE_INTEGER, favorite: favorites.has(item.id) });
      hitsByKeyword.set(key, hits);
    }
    if (matched) seen.add(item.id);
  }
  const matchedKeywords = keywords.filter((keyword) => hitsByKeyword.has(keyword));
  if (matchedKeywords.length === 0) return noRow();
  const ranked = matchedKeywords.map((keyword) => (hitsByKeyword.get(keyword) ?? []).sort(byRank).map((hit) => hit.item));
  return { items: pickRow(ranked, limit), keywords: matchedKeywords };
}

/** `suggestExpressionRow` 의 그림들만. */
export function suggestExpressions<T extends ExpressionSuggestCandidate>(
  input: string,
  catalog: readonly T[],
  options: ExpressionSuggestOptions = {},
): T[] {
  return suggestExpressionRow(input, catalog, options).items;
}

/**
 * 입력한 글이 **이 그림의 낱말뿐**인가 — 추천 줄의 그림을 눌렀을 때 쓴 글을 바꾸는가 두는가(#5588, owner 2026-11-09 「해당 단어만 넣은 경우엔 이모티콘이
 * 대체하는걸로(채팅없이), 해당 단어를 포함하는 문구의 경우엔 대체하지 않고 이모티콘만 추가하는 형태로」).
 * - 참: 글이 그 낱말뿐이다 → 화면은 글을 지우고 그림만 남긴다(바꾸기). 보내면 글 없이 그림만 간다.
 * - 거짓: 낱말이 문구 안에 있다 → 화면은 글을 그대로 두고 그림을 더한다(글 + 그림을 보내기 한 번에, `sendBundle`).
 * 「뿐」의 기준은 맞추기와 같은 정리다: 글 **전체**를 `canonicalKeyword`(반복 줄이기·띄어쓰기와 문장부호 지우기·끝말 정리표)로 줄인 꼴이 이 그림이 맞는
 * 낱말(꼬리표·이름·표시 이름) 하나와 같으면 낱말뿐이다. 「ㅋㅋㅋㅋ!!」·「ㅋ ㅋ ㅋ」·「배고프다」(꼬리표 배고픔)는 낱말뿐이고, 「ㅋㅋ 진심」·「ㅋㅋ😂」은 문구다.
 * 그림을 기준으로 재는 까닭: 「킹 받네」를 친 줄에서 글 전체(킹받네)로 맞은 그림은 글을 바꾸고, 「받네」 한 낱말로만 맞은 그림은 글에 더한다.
 * 누름이 저절로 보내지는 않는다 — 화면은 고른 그림을 입력창 위 미리 보기에 올리고, 보내기 한 번이 보낸다. (참·거짓으로 답하는 까닭: 화면 코드가 비교할
 * 낱말 문자열을 적지 않게 — 직접 문구 장부는 화면 파일의 영어 낱말 문자열을 문구로 센다.)
 */
export function isKeywordOnlyInput(input: string, item: ExpressionSuggestCandidate): boolean {
  const whole = canonicalKeyword(input);
  return whole !== "" && matchKeys(item).has(whole);
}
