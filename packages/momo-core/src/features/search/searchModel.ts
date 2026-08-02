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

import { attachParticle } from "../../lib/koreanParticle";

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
  // 조사는 골라 붙인다. `'…말'가 들어간`은 기계가 독자 앞에서 결정을 거부한
  // 것이고, 그 결정은 마지막으로 **발음되는** 음절만으로 완전히 판정된다.
  // 규칙은 이 레포에 이미 있다(lib/koreanParticle, mac에서 이식·호출처 7곳):
  // 뒤따옴표 같은 문장부호를 발음에서 빼므로 `'배포'가`와 `'로그인'이`가 그대로
  // 나온다. 여기서 두 번째 규칙을 세우면 같은 판정이 두 벌로 갈라진다.
  const quoted = `'${clampQueryForCopy(query)}'`;
  return `${attachParticle(quoted, "subject")} 들어간 메시지를 찾지 못했습니다.`;
}

/**
 * 문구에 실을 질의의 최대 길이.
 *
 * 검색창에는 문단도 붙여넣을 수 있고, 그것이 그대로 헤드라인이 되면 빈 상태가
 * 화면을 덮는다. 사람이 "내가 방금 무엇을 찾았지"를 알아보는 데 필요한 만큼만
 * 남긴다.
 */
export const QUERY_COPY_MAX_CHARS = 32;

export function clampQueryForCopy(query: string): string {
  // 코드포인트로 센다. 이 파일의 나머지가 그러는 것과 같은 이유이고, `slice`로
  // 자르면 이모지가 반 토막 난 채 문구에 실린다.
  const chars = Array.from(query);
  if (chars.length <= QUERY_COPY_MAX_CHARS) return query;
  return `${chars.slice(0, QUERY_COPY_MAX_CHARS).join("")}…`;
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

// ---- 스니펫이 잘린 쪽 --------------------------------------------------------
//
// 서버는 일치 지점 둘레로 창을 하나 떠 온다(momo-messaging/src/search.rs):
//
//   창 시작  greatest(strpos - 80, 1)
//   창 길이  char_length(q) + 160
//
// 그래서 **양끝이 다 잘릴 수 있다**. 잘린 쪽에는 말줄임을 붙여야 조각이 문장
// 전체인 척하지 않고, 잘리지 않은 쪽에는 붙이면 안 된다. 없는 말을 있다고 하는
// 것도 이 배치가 없애려는 거짓말이다.

/** 창이 일치 지점 앞으로 몇 자를 담는가. */
export const SEARCH_SNIPPET_LEAD_CHARS = 80;
/** 창이 일치 지점 뒤로 몇 자를 더 담는가(`char_length(q) + 160`의 160). */
export const SEARCH_SNIPPET_TRAIL_CHARS = 160;

/**
 * 앞이 잘렸는가.
 *
 * 산술을 그대로 풀면 이렇다.
 *
 *   strpos <= 81  창 시작 = 1        matchOffset = strpos - 1  (0..80)
 *   strpos >= 82  창 시작 = strpos-80 matchOffset = 80
 *
 * 즉 **80은 두 갈래가 겹치는 유일한 값이다**: `strpos`가 정확히 81이면 창은
 * 1에서 열려 아무것도 자르지 않았는데도 offset이 80이고, 82 이상이면 잘랐는데도
 * 80이다. 와이어에는 `strpos`가 없으므로 이 둘은 **구분할 수 없다**.
 *
 * 그래서 규칙은 "80 이상"이고, 그 선택의 대가를 알고 고른다: 틀리는 경우는
 * `strpos == 81` 하나뿐이며 그때 감춰진 글자 수는 **정확히 0**이다. 반대로 이
 * 경계를 제외하면(`> 80`) `strpos >= 82`인 모든 스니펫이 잘린 사실을 숨긴다.
 * 한쪽은 0자를 과장하고 다른 쪽은 임의로 긴 앞부분을 은폐하므로, 고를 것은
 * 분명하다.
 *
 * 처음 판본은 `matchOffset > 0`이었고 그것은 **오늘 틀린 규칙**이었다. "금요일
 * 배포는…"처럼 본문 첫머리에서 일치한 스니펫에도 말줄임이 붙어 앞에 더 있는
 * 말을 잘라낸 것처럼 보였다. 나중에 틀릴까 봐 지금 틀린 답을 고르는 것은 거래가
 * 되지 않는다. 창 크기를 이름으로 세워 뒀으니 서버가 그것을 바꾸는 날의 수정도
 * 한 줄이다.
 */
export function leadsWithEllipsis(matchOffset: number): boolean {
  return matchOffset >= SEARCH_SNIPPET_LEAD_CHARS;
}

/**
 * 뒤가 잘렸는가.
 *
 * 창 길이가 `q + 160`으로 묶여 있으므로, 돌아온 스니펫이 그 상한을 꽉 채웠다면
 * 본문이 창 끝까지 이어졌다는 뜻이다. 앞쪽과 같은 종류의 경계 모호함이 하나
 * 있다(본문이 하필 창 끝에서 정확히 끝난 경우), 그리고 같은 이유로 같은 쪽을
 * 고른다: 틀릴 때 과장되는 양이 0자다.
 */
export function trailsWithEllipsis(snippet: string, query: string): boolean {
  const cap = Array.from(query).length + SEARCH_SNIPPET_TRAIL_CHARS;
  return Array.from(snippet).length >= cap;
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
