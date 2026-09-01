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

import { ApiError } from "../../lib/api";
import { attachParticle } from "../../lib/koreanParticle";
import type { FilterTabsSpec } from "../common/filterTabs";

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

// ---- 검색 범위 (BT-3 / #1931) ------------------------------------------------
//
// 서버가 `channel=<uuid>`를 받는다. 없으면 지금까지의 워크스페이스 검색이고,
// 있으면 그 채널 하나만 훑는다(비멤버·비존재 채널은 404). 계약 원문:
//   server-rust/bins/momo-server/src/routes/search.rs
//
// 여기 있는 것은 **어휘와 규칙**뿐이다. 칩을 그리는 일은 웹의 공용 탭 컨트롤이
// 한다(clients/web/src/features/common/FilterTabs.tsx) — 이 표면이 세 번째
// 호출자다.

export type SearchScope = "channel" | "workspace";

/**
 * 칩 순서. 「이 채널에서」가 먼저인 이유는 그것이 채널 문맥에서 들어왔을 때의
 * **기본값**이고, 기본값이 두 번째 칸에 앉아 있으면 사람은 자기가 무엇을 고른
 * 상태인지 매번 읽어서 알아내야 한다.
 */
export const SEARCH_SCOPES: readonly SearchScope[] = ["channel", "workspace"];

/**
 * 채널 문맥에서 들어왔다는 사실 그 자체.
 *
 * `null`이면 채널 칩이 없다 — 사이드바나 주소창으로 곧장 검색에 온 사람에게
 * 「이 채널에서」는 어느 채널도 가리키지 않는 말이고, 누를 수 없는 칩은 화면에
 * 있을 이유가 없다.
 */
export interface SearchChannelContext {
  channelId: string;
  /**
   * 사람이 그 채널을 부르는 이름 — `channelLabel`이 준 그 한 줄. **아직 모르면
   * `null`이다**(목록이 안 왔거나, 볼 수 없는 채널이거나).
   *
   * 내부 id를 잘라 이름 자리에 넣지 않는다(R1 M-1). 행 메타 셀이 못 푼 id를
   * 잘라 보여 주는 것은 **표의 한 칸**이라 진단으로 읽히지만, 여기 값은 문장과
   * 접근성 이름으로 들어간다 — `019f9c99에서 검색`은 사람에게 아무것도 말하지
   * 않으면서 내부 식별자를 화면에 세운다. 모르면 모른다고 하고, 이름 없는
   * 문장으로 물러난다.
   */
  label: string | null;
  /** DM이면 「채널」이 아니라 「대화」다. */
  isDirect: boolean;
  /**
   * 이 DM의 상대 **사람**의 표시 이름. 디렉터리에서 그 행을 실제로 찾았을
   * 때만 채운다.
   *
   * `label`과 따로 있는 이유가 R1 H-2다: 존칭은 문자열이 아니라 **사람**에게
   * 붙는다. DM의 `label`은 사람 이름이 아닐 수 있고(디렉터리 미도착이면
   * 「다이렉트 메시지」, 동명이인이면 「김민지 @minji」), 거기에 「님」을
   * 기계적으로 붙이면 「다이렉트 메시지님과의 대화」와 「@minji님」이 난다.
   * 사람 행을 찾았을 때만 존칭 문장을 쓰고, 못 찾으면 존칭 없는 문장으로
   * 물러난다.
   */
  peer: string | null;
}

/**
 * 칩에 적히는 말.
 *
 * 채널 **이름**을 칩에 넣지 않는다. 알약 폭이 이름 길이를 따라 출렁이고, 긴
 * 이름은 `#프로젝트-알림-…`처럼 잘려서 어느 채널인지 되레 알 수 없게 된다.
 * 이름이 실제로 도움이 되는 자리는 입력 상자의 안내문과 빈 결과 문구이고,
 * 거기서는 잘리지 않는다 — [`searchPlaceholder`], [`noResultsCopy`].
 */
export function searchScopeLabel(
  scope: SearchScope,
  context: SearchChannelContext | null
): string {
  if (scope === "workspace") return "전체";
  return context?.isDirect ? "이 대화에서" : "이 채널에서";
}

