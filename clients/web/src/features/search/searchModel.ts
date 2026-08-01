// =============================================================================
// 메시지 검색의 순수 규칙 (goal B12 H5).
//
// 렌더링 없는 부분을 전부 여기 모은다. 이 클라이언트의 vitest는 jsdom 없이
// 노드에서 돌기 때문에(테스트 47개 전부가 순수 함수 테스트다) 계약을 못으로 박을
// 수 있는 자리가 여기뿐이다.
//
// 규칙의 출처는 서버 두 파일이고 추측이 없다:
//   server-rust/bins/momo-server/src/routes/search.rs
//   server-rust/crates/momo-messaging/src/search.rs
// =============================================================================

/** 서버가 400으로 거절하는 문턱(`q must contain at least 2 characters`). */
export const SEARCH_MIN_CHARS = 2;

/**
 * 서버가 질의를 다듬는 것과 **같은 방식으로** 다듬는다.
 *
 * 서버는 `raw.trim()` 뒤 `chars().count() < 2`를 본다. 유니코드 스칼라 개수이지
 * UTF-16 코드 단위 개수가 아니라서, JS의 `"..".length`로 세면 이모지 한 글자가
 * 두 글자로 세어진다. `Array.from`이 코드포인트로 끊으므로 두 판정이 어긋나지
 * 않는다.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/** 이 질의를 서버에 보내도 되는가. 거짓이면 요청을 만들지 않는다. */
export function isSearchable(raw: string): boolean {
  return Array.from(normalizeQuery(raw)).length >= SEARCH_MIN_CHARS;
}

/**
 * 입력이 짧을 때 사람에게 할 말.
 *
 * 서버의 400 원문("q must contain at least 2 characters")을 그대로 올리지
 * 않는다. 이 코드베이스가 이미 세운 규칙이다(features/routing/capability.ts:
 * "원문이 필요한 사람은 네트워크 탭을 본다").
 */
export const SHORT_QUERY_HINT = `${SEARCH_MIN_CHARS}자 이상 입력하면 찾기 시작합니다.`;

/**
 * 결과가 없을 때 할 말.
 *
 * 검색 범위가 한정적이라는 사실을 **함께** 말한다. 서버 질의는 워크스페이스
 * 전체를 훑지만 `membership` JOIN이 호출자가 떠나지 않은 채널로 결과를 가둔다
 * (momo-messaging/src/search.rs: "a hit can only come from a channel the caller
 * has not left"). 그 사실을 말하지 않으면 사용자는 "그런 말은 오간 적 없다"로
 * 읽고 검색을 그만두는데, 실제로는 자기가 속하지 않은 채널에 있을 수 있다.
 */
export function noResultsCopy(query: string): string {
  return `'${query}'가 들어간 메시지를 찾지 못했습니다.`;
}

export const NO_RESULTS_SCOPE_NOTE =
  "내가 속한 채널의 메시지만 찾습니다. 다른 채널에 있었다면 그 채널에 들어간 뒤 다시 찾아보세요.";

/** 스니펫을 강조 전/일치/강조 후 셋으로 자른 결과. */
export interface SnippetSegments {
  before: string;
  match: string;
  after: string;
}

/**
 * 서버가 준 위치로 스니펫을 세 토막 낸다.
 *
 * 서버의 `matchOffset`은 **문자 기준 0-오프셋**이다(Postgres `strpos`와
 * `substring`이 둘 다 문자 단위로 세고, 서버가 거기서 창 시작 위치를 뺀다).
 * 그래서 JS에서도 코드포인트로 끊어야 한다: `slice`는 UTF-16 코드 단위로 세므로
 * 이모지가 하나라도 앞에 있으면 강조가 한 칸씩 밀린다.
 *
 * 값이 이상하면 강조를 포기하고 원문을 그대로 돌려준다. 강조는 편의이고 본문은
 * 내용이라, 둘 중 하나만 살릴 수 있으면 본문을 살린다. `strpos`가 0을 답하는
 * 경우(ILIKE의 대소문자 접기와 `lower()`가 갈리는 드문 짝) 서버 산술은 -1을
 * 낼 수 있으므로 음수도 그 갈래로 보낸다.
 */
