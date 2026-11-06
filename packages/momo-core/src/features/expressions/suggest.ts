import { expressionKindOf } from "./kind";
import type { ExpressionKind, ExpressionStatus } from "./types";

// =============================================================================
// 입력 글로 이모티콘·GIF 추천: 정리·맞추기 함수 (#5454 1단계, owner 2026-11-07).
//
// 글을 치다 잠깐 멈추면 입력창 위에 맞는 큰 그림 몇 개를 띄우는 기능의 **순수 부분**이다. 화면(웹·폰의 추천 줄)은
// 2단계가 이 모듈을 불러 쓴다. 이 파일이 가진 것은 셋이다:
//   1. 정리: `normalizeKeyword` — 입력 글과 보관함의 꼬리표·이름을 같은 꼴로 줄인다.
//   2. 끝말 정리표: `KEYWORD_ENDING_TABLE` — 흔한 끝말 몇 개를 한 낱말로 모은다(배고프다·배고픔 → 배고파).
//   3. 맞추기: `suggestExpressions` — 보관함에서 맞는 큰 그림을 골라 줄 세운다.
//
// 입력한 글은 **기기 밖으로 나가지 않는다**(owner 2026-11-07 결정: 맞추기는 기기 안에서만). 이 모듈은 네트워크·저장소·시계를 만지지
// 않고 받은 값을 바꾸지 않는 순수 함수라, 글을 서버나 Hermes로 보낼 길이 처음부터 없다. 맞추는 상대도 기기에 있는 보관함
// (이름·표시 이름·꼬리표)뿐이다. DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다. 사람이 읽는 문장은 여기 없다(사전이 가진다).
// =============================================================================

/** 한 번에 추천하는 그림 수의 기본값(입력창 위 한 줄에 3~5개). */
export const EXPRESSION_SUGGEST_LIMIT = 5;
/**
 * 입력이 멈춘 뒤 추천을 맞춰 보기까지 기다리는 시간(밀리초, 0.3초). 화면이 쓴다(#5476): 이 값만큼 아무것도 안 치면 줄을 띄우고, 그 안에 한 글자라도 더 치면
 * 줄이 사라지고 기다림이 처음부터 다시 시작한다. 맞추는 함수는 기다리지 않는다: 시계는 화면 몫이다(웹과 폰이 같은 값을 쓰도록 여기 둔다).
 */
export const EXPRESSION_SUGGEST_DEBOUNCE_MS = 300;
/** 정리한 글이 이 글자 수(코드 포인트) 이하면 마지막 낱말뿐 아니라 글 전체도 맞춰 본다. */
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
 * 입력 글이 맞춰 보는 낱말들(모두 `canonicalKeyword` 꼴, 중복 없음, 빈 것 없음).
 * 첫째는 **마지막 낱말**: 띄어쓰기로 나눈 뒤 끝에서부터 정리하면 비지 않는 첫 것(「한숨 ...」의 끝은 「...」가 아니라 「한숨」).
 * 둘째는 **글 전체**: 정리한 글이 `EXPRESSION_SUGGEST_WHOLE_TEXT_MAX`자 이하일 때만(두 낱말짜리 꼬리표·이름을 위해서).
 * 비면 맞출 것이 없다. 2단계 화면의 ✕(이 낱말 추천 끄기)는 첫째 낱말을 `muted`에 넣는다.
 */
export function suggestionKeywords(input: string): string[] {
  const words = input.split(/\s+/u);
  let last = "";
  for (let index = words.length - 1; index >= 0 && last === ""; index--) last = canonicalKeyword(words[index]);
  const keywords = last === "" ? [] : [last];
  const whole = normalizeKeyword(input);
  if (whole !== "" && codePointLength(whole) <= EXPRESSION_SUGGEST_WHOLE_TEXT_MAX) {
    const wholeKeyword = foldEnding(whole);
    if (wholeKeyword !== last) keywords.push(wholeKeyword);
  }
  return keywords;
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
  /** 추천을 꺼 둔 낱말. 친 그대로 넣어도 된다(같은 정리를 거쳐 비교한다). 입력의 마지막 낱말이나 글 전체가 여기 있으면 빈 결과다. */
  muted?: readonly string[];
  /** 최대 개수. 기본 `EXPRESSION_SUGGEST_LIMIT`(5). 1보다 작으면 빈 결과. */
  limit?: number;
}