/**
 * 범위 칩 두 개 = 인박스 탭·작업 흐름 필터와 **같은 컨트롤**이다.
 *
 * `role="group"` + `aria-pressed` 버튼 둘을 손으로 만들 수도 있지만, 그 값은
 * 이미 실측됐다(작업 흐름 1R H2): 탭 정거장이 값 개수만큼 늘고, ←/→ 이동이
 * 없어지고, 선택 알약이 그 표면의 다른 배지와 픽셀 단위로 같아진다. 두 번째
 * 구현이 아니라 세 번째 호출자여야 한다.
 */
export function searchScopeTabs(
  context: SearchChannelContext | null
): FilterTabsSpec<SearchScope> {
  return {
    // tablist의 접근성 이름이 「무엇을 고르는 두 버튼인가」를 말한다. 채널
    // 이름은 여기에 실린다 — 칩과 달리 이 문자열은 잘리지 않는다. 이름을
    // 모르면 이름 없이 말한다(R1 M-1): 접근성 이름은 눈으로 읽는 문장보다
    // 내부 식별자를 숨기기 더 쉬운 자리가 아니라, 오히려 확인이 어려운 자리다.
    label:
      context?.label == null ? "검색 범위" : `검색 범위(${context.label})`,
    values: SEARCH_SCOPES,
    labelFor: (scope) => searchScopeLabel(scope, context),
    tabId: (scope) => `search-scope-tab-${scope}`,
    panelId: () => "search-results-panel",
    testId: (scope) => `search-scope-${scope}`,
  };
}

/**
 * 이 범위로 보낼 `channel=` 값. 워크스페이스 범위면 파라미터를 아예 붙이지
 * 않는다(빈 문자열이 아니라 부재다 — 서버는 둘을 같게 읽지만, 부재가 이 요청의
 * 참말이다).
 */
export function scopedChannelId(
  scope: SearchScope,
  context: SearchChannelContext | null
): string | undefined {
  if (scope === "workspace" || context === null) return undefined;
  return context.channelId;
}

/**
 * 채널 문맥을 들고 왔으면 그 채널이 기본, 아니면 전체.
 *
 * 채널에서 ⌘K로 「이 채널에서 검색」을 고른 사람에게 전체 결과를 먼저 보여주면,
 * 그 사람이 방금 고른 것을 화면이 되돌린 것이다.
 */
export function defaultSearchScope(
  context: SearchChannelContext | null
): SearchScope {
  return context === null ? "workspace" : "channel";
}

// ---- 범위는 주소에 산다 (R1 M-2) --------------------------------------------
//
// 1차 판본의 범위는 `useState`였고, 그래서 승격한 뒤의 **주소가 화면과 반대말을
// 했다**: 주소는 `channel=…`인데 화면은 전체 결과였다. 그 상태에서 새로고침하면
// 기본값이 다시 채널을 골라 사람이 방금 내린 결정을 조용히 되돌리고, 그 되돌림은
// 아무 데도 적히지 않는다. 링크를 붙여넣은 동료도 다른 화면을 본다.
//
// 그래서 범위는 상태가 아니라 **주소에서 파생된다** — `?status=`를 그렇게 쓰는
// 작업 흐름 목록과 같은 문법이다(WorkstreamListRoute).
//
// 파라미터가 둘인 이유: 하나로는 승격 상태를 적을 수 없다. `channel=`만 쓰고
// 승격에서 지우면 「#배포에서 왔지만 지금은 전체를 보고 있다」가 주소에 적히지
// 못하고, 그 순간 범위 칩 자체가 사라져 되돌아갈 길이 없어진다 — 두 값을 늘
// 함께 보여 주는 공용 탭 컨트롤(FilterTabs)의 문법과도 어긋난다. 그래서
// `channel=`은 **어느 채널에서 왔는가**(칩의 존재)를, `scope=all`은 **지금 무엇을
// 고른 상태인가**를 적는다.

