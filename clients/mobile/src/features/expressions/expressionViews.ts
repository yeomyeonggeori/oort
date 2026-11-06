import {
  DEFAULT_EXPRESSION_PICKER_TAB,
  EXPRESSION_PICKER_TABS,
  expressionActionOf,
  expressionsForView,
  type ExpressionAction,
  type ExpressionPickerTab,
  type ExpressionView,
} from '@momo/core/features/expressions/kind';
import {searchExpressions} from '@momo/core/features/expressions/search';
import type {Expression} from '@momo/core/features/expressions/types';
import {
  recentExpressions,
  type ExpressionUsage,
} from '@momo/core/features/expressions/usage';

// =============================================================================
// 입력창 표현 시트의 세 탭 (#4942, owner 10-31 → owner 11-05 #5330) — 이모티콘 · 기본 · GIF. 첫 탭의 글자는 owner 11-06(#5427)부터
// 「우리 팀」이다(창 제목이 이미 「이모티콘」이라 탭은 어디서 온 그림인지만 말한다). 아래의 「이모티콘」은 그 탭이 보이는 **보기·종류의 이름**(탭 id `emoticon`)이다.
//
// ## 사용자에게 보이는 이름은 「이모티콘」 하나다 (owner 2026-11-05)
//
// 앞 판은 네 탭(이모티콘 · 이모지 · 팀 이모지 · GIF)이었고, 「이모지」와 「팀 이모지」가 「이모티콘」과 겹쳐 읽혔다. 지금은 셋이다:
//
//   이모티콘 = 팀 보관함의 작은 것(`kind = emoji`, 움직여도)과 큰 것(`kind = sticker` 이고 움직이지 않는 것) **한 탭**
//   기본     = 표준 그림 문자 목록(`EmojiPicker` 본문) · 눌러 입력칸에 넣는다. **보관함의 등록은 보이지 않는다**
//   GIF      = `kind = sticker` **이고** 움직이는 것(큰 그림이 GIF) · 큰 타일 · 눌러 큰 그림을 미리 본 뒤 대화로 보낸다
//
// 합친 것은 **화면뿐**이다. 서버 `kind` 값(`emoji`·`sticker`)·API 이름·ADR-0218 §10 J2의 네 칸(코어 `expressionShelfOf`)은 그대로다:
// 보관함의 모든 활성 등록은 여전히 정확히 한 칸에 서고, 그 칸이 **고른 뒤의 동작**을 정한다 — 작은 것(팀 이모지 칸)은 `:이름:` 을
// 입력칸에 넣고(글 사이 = inline), 큰 것(이모티콘·GIF 칸)은 미리 본 뒤 대화로 보낸다(단독 전송 = large). 그래서 동작은 탭이
// 아니라 **등록 하나**가 정한다(`expressionActionOf`) — 이모티콘 탭 안에 두 동작이 함께 있다. 합친 탭의 칸은 모두 같은 큰 칸
// (`tile`)이다: 크기가 다른 칸을 한 격자에 섞으면 줄이 들쭉날쭉해져 한 칸 크기로 맞췄다.
//
// 보기를 합치는 함수는 코어 `expressionsForView` 하나이고 웹 패널도 같은 함수를 쓴다. 폰이 따로 분류를 짓지 않는다. 종류가 없는
// 등록(옛 서버·옛 캐시)은 옛 등록과 같은 `sticker` 로 읽는다(코어 `expressionKindOf`). 종류는 등록하는 순간 정하고(초안 단계의
// 고르기, `ExpressionDraftStep`), 등록 뒤에는 바꿀 수 없다.
// =============================================================================

/**
 * 시트의 세 탭(순서 그대로)과 처음 여는 탭 — 웹 고르개와 같은 코어의 목록이다. 탭 이름 `emoji` 는 표준 그림 문자 목록(「기본」)이다 — 서버 종류
 * `emoji` 와 다른 물건이다. 하는 일(`expressionActionOf`)도 코어 함수 하나다.
 */
export {
  DEFAULT_EXPRESSION_PICKER_TAB as DEFAULT_EXPRESSION_TAB,
  EXPRESSION_PICKER_TABS as EXPRESSION_TABS,
  expressionActionOf,
  type ExpressionAction,
  type ExpressionPickerTab as ExpressionTab,
  type ExpressionView,
};

/** 검색어의 앞뒤 콜론(`:name:`)은 이름 검색으로 읽는다 — 옛 고르개와 같다. */
export function expressionQuery(query: string): string {
  return query.replace(/^:|:$/g, '');
}

/**
 * 한 탭에 보이는 표현의 차례. 탭 밖의 등록은 이름이 맞아도 들이지 않는다(코어 `expressionsForView`, 위 머리말).
 *
 * - 검색어가 있으면 코어 검색의 관련도 차례 그대로다(이름 정확 > 앞부분 > 태그 > 부분·초성, 같으면 많이 쓴 것).
 * - 검색어가 없으면 **최근에 쓴 것이 먼저**(마지막으로 쓴 시각 내림차순), 그 뒤가 코어 검색의 기본 차례다.
 *   코어의 빈 검색은 사용 **횟수** 순이라 최근 순과 다르다 — 그래서 여기서 앞에 모은다.
 */
export function browseExpressions(
  items: readonly Expression[],
  view: ExpressionView,
  query: string,
  usage?: ExpressionUsage,
): Expression[] {
  const q = expressionQuery(query);
  // 웹 패널과 같은 차례(`TeamExpressionsPanel`): 검색 관련도를 먼저 매기고 그 차례 그대로 탭 몫만 남긴다.
  const found = expressionsForView(searchExpressions(items, q, usage), view);
  if (q.trim() !== '' || !usage) return found;
  const byId = new Map(found.map(item => [item.id, item]));
  const recent = recentExpressions(usage, new Set(byId.keys())).flatMap(
    entry => byId.get(entry.id) ?? [],
  );
  const recentIds = new Set(recent.map(item => item.id));
  return [...recent, ...found.filter(item => !recentIds.has(item.id))];
}

/**
 * 입력칸 글 끝에 `:이름:` 을 넣는다: 앞이 글자로 끝나면 한 칸 띄우고(`http://x.com` 뒤에 붙으면 토큰이 주소로 읽힌다 — 코어
 * `tokenizeExpressions` 가 주소는 해석하지 않는다), 뒤에 한 칸을 둬서 이어 쓰는 글이 토큰에 붙지 않게 한다.
 */
export function insertExpressionToken(base: string, token: string): string {
  const gap = base === '' || /\s$/.test(base) ? '' : ' ';
  return `${base}${gap}${token} `;
}