/** 꼬리표가 정확히 맞은 것. */
const TIER_TAG = 0;
/** 이름·표시 이름이 정확히 맞은 것(꼬리표는 안 맞음). */
const TIER_NAME = 1;

/** 맞은 칸(없으면 null). 정확히 같을 때만 맞는다 — 부분 일치는 글을 치는 도중 아무 때나 줄을 띄운다. */
function matchTier(item: ExpressionSuggestCandidate, wanted: ReadonlySet<string>): number | null {
  if (item.tags.some((tag) => wanted.has(canonicalKeyword(tag)))) return TIER_TAG;
  if (wanted.has(canonicalKeyword(item.name)) || wanted.has(canonicalKeyword(item.displayName))) return TIER_NAME;
  return null;
}

/**
 * 입력 글에 맞는 큰 이모티콘·GIF를 줄 세워 돌려준다(보관함의 항목 그대로, 같은 항목은 한 번).
 *
 * - 맞추는 말: `suggestionKeywords(input)` — 마지막 낱말, 그리고 짧은 글이면 글 전체. 정확히 같을 때만 맞는다.
 * - 대상: 큰 이모티콘과 GIF만. 작은 이모지 종류(`expressionKindOf` = emoji)와 active가 아닌 항목은 뺀다.
 * - 순서: 꼬리표 정확히 맞음 → 이름·표시 이름 맞음. 같은 칸 안에서는 최근 쓴 것(`recent` 앞 순서) → 즐겨찾기 → 이름·id 순
 *   (보관함이 어떤 차례로 와도 같은 결과). **`recent`·`favorites`는 순서만 바꾼다 — 맞지 않는 항목을 채워 넣지 않는다.**
 * - 맞는 것이 없거나, 글이 비었거나, 꺼 둔 낱말(`muted`)이면 빈 배열이다.
 * 값을 바꾸지 않는 순수 함수다. 네트워크·저장소를 쓰지 않는다.
 */
export function suggestExpressions<T extends ExpressionSuggestCandidate>(
  input: string,
  catalog: readonly T[],
  options: ExpressionSuggestOptions = {},
): T[] {
  const limit = options.limit ?? EXPRESSION_SUGGEST_LIMIT;
  if (!(limit >= 1)) return [];
  const keywords = suggestionKeywords(input);
  if (keywords.length === 0) return [];
  const muted = new Set((options.muted ?? []).map(canonicalKeyword));
  if (keywords.some((keyword) => muted.has(keyword))) return [];

  const wanted = new Set(keywords);
  const recentAt = new Map<string, number>();
  (options.recent ?? []).forEach((id, index) => {
    if (!recentAt.has(id)) recentAt.set(id, index);
  });
  const favorites = new Set(options.favorites ?? []);

  const seen = new Set<string>();
  const hits: Array<{ item: T; tier: number; recent: number; favorite: boolean }> = [];
  for (const item of catalog) {
    if (seen.has(item.id)) continue;
    if (expressionKindOf(item) === "emoji") continue;
    if (item.status !== undefined && item.status !== "active") continue;
    const tier = matchTier(item, wanted);
    if (tier === null) continue;
    seen.add(item.id);
    hits.push({ item, tier, recent: recentAt.get(item.id) ?? Number.MAX_SAFE_INTEGER, favorite: favorites.has(item.id) });
  }
  return hits
    .sort((a, b) => a.tier - b.tier || a.recent - b.recent || Number(b.favorite) - Number(a.favorite) ||
      a.item.name.localeCompare(b.item.name, "en") || a.item.id.localeCompare(b.item.id, "en"))
    .slice(0, limit)
    .map((hit) => hit.item);
}