/** 어느 채널 문맥에서 왔는가. */
export const SEARCH_CHANNEL_PARAM = "channel";
/** 그 문맥 안에서 지금 고른 범위. 부재는 「그 채널」(문맥의 기본값)이다. */
export const SEARCH_SCOPE_PARAM = "scope";
/** `scope=`가 워크스페이스 범위를 뜻할 때의 값. */
export const SEARCH_SCOPE_ALL = "all";

/**
 * 주소가 말하는 범위.
 *
 * 문맥이 없으면 좁힐 대상이 없으므로 `scope=`가 무엇이든 전체다 — 파라미터
 * 하나만 손으로 지운 주소가 「채널 범위인데 채널이 없다」는 상태를 만들 수 없게.
 */
export function parseSearchScope(
  rawScope: string | null,
  context: SearchChannelContext | null
): SearchScope {
  if (context === null) return "workspace";
  return rawScope === SEARCH_SCOPE_ALL ? "workspace" : defaultSearchScope(context);
}

/**
 * 이 범위를 고른 뒤의 검색 파라미터. 호출자가 `setParams`에 그대로 넘긴다.
 *
 * `q`처럼 이 표면이 이미 들고 있는 다른 값은 건드리지 않는다: 범위를 바꾸는 일이
 * 질의를 지우면 승격은 한 번의 누름이 아니게 된다.
 */
export function searchScopeParams(
  current: URLSearchParams,
  scope: SearchScope
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (scope === "workspace") next.set(SEARCH_SCOPE_PARAM, SEARCH_SCOPE_ALL);
  // 기본값은 적지 않는다. `?channel=…` 하나만 든 주소(⌘K가 만드는 그것)와
  // 칩으로 채널을 다시 고른 주소가 같은 문자열이어야, 같은 화면이 같은 링크다.
  else next.delete(SEARCH_SCOPE_PARAM);
  return next;
}

/**
 * 이 검색 요청을 식별하는 캐시 키.
 *
 * **범위가 키의 일부인 것이 커서 초기화의 전부다.** 커서는 자기가 걷던 결과
 * 집합에서만 뜻이 있고(서버가 스코프를 커서에 봉인해 바꿔치기를 400으로 막는다),
 * 범위를 바꾸는 것은 다른 결과 집합으로 옮겨 가는 일이다. 키가 같으면 tanstack이
 * 이전 범위의 페이지와 커서를 그대로 들고 있다가 다음 「더 보기」에 그 커서를
 * 실어 보내고, 서버는 400으로 답한다 — 사람 눈에는 범위를 바꿨더니 검색이
 * 고장 난 것으로 보인다. 키를 갈면 페이지도 커서도 함께 버려진다.
 *
 * 워크스페이스 id를 소문자로 눕히는 것은 기존 규칙 그대로다(대소문자만 다른 두
 * 문자열이 같은 워크스페이스의 캐시를 둘로 쪼개지 않게).
 */
export function searchQueryKey(
  workspaceId: string,
  query: string,
  channelId: string | undefined
): readonly unknown[] {
  return [
    "message-search",
    workspaceId.toLowerCase(),
    query,
    // `undefined`가 아니라 `null`이다: tanstack의 키 직렬화는 `undefined`를
    // 가진 자리를 지우므로, 그러면 워크스페이스 범위 키와 3원소 옛 키가 같아진다.
    channelId === undefined ? null : channelId.toLowerCase(),
  ];
}

/**
 * ⌘K 팔레트의 검색 줄에 적히는 말 (R1 N-1).
 *
 * 두 줄이 **한 함수**에서 나온다. 1차 판본은 전체 줄이 「'배포' 메시지 검색」,
 * 채널 줄이 「이 채널에서 '배포' 찾기」라, 같은 그룹에 나란히 선 두 줄이 같은
 * 행동을 다른 동사로 불렀고 채널 줄은 상태에 따라 동사가 또 바뀌었다. 표면
 * 이름이 한 줄에서 온다고 못 박아 둔 이 파일의 규율(#1146 N4)과 결이 다르다.
 *
 * 범위 이름은 [`searchScopeLabel`]에서 든다 — 팔레트가 「이 채널에서」라 하고
 * 도착한 표면의 칩이 다른 말을 하면 사람은 자기가 고른 것이 반영됐는지 매번
 * 대조해야 한다. 「에서」는 받침으로 갈리지 않아 조사 판정이 필요 없다.
 *
 * 표면 이름(「메시지 검색」)은 여기 없다. 그것은 그룹 머리글이 한 번 말한다.
 */
