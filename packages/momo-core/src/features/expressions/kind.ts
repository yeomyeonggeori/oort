import type { Expression, ExpressionDraft, ExpressionImage, ExpressionKind } from "./types";

// =============================================================================
// 팀 표현의 종류 (ADR-0218 증보 4 §10, #4961).
//
// 등록마다 종류 하나가 있다: `emoji`(작은 팀 이모지) · `sticker`(큰 이모티콘). 종류는 **고르개의 분류**
// 이지 쓰임의 제한이 아니다 — 메시지·반응의 크기 규칙(D1)은 종류를 읽지 않는다. 이 파일이 가진 것은
// 세 가지다:
//   1. 추천 규칙(J4): 등록하는 순간 큰 그림의 크기·움직임으로 종류를 제안한다. 서버(`Kind::recommended`)와
//      같은 규칙이고, 같은 사례 표(`docs/api/expression-kind.vectors.json`)를 두 쪽 시험이 읽는다.
//   2. 읽는 규칙(J6): 종류가 없는 등록(옛 서버·옛 캐시)이 뜻하는 값.
//   3. 네 탭이 겹치지 않는 규칙(J2): 폰 시트의 네 탭과 웹 패널의 세 보기가 같은 함수로 보관함을 나눈다.
// 순수 모듈이다: DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다. 문장은 여기 없다(사전이 가진다).
// =============================================================================

/**
 * J4: 긴 변이 이 값 이하인 정지 그림은 이미 small 크기라 이모지다. 큰 그림은 확대하지 않으므로(D3)
 * 큰 그림의 긴 변이 곧 원본의 긴 변이다. 서버의 `EMOJI_MAX_EDGE`와 같은 값이다.
 */
export const EXPRESSION_EMOJI_MAX_EDGE = 128;

/**
 * J5·J6: 종류가 없는 등록이 뜻하는 값. migration 171의 열 기본값과 같다: 옛 등록은 모두 `sticker`라,
 * 서버를 올리기 전후로 한 등록이 다른 탭으로 옮겨 다니지 않는다.
 */
export const LEGACY_EXPRESSION_KIND: ExpressionKind = "sticker";

/**
 * J4 추천: 움직이거나(`frameCount > 1`) 긴 변이 128보다 크면 `sticker`, 그 밖(움직이지 않고 128 이하)은
 * `emoji`. 제안일 뿐이다 — 사람이 바꿀 수 있고, 안 바꾸면 서버가 같은 규칙을 저장된 큰 그림에 적용한다.
 */
export function recommendExpressionKind(large: Pick<ExpressionImage, "width" | "height" | "frameCount">): ExpressionKind {
  return large.frameCount > 1 || Math.max(large.width, large.height) > EXPRESSION_EMOJI_MAX_EDGE ? "sticker" : "emoji";
}

/**
 * 초안 카드가 미리 고르는 종류: 서버가 곧 등록할 큰 그림에 같은 규칙을 적용한 값. 그림이 없는 초안
 * (받기 실패 카드)은 고를 것이 없어 null이다.
 */
export function recommendedKindForDraft(draft: ExpressionDraft): ExpressionKind | null {
  return draft.state === "ready" ? recommendExpressionKind(draft.media.large) : null;
}

/**
 * 한 등록의 종류. 서버는 항상 싣지만 계약은 키를 선택으로 두므로(J6) 없는 응답이 온다: 그것은 옛 등록과
 * 같은 `sticker`다. 모르는 값(더 새 서버가 만든 셋째 종류)도 같다 — 읽지 못하는 값을 지어내지 않는다.
 */
export function expressionKindOf(item: Pick<Expression, "kind">): ExpressionKind {
  return item.kind === "emoji" || item.kind === "sticker" ? item.kind : LEGACY_EXPRESSION_KIND;
}

/** 움직이는 표현인가: 큰 그림이 GIF다. 스키마가 GIF는 프레임 2 이상, PNG는 1로 묶으므로 「GIF ⟺ 움직임」이다. */
export function isAnimatedExpression(item: Pick<Expression, "media">): boolean {
  return item.media?.large.mime === "image/gif";
}

/** 폰 시트의 네 탭(순서 그대로). `emoji`는 표준 유니코드 이모지 목록이라 팀 보관함의 등록은 없다. */
export const EXPRESSION_TABS = ["emoticon", "emoji", "team", "gif"] as const;
export type ExpressionTab = (typeof EXPRESSION_TABS)[number];
/** 팀 보관함을 보는 세 칸. 웹 패널의 세 보기(스티커·이모지·팀 GIF)도 이 세 칸이다. */
export type ExpressionShelf = Exclude<ExpressionTab, "emoji">;

/**
 * J2: 보관함의 한 등록이 있는 칸 — 정확히 하나. `emoji`는 움직여도 팀 이모지(글 사이에 넣는 쓰임이 같다),
 * `sticker`는 움직이면 GIF·아니면 이모티콘이다.
 */
export function expressionShelfOf(item: Pick<Expression, "kind" | "media">): ExpressionShelf {
  if (expressionKindOf(item) === "emoji") return "team";
  return isAnimatedExpression(item) ? "gif" : "emoticon";
}

/** 보관함을 처음 열 때 보는 차례: 팀 이모지부터. */
const OPENING_ORDER: readonly ExpressionShelf[] = ["team", "emoticon", "gif"];

/**
 * 보관함을 처음 열 때의 칸. 팀 이모지부터 보되 비어 있으면 처음으로 등록이 있는 칸이다: 옛 등록은 모두 `sticker`라
 * (J5) 팀 이모지 칸은 새로 등록하기 전까지 비어 있고, 그 칸을 열어 두면 있는 그림이 한 장도 안 보인다.
 * 사람이 칸을 고른 뒤에는 쓰이지 않는다. 등록이 하나도 없으면 팀 이모지. 지운·숨긴 등록은 세지 않는다.
 */
export function firstFilledShelf(items: readonly Pick<Expression, "kind" | "media" | "status">[]): ExpressionShelf {
  const active = items.filter((item) => item.status === "active");
  return OPENING_ORDER.find((shelf) => expressionsForTab(active, shelf).length > 0) ?? "team";
}

/**
 * 한 탭에 보이는 보관함의 등록(차례는 `items` 그대로). 이모지 탭은 표준 이모지 목록이 채우므로 등록은
 * 하나도 없다. 세 칸의 합은 `items` 전체이고 서로 겹치지 않는다(시험이 센다).
 */
export function expressionsForTab<T extends Pick<Expression, "kind" | "media">>(items: readonly T[], tab: ExpressionTab): T[] {
  if (tab === "emoji") return [];
  return items.filter((item) => expressionShelfOf(item) === tab);
}