export function snippetSegments(
  snippet: string,
  matchOffset: number,
  query: string
): SnippetSegments {
  const chars = Array.from(snippet);
  const matchLength = Array.from(query).length;
  if (
    !Number.isInteger(matchOffset) ||
    matchOffset < 0 ||
    matchLength <= 0 ||
    matchOffset >= chars.length
  ) {
    return { before: snippet, match: "", after: "" };
  }
  const end = Math.min(matchOffset + matchLength, chars.length);
  return {
    before: chars.slice(0, matchOffset).join(""),
    match: chars.slice(matchOffset, end).join(""),
    after: chars.slice(end).join(""),
  };
}

/**
 * 서버가 스니펫 앞을 잘라냈는가. 잘렸으면 말줄임을 붙여야 조각이 문장 전체인
 * 척하지 않는다.
 *
 * 규칙은 서버 산술에서 그대로 나온다(momo-messaging/src/search.rs):
 *
 *   창 시작    greatest(strpos - 80, 1)
 *   matchOffset = strpos - 창 시작
 *
 * 그래서 일치가 본문 앞쪽 81자 안에 있으면 창은 **1에서 시작하고**(자르지 않았고)
 * `matchOffset`은 `strpos - 1`, 즉 80보다 작다. 일치가 그보다 뒤면 창이 정확히
 * 80자 앞에서 열리므로 `matchOffset`은 **정확히 80**이 된다. 요컨대 80이 곧
 * "앞을 잘랐다"는 신호이고, 그보다 작은 값은 자르지 않았다는 뜻이다.
 *
 * 처음에는 `matchOffset > 0`으로 뒀는데, 그것은 **오늘 틀린 규칙**이었다.
 * "금요일 배포는…"처럼 본문 첫머리에서 일치한 스니펫에도 말줄임이 붙어, 앞에
 * 더 있는 말을 잘라낸 것처럼 보였다. 서버가 창 크기를 바꾸는 날 이 상수도 함께
 * 바꿔야 하지만, 나중에 틀릴까 봐 지금 틀린 답을 고르는 것은 거래가 되지 않는다.
 * 크기를 이름으로 세워 두면 바꿀 자리가 한 곳이라 그 날의 수정도 한 줄이다.
 */
export const SEARCH_SNIPPET_LEAD_CHARS = 80;

export function leadsWithEllipsis(matchOffset: number): boolean {
  return matchOffset >= SEARCH_SNIPPET_LEAD_CHARS;
}

/**
 * 검색 표면이 지금 어떤 상태인가. 화면은 이 하나만 보고 그린다.
 *
 * 상태를 화면에서 조건문으로 조립하면 "로딩이면서 오류"나 "결과 없음이면서
 * 입력 전" 같은 조합이 생기고, 그중 몇은 화면에서만 재현된다.
 */
export type SearchPhase =
  | "idle"
  | "tooShort"
  | "searching"
  | "empty"
  | "results"
  | "error";

export function searchPhase(input: {
  raw: string;
  isFetching: boolean;
  hasError: boolean;
  hitCount: number;
  /** 이 질의로 한 번이라도 답을 받았는가. */
  settled: boolean;
}): SearchPhase {
  const trimmed = normalizeQuery(input.raw);
  if (trimmed === "") return "idle";
  if (!isSearchable(input.raw)) return "tooShort";
  // 오류를 로딩보다 먼저 보지 않는다: 재시도가 날아가는 동안에도 화면은
  // "찾는 중"이어야 하고, 실패는 그 요청이 끝난 뒤에 말한다.
  if (input.isFetching && input.hitCount === 0) return "searching";
  if (input.hasError) return "error";
  if (!input.settled) return "searching";
  return input.hitCount === 0 ? "empty" : "results";
}