export function searchEntryLabel(
  scope: SearchScope,
  context: SearchChannelContext | null,
  query: string
): string {
  const named = searchScopeLabel(scope, context);
  const where = scope === "workspace" ? `${named}에서` : named;
  const trimmed = normalizeQuery(query);
  // 팔레트 줄에도 문단이 붙여넣기될 수 있다. 빈 결과 문구와 같은 자로 자른다.
  return trimmed === ""
    ? `${where} 검색`
    : `${where} '${clampQueryForCopy(trimmed)}' 검색`;
}

/**
 * 이 검색으로 데려가는 주소.
 *
 * 팔레트가 `/search?q=…`를 손으로 이어 붙이고 있었고, 범위가 생기면서 그 조립이
 * 두 곳이 됐다(전체용 하나, 채널용 하나). 두 곳이 되는 순간 한쪽만 이스케이프를
 * 잊는 일이 가능해지므로, 조립은 여기 한 번만 있다.
 */
export function searchRoutePath(query: string, channelId?: string): string {
  const params = new URLSearchParams();
  const trimmed = normalizeQuery(query);
  if (trimmed !== "") params.set("q", trimmed);
  if (channelId !== undefined) params.set(SEARCH_CHANNEL_PARAM, channelId);
  const suffix = params.toString();
  return suffix === "" ? "/search" : `/search?${suffix}`;
}

/**
 * 지금 보고 있는 채널의 id — 없으면 `null`.
 *
 * 검색 어휘에 이 함수가 사는 이유는 그것을 묻는 곳이 여기뿐이기 때문이다:
 * 「이 채널에서 검색」이 **어느 채널을** 뜻하는지는 주소가 답한다. 팔레트가
 * `pathname.split("/")`을 직접 하면 라우트 모양(`/c/:channelId`)을 아는 곳이
 * 하나 늘고, 그 하나는 라우트가 바뀌는 날 조용히 틀린다.
 */
export function channelIdInPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((part) => part !== "");
  if (segments.length !== 2 || segments[0] !== "c") return null;
  const raw = decodeURIComponent(segments[1]);
  return raw === "" ? null : raw;
}

/** 이 범위가 실제로 좁히고 있는 채널, 아니면 `null`. */
function narrowedTo(
  scope: SearchScope,
  context: SearchChannelContext | null
): SearchChannelContext | null {
  return scopedChannelId(scope, context) === undefined ? null : context;
}

/**
 * 좁힌 범위를 사람이 부르는 이름 — 조사 없이, 이름만.
 *
 * 세 갈래이고 순서가 규칙이다(R1 H-2 / M-1):
 *   1. DM이고 상대 **사람**을 찾았다 → `김인턴님` (존칭은 여기서만 붙는다)
 *   2. 이름은 아는데 사람은 아니다(공개/비공개 채널, 또는 상대를 못 찾은 DM의
 *      채널 이름) → 그 이름 그대로
 *   3. 이름을 모른다 → `null`. 부르는 이가 문장을 이름 없이 짓는다.
 */
export function scopeChannelName(
  scope: SearchScope,
  context: SearchChannelContext | null
): string | null {
  const target = narrowedTo(scope, context);
  if (target === null) return null;
  if (target.isDirect) return target.peer === null ? null : `${target.peer}님`;
  return target.label;
}

/**
 * 입력 상자의 안내문. 범위를 문장으로 한 번 더 말한다.
 *
 * 이 자리는 **질의가 비었을 때만** 보인다. 그래서 이것 하나로는 「어느 채널을
 * 찾고 있는가」를 답할 수 없고(빈손 화면은 정의상 질의가 있는 화면이다),
 * [`noResultsCopy`]가 그 답을 함께 진다 — R1 H-1이 짚은 자리다.
 */
