import {orderExpressionsForTab} from '@momo/core/features/expressions/browse';
import {
  DEFAULT_EXPRESSION_PICKER_TAB,
  EXPRESSION_PICKER_TABS,
  expressionActionOf,
  type ExpressionAction,
  type ExpressionPickerTab,
  type ExpressionView,
} from '@momo/core/features/expressions/kind';
import type {Expression} from '@momo/core/features/expressions/types';
import type {ExpressionUsage} from '@momo/core/features/expressions/usage';

// =============================================================================
// 입력창 표현 시트의 세 탭 (#4942 → owner 2026-11-07 #5453) — 이모티콘 · 이모지 · GIF. 우리 팀이 올린 것과 기본을 탭으로 가르지 않는다.
//
//   이모티콘 = 움직이지 않는 큰 그림 · 고르면 크게 미리 보고 「보내기」로 대화에 보낸다
//   이모지   = 표준 그림 문자 목록(`EmojiPicker` 본문) 위에 팀의 작은 이모지 한 줄(`TeamEmojiRow`) · 눌러 입력칸에 넣는다
//   GIF      = 움직이는 큰 그림 · 이모티콘과 같이 미리 보고 보낸다
//
// 분류는 코어의 표 하나(`EXPRESSION_TAB_SHELVES`)이고 웹 고르개도 같은 표를 쓴다. 폰이 따로 칸 묶음을 적지 않는다. 서버 `kind` 값(`emoji`·`sticker`)·API 이름·
// ADR-0218 §10 J2의 네 칸은 그대로다: 보관함의 모든 활성 등록은 정확히 한 칸에 서고(종류가 없는 옛 등록은 `sticker`로 읽는다, 코어 `expressionKindOf`),
// 그 칸이 **고른 뒤의 동작**을 정한다 - 작은 팀 이모지는 `:이름:` 을 입력칸에 넣고(글 사이 = inline), 큰 그림(이모티콘·GIF)은 미리 본 뒤 대화로 보낸다
// (단독 전송 = large). 그래서 동작은 탭이 아니라 **등록 하나**가 정한다(`expressionActionOf`). 종류는 등록하는 순간 정하고(초안 단계의 고르기,
// `ExpressionDraftStep`) 등록 뒤에는 바꿀 수 없다. 「이모지」라는 말은 이 탭의 이름에만 쓴다.
// =============================================================================

/**
 * 시트의 세 탭(순서 그대로)과 처음 여는 탭 — 웹 고르개와 같은 코어의 목록이다. 탭 이름 `emoji` 는 표준 그림 문자 목록에 팀의 작은 이모지를 더한 탭이다
 * (서버 종류 `emoji` 와 같은 말이 아니다: 팀의 작은 이모지는 이 탭에 서고, 표준 그림 문자는 보관함의 등록이 아니다). 하는 일(`expressionActionOf`)도 코어 함수 하나다.
 */
export {
  DEFAULT_EXPRESSION_PICKER_TAB as DEFAULT_EXPRESSION_TAB,
  EXPRESSION_PICKER_TABS as EXPRESSION_TABS,
  expressionActionOf,
  type ExpressionAction,
  type ExpressionPickerTab as ExpressionTab,
  type ExpressionView,
};

/**
 * 한 탭에 보이는 표현의 차례(코어 `orderExpressionsForTab`, 웹 고르개와 같은 함수). 탭 밖의 등록은 이름이 맞아도 들이지 않는다.
 *
 * - 검색어(앞뒤 콜론 `:name:` 은 이름 검색으로 읽는다)가 있으면 코어 검색의 관련도 차례 그대로다(이름 정확 > 앞부분 > 태그 > 부분·초성, 같으면 많이 쓴 것).
 * - 검색어가 없으면 **최근에 쓴 것이 먼저**(마지막으로 쓴 시각 내림차순), 그 뒤가 코어 검색의 기본 차례다.
 *   코어 검색의 빈 검색은 사용 **횟수** 순이라 최근 순과 다르다 - 그래서 코어가 앞에 모은다.
 */
export function browseExpressions(
  items: readonly Expression[],
  tab: ExpressionPickerTab,
  query: string,
  usage?: ExpressionUsage,
): Expression[] {
  return orderExpressionsForTab(items, tab, {query, usage});
}

/**
 * 입력칸 글 끝에 `:이름:` 을 넣는다: 앞이 글자로 끝나면 한 칸 띄우고(`http://x.com` 뒤에 붙으면 토큰이 주소로 읽힌다 — 코어
 * `tokenizeExpressions` 가 주소는 해석하지 않는다), 뒤에 한 칸을 둬서 이어 쓰는 글이 토큰에 붙지 않게 한다.
 */
export function insertExpressionToken(base: string, token: string): string {
  const gap = base === '' || /\s$/.test(base) ? '' : ' ';
  return `${base}${gap}${token} `;
}
