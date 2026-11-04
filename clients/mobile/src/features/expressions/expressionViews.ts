import {
  EXPRESSION_TABS,
  expressionsForTab,
  type ExpressionShelf,
  type ExpressionTab,
} from '@momo/core/features/expressions/kind';
import {searchExpressions} from '@momo/core/features/expressions/search';
import type {Expression} from '@momo/core/features/expressions/types';
import {
  recentExpressions,
  type ExpressionUsage,
} from '@momo/core/features/expressions/usage';

// =============================================================================
// 입력창 표현 시트의 네 탭 (#4942, owner 10-31) — 이모티콘 · 이모지 · 팀 이모지 · GIF.
//
// ## 네 탭이 서로 다른 것을 보이는 기준 (ADR-0218 증보 4 §10 J2, #4961·#5112)
//
// 등록마다 종류 값(`kind`: `emoji` 작은 팀 이모지 · `sticker` 큰 이모티콘)이 있고, 보관함의 모든 활성 등록은 아래 세 칸 가운데
// **정확히 한 곳**에 선다(합집합 = 전체, 서로 겹치지 않는다). 나누는 함수는 코어 `expressionsForTab` 이고 폰도 웹 패널도 그 함수
// 하나를 쓴다 — 탭 값(`EXPRESSION_TABS`)도 코어의 것이다. 폰이 따로 분류를 짓지 않는다:
//
//   이모티콘  = `kind = sticker` **이고** 움직이지 않는 것 · 큰 타일 · 눌러 큰 그림을 미리 본 뒤 **대화로 보낸다**(단독 전송 = large)
//   팀 이모지 = `kind = emoji`(움직여도) · 작은 칸 · 눌러 `:이름:` 을 **입력칸에 넣는다**(글 사이 = inline)
//   GIF       = `kind = sticker` **이고** 움직이는 것(큰 그림이 GIF) · 큰 타일 · 이모티콘과 같은 보내기
//   이모지    = 표준 이모지 목록(`EmojiPicker`) · 눌러 입력칸에 넣는다. **보관함의 등록은 보이지 않는다**
//
// 움직이는 팀 이모지는 팀 이모지에 남는다(글 사이에 넣는 쓰임이 같다). 종류가 없는 등록(옛 서버·옛 캐시)은 옛 등록과 같은
// `sticker` 로 읽는다(코어 `expressionKindOf`) — 서버를 올리기 전후로 한 등록이 다른 탭으로 옮겨 다니지 않는다. 메시지·반응의
// 크기 규칙(D1)은 종류를 읽지 않는다: 탭은 고르개의 분류이지 쓰임의 제한이 아니다. 종류는 등록하는 순간 정하고(초안 단계의
// 고르기, `ExpressionDraftStep`), 등록 뒤에는 바꿀 수 없다.
// =============================================================================

export {EXPRESSION_TABS};
export type {ExpressionTab};
/** 팀 보관함을 보는 세 탭. 나머지 하나(`emoji`)는 표준 이모지 목록이다. */
export type ExpressionView = ExpressionShelf;

/** 처음 열 때의 탭 — 옛 이모지 고르개가 열던 표준 이모지 목록(자주 쓰는 것 먼저)이다. */
export const DEFAULT_EXPRESSION_TAB: ExpressionTab = 'emoji';

/** 탭에서 하나를 고르면 하는 일: 대화에 보낸다(미리보기 뒤) / 입력칸에 넣는다. */
export type ExpressionTabAction = 'send' | 'insert';
export const EXPRESSION_TAB_ACTION: Readonly<
  Record<ExpressionTab, ExpressionTabAction>
> = {emoticon: 'send', emoji: 'insert', team: 'insert', gif: 'send'};

/** 검색어의 앞뒤 콜론(`:name:`)은 이름 검색으로 읽는다 — 옛 고르개와 같다. */
export function expressionQuery(query: string): string {
  return query.replace(/^:|:$/g, '');
}

/**
 * 한 탭에 보이는 표현의 차례. 탭 밖의 등록은 이름이 맞아도 들이지 않는다(코어 `expressionsForTab`, 위 머리말).
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
  const found = expressionsForTab(searchExpressions(items, q, usage), view);
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