export function searchPlaceholder(
  scope: SearchScope,
  context: SearchChannelContext | null
): string {
  const target = narrowedTo(scope, context);
  if (target === null) return "메시지 내용으로 검색";
  const named = scopeChannelName(scope, context);
  if (named === null) {
    // 이름을 모르는 채로 좁혀 있다. 무엇을 좁혔는지는 칩이 말하고 있으므로
    // 안내문은 그 말을 되풀이한다 — 없는 이름을 지어내지 않는다.
    return target.isDirect ? "이 대화에서 검색" : "이 채널에서 검색";
  }
  // 「과/와」는 짝이 갈리는 조사이지만 여기서는 갈리지 않는다: DM의 `named`는
  // 언제나 「…님」으로 끝나고 ㅁ은 받침이라 답이 늘 「과」다. 사람 이름을 그대로
  // 쓰던 판본이었다면 lib/koreanParticle을 불렀어야 한다.
  return target.isDirect
    ? `${named}과의 대화에서 검색`
    : `${named}에서 검색`;
}

/**
 * 결과가 없을 때 할 말.
 *
 * 검색 범위가 한정적이라는 사실을 **함께** 말한다. 서버 질의는 워크스페이스
 * 전체를 훑지만 `membership` JOIN이 호출자가 떠나지 않은 채널로 결과를 가둔다
 * (momo-messaging/src/search.rs: "a hit can only come from a channel the caller
 * has not left"). 그 사실을 말하지 않으면 사용자는 "그런 말은 오간 적 없다"로
 * 읽고 검색을 그만두는데, 실제로는 자기가 속하지 않은 채널에 있을 수 있다.
 */
export function noResultsCopy(
  query: string,
  scope: SearchScope = "workspace",
  context: SearchChannelContext | null = null
): string {
  // 조사는 골라 붙인다. `'…말'가 들어간`은 기계가 독자 앞에서 결정을 거부한
  // 것이고, 그 결정은 마지막으로 **발음되는** 음절만으로 완전히 판정된다.
  // 규칙은 이 레포에 이미 있다(lib/koreanParticle, mac에서 이식·호출처 7곳):
  // 뒤따옴표 같은 문장부호를 발음에서 빼므로 `'배포'가`와 `'로그인'이`가 그대로
  // 나온다. 여기서 두 번째 규칙을 세우면 같은 판정이 두 벌로 갈라진다.
  const quoted = `'${clampQueryForCopy(query)}'`;
  const subject = attachParticle(quoted, "subject");
  // 범위를 좁혀 놓고 「찾지 못했습니다」로만 끝내면, 그 말은 워크스페이스
  // 전체에서 못 찾았다는 뜻으로 읽힌다 — 사람은 검색을 그만두는데 실제로는
  // 옆 채널에 있을 수 있다. **어디서** 못 찾았는지가 이 문장의 절반이다.
  if (scopedChannelId(scope, context) === undefined) {
    return `${subject} 들어간 메시지를 찾지 못했습니다.`;
  }
  // **어느** 채널에서 못 찾았는지를 이 문장이 진다(R1 H-1).
  //
  // 1차 판본은 「이 채널에는」으로만 말했고, 그 화면에는 채널 이름이 어디에도
  // 없었다. 결과가 **있을** 때는 행마다 채널 이름이 붙어 우연히 메워지는데,
  // 정작 어디서 못 찾았는지가 중요한 것은 결과가 **없는** 쪽이다. 안내문
  // (`searchPlaceholder`)은 질의가 있으면 안 보이므로 그 자리를 대신할 수 없다.
  //
  // 이름을 모르면 이름 없이 말한다 — 내부 id를 문장에 세우지 않는다(R1 M-1).
  const named = scopeChannelName(scope, context);
  const where =
    named === null
      ? context?.isDirect
        ? "이 대화에는"
        : "이 채널에는"
      : context?.isDirect
        ? `${named}과의 대화에는`
        : `${named}에는`;
  return `${subject} 들어간 메시지가 ${where} 없습니다.`;
}

