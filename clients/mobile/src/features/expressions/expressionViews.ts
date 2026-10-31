import {searchExpressions} from '@momo/core/features/expressions/search';
import type {Expression} from '@momo/core/features/expressions/types';
import {
  recentExpressions,
  type ExpressionUsage,
} from '@momo/core/features/expressions/usage';

// =============================================================================
// 입력창 표현 시트의 네 탭 (#4942, owner 10-31) — 이모티콘 · 이모지 · 팀 이모지 · GIF.
//
// ## 종류를 나누는 기준 (인계에도 적었다)
//
// 코어 표현 모델에는 「종류」 필드가 **없다**. ADR-0218 D1-4 가 그렇게 정했다: 한 등록이 반응(작게)·글 사이·단독 전송(크게)에
// 모두 쓰이고 별도 `kind=sticker` 가 없으며, 패널의 이모지·스티커·우리 팀 GIF 는 **같은 보관함의 표시/필터**다(웹 패널
// `TeamExpressionsPanel` 이 그 약속을 이미 구현했다 — 이모지 보기는 작게, 스티커 보기는 중간 크기로 같은 목록을 보이고,
// GIF 보기만 `large.mime === 'image/gif'` 로 거른다). 폰도 같은 약속을 따른다. 그래서 새 분류를 지어내거나 저장하지 않는다:
//
//   이모티콘  = 보관함 전체 · 큰 타일 · 눌러 큰 그림을 미리 본 뒤 **대화로 보낸다**(단독 전송 = large)
//   팀 이모지 = 보관함 전체 · 작은 칸 · 눌러 `:이름:` 을 **입력칸에 넣는다**(글 사이 = inline)
//   GIF       = 움직이는 것만(`large.mime === 'image/gif'`, 웹과 같은 기준) · 큰 타일 · 이모티콘과 같은 보내기
//   이모지    = 표준 이모지 목록(`EmojiPicker`) · 눌러 입력칸에 넣는다
//
// 같은 등록이 이모티콘·팀 이모지(그리고 움직이면 GIF)에 함께 보이는 것은 의도다 — 탭은 「무엇인가」가 아니라 「어떻게 쓸
// 것인가」(크게 보낼까·글 사이에 넣을까·움직이는 것만 볼까)를 고른다.
// =============================================================================

export const EXPRESSION_TABS = ['emoticon', 'emoji', 'team', 'gif'] as const;
export type ExpressionTab = (typeof EXPRESSION_TABS)[number];
/** 팀 보관함을 보는 세 탭. 나머지 하나(`emoji`)는 표준 이모지 목록이다. */
export type ExpressionView = Exclude<ExpressionTab, 'emoji'>;

/** 처음 열 때의 탭 — 옛 이모지 고르개가 열던 표준 이모지 목록(자주 쓰는 것 먼저)이다. */
export const DEFAULT_EXPRESSION_TAB: ExpressionTab = 'emoji';

/** 탭에서 하나를 고르면 하는 일: 대화에 보낸다(미리보기 뒤) / 입력칸에 넣는다. */
export type ExpressionTabAction = 'send' | 'insert';
export const EXPRESSION_TAB_ACTION: Readonly<
  Record<ExpressionTab, ExpressionTabAction>
> = {emoticon: 'send', emoji: 'insert', team: 'insert', gif: 'send'};

/** 움직이는 표현인가 — 보내는 그림(`large`)이 GIF 이다. 웹 패널의 GIF 보기와 같은 기준. */
export function isAnimatedExpression(item: Expression): boolean {
  return item.media?.large.mime === 'image/gif';
}

/** 검색어의 앞뒤 콜론(`:name:`)은 이름 검색으로 읽는다 — 옛 고르개와 같다. */
export function expressionQuery(query: string): string {
  return query.replace(/^:|:$/g, '');
}

/**
 * 한 탭에 보이는 표현의 차례.
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
  const found = searchExpressions(items, q, usage).filter(
    item => view !== 'gif' || isAnimatedExpression(item),
  );
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