/**
 * 좁힌 범위에서 빈손일 때 붙는 안내와, 그 안내가 가리키는 **실제 컨트롤**의 이름.
 *
 * 문구만 두고 컨트롤을 두지 않으면 「전체에서 찾아보세요」는 사람에게 칩을 다시
 * 찾아 누르라는 숙제이고, 이 표면은 방금 그 사람의 질의를 이미 들고 있다. 그래서
 * 승격은 한 번의 누름이다 — 라우트가 이 라벨로 버튼을 세우고 범위만 갈아 끼운다
 * (질의는 그대로 남으므로 다시 칠 필요가 없다).
 */
export const ESCALATE_TO_WORKSPACE_DETAIL =
  "다른 채널에 있었을 수 있습니다. 같은 말로 전체를 찾아볼 수 있습니다.";
export const ESCALATE_TO_WORKSPACE_LABEL = "전체에서 찾기";

// ---- 좁힌 범위에서 서버가 거절했을 때 (R1 B-3) --------------------------------
//
// 서버는 **비멤버·비존재·타 워크스페이스 채널에 모두 404**로 답한다(#1940). 셋을
// 구분할 수 없게 만든 것이 서버 쪽 설계이고(멤버십 오라클 방지), 클라가 할 일은
// 그 하나의 404를 사람 말로 옮기는 것이다.
//
// 왜 이것이 `serverSaysAbsent`로 가면 안 되는가: 그 판정은 `404 | 405 | 501`을
// 「이 서버에 그 기능이 없다」로 읽는다. 그 독법은 표면 전체를 물을 때는 맞지만
// **채널 하나를 물었을 때는 정반대의 거짓말**이 된다 — 서버는 방금 전체 범위로
// 결과를 돌려줬으므로 검색을 제공하고 있고, 없는 것은 그 채널을 볼 자격이다.
// 1차 판본이 그 갈래로 흘러 「이 서버는 아직 메시지 검색을 제공하지 않습니다 /
// 채널을 열어 직접 찾아보세요」를 그렸다. 두 문장 다 틀렸고, 뒤 문장은 하필
// **바로 그 채널을 열 수 없다**는 조건에서 채널을 열라고 한다.

/**
 * 좁힌 범위에서 서버가 「그 채널은 못 본다」고 답했는가.
 *
 * 범위가 채널일 때의 404만 이 갈래다. 워크스페이스 범위의 404는 여전히 표면
 * 미제공 이야기이므로 기존 판정(`serverSaysAbsent`)이 그대로 가져간다.
 */
export function isChannelScopeRefusal(
  error: unknown,
  scope: SearchScope,
  context: SearchChannelContext | null
): boolean {
  if (scopedChannelId(scope, context) === undefined) return false;
  return error instanceof ApiError && error.status === 404;
}

/**
 * 그 거절을 사람에게 옮긴 문장.
 *
 * 이름을 부르지 않는다. 볼 수 없는 채널의 이름을 화면에 세우는 것은 그 자체로
 * 얇은 누설이고(없어진 채널인지 못 들어가는 채널인지도 서버가 일부러 구분해 주지
 * 않는다), 못 푼 id를 대신 세우는 것은 M-1이 막은 그 문장이다.
 */
export function channelScopeRefusalCopy(
  context: SearchChannelContext | null
): { headline: string; detail: string } {
  const what = context?.isDirect ? "이 대화의" : "이 채널의";
  return {
    // 「을/를」을 피해 「…의 메시지는」으로 짓는다. 앞말이 「대화」인지
    // 「채널」인지에 따라 조사가 갈리지 않는 형태여야 이 문장이 두 갈래에서
    // 같은 규칙으로 선다.
    headline: `${what} 메시지는 찾을 수 없습니다.`,
    // 세 가지 이유가 하나의 404로 온다. 어느 것인지 모르면서 하나를 고르면
    // 화면이 서버가 하지 않은 말을 하게 되므로, 셋을 셋으로 말한다.
    detail:
      "나갔거나, 없어졌거나, 처음부터 볼 수 없는 곳입니다. 같은 말로 전체를 찾아볼 수 있습니다.",
  };
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
