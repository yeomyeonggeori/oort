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
//   3. 네 칸이 겹치지 않는 규칙(J2): 보관함의 한 등록은 정확히 한 칸(`team`·`emoticon`·`gif`)에 선다. 창의 세 탭(이모티콘 · 이모지 · GIF)은
//      그 칸들을 모으는 표 하나(`EXPRESSION_TAB_SHELVES`)이고, 웹과 폰이 같은 함수로 보관함을 나눈다.
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

// -----------------------------------------------------------------------------
// 화면의 탭 (owner 2026-11-07, #5453 · 폰 짝 #5452): 이모티콘 · 이모지 · GIF, 우리 팀이 올린 것과 기본을 가르지 않는다.
//
// 위 네 칸(J2)은 **보관함을 겹치지 않게 나누는 분류**이고 그대로다(서버 `kind` 값·API 이름·칸의 이름·고른 뒤의 동작은 바뀌지 않는다).
// 창의 탭은 그 칸들을 이렇게 모은다:
//
//   이모티콘 = 큰 그림. 움직이지 않는 `sticker` 칸(`emoticon`)           · 고르면 입력창 위에서 미리 보고 글과 함께 보낸다
//   이모지   = 작은 그림. 팀 이모지 칸(`team`) + 표준 유니코드 이모지 표   · 고르면 입력칸에 넣는다(글 사이 = inline)
//   GIF      = 움직이는 큰 그림. `gif` 칸                                  · 이모티콘과 같이 미리 보고 보낸다
//
// 「이모지」라는 말은 이 탭의 이름에만 쓴다. 출처(우리 팀 · 기본)로 탭을 가르지 않는다: 분류 함수는 출처를 읽지 않고 `kind`·`media`만 읽는다.
// **기본(내장) 큰 그림은 아직 없다** — 표준 표는 유니코드 이모지뿐이고 내장 스티커 목록은 어디에도 없다. 생기면 같은 이모티콘 탭에 합쳐 서야
// 하며(이 함수들이 받는 모양 `Pick<Expression, "kind" | "media">`을 갖추면 코드 수정 없이 들어온다), 가짜로 채우지 않는다.
//
// 아래 `EXPRESSION_VIEW_SHELVES`·`expressionsForView`·`expressionViewOfPickerTab`·`firstFilledView`는 **보관함 한 보기**(이모티콘 · GIF)의
// 이름을 쓰는 옛 길이고 폰 시트가 아직 쓴다. 폰(#5452)이 `expressionsForPickerTab`으로 옮기면 지운다. 이모지 탭은 보관함의 한 보기가
// 아니라서(표준 표가 바탕) 이 길에서는 계속 `null`이다 — 팀 이모지 칸은 `expressionShelvesOfPickerTab`으로 더한다.
// -----------------------------------------------------------------------------

/** 보관함의 한 보기가 모으는 칸. 이모티콘 보기 = 움직이지 않는 큰 그림, GIF 보기 = 움직이는 큰 그림(옛 길, 위 머리말). */
export const EXPRESSION_VIEW_SHELVES = {
  emoticon: ["emoticon"],
  gif: ["gif"],
} as const satisfies Record<string, readonly ExpressionShelf[]>;
export type ExpressionView = keyof typeof EXPRESSION_VIEW_SHELVES;
export const EXPRESSION_VIEWS = Object.keys(EXPRESSION_VIEW_SHELVES) as readonly ExpressionView[];

/** 여러 칸의 합(차례는 `items` 그대로). 칸이 서로 겹치지 않으므로 한 등록이 두 번 서는 일은 없다. */
export function expressionsForShelves<T extends Pick<Expression, "kind" | "media">>(items: readonly T[], shelves: readonly ExpressionShelf[]): T[] {
  return items.filter((item) => shelves.includes(expressionShelfOf(item)));
}

/** 한 보기에 보이는 보관함의 등록(차례는 `items` 그대로). 이모티콘 보기와 GIF 보기의 합은 `items` 전체이고 겹치지 않는다(시험이 센다). */
export function expressionsForView<T extends Pick<Expression, "kind" | "media">>(items: readonly T[], view: ExpressionView): T[] {
  return expressionsForShelves(items, EXPRESSION_VIEW_SHELVES[view]);
}

/**
 * 폰 시트와 웹 고르개의 세 탭(순서 그대로): 이모티콘 · 이모지 · GIF. 탭 이름 `emoji` 는 표준 유니코드 이모지 표에 팀의 작은 이모지(`team` 칸)를 더한 탭이다
 * (화면의 이름은 「이모지」, 이 말은 탭 이름에만 쓴다). 두 클라이언트가 같은 목록을 쓴다(따로 적으면 한쪽만 바뀐다).
 */
export const EXPRESSION_PICKER_TABS = ["emoticon", "emoji", "gif"] as const;
export type ExpressionPickerTab = (typeof EXPRESSION_PICKER_TABS)[number];
/**
 * 처음 여는 탭 — 이모티콘이다(owner 11-07 탭 순서·카카오톡 레퍼런스, planner 결정 #5482: 웹·폰 모두 처음 열면 첫 탭 「이모티콘」). 웹 고르개가 이 상수로 열고, 폰 창
 * (`ExpressionKeyboardPanel`)도 같은 상수를 첫 탭으로 쓴다 - 한쪽만 바뀌지 않는다. 마지막에 쓴 탭을 기억하는 일은 이 상수와 별개다(폰 창은 이번 실행 동안만 기억하고, 웹은 열 때마다 처음부터다).
 */
export const DEFAULT_EXPRESSION_PICKER_TAB: ExpressionPickerTab = "emoticon";
/** 탭이 보이는 보관함의 보기(옛 길, 폰 #5452가 옮기면 지운다). 이모지 탭은 표준 표가 바탕이라 한 보기가 아니고 `null`. */
export function expressionViewOfPickerTab(tab: ExpressionPickerTab): ExpressionView | null {
  return tab === "emoji" ? null : tab;
}

/**
 * 세 탭이 모으는 보관함의 칸. 한 칸은 정확히 한 탭에만 있다(시험이 센다). 이모지 탭의 표준 유니코드 표는 보관함이 아니라서 여기 없다.
 * 이 표가 탭 분류의 유일한 정본이다: 웹과 폰이 칸 묶음을 따로 적지 않는다.
 */
export const EXPRESSION_TAB_SHELVES = {
  emoticon: ["emoticon"],
  emoji: ["team"],
  gif: ["gif"],
} as const satisfies Record<ExpressionPickerTab, readonly ExpressionShelf[]>;

/** 한 탭이 모으는 보관함의 칸. */
export function expressionShelvesOfPickerTab(tab: ExpressionPickerTab): readonly ExpressionShelf[] {
  return EXPRESSION_TAB_SHELVES[tab];
}

/** 한 탭에 보이는 보관함의 등록(차례는 `items` 그대로, 거른 등록은 같은 객체). 출처는 읽지 않는다 — 우리 팀 것이든 기본이든 `kind`·`media`가 정한 탭에 선다. */
export function expressionsForPickerTab<T extends Pick<Expression, "kind" | "media">>(items: readonly T[], tab: ExpressionPickerTab): T[] {
  return expressionsForShelves(items, expressionShelvesOfPickerTab(tab));
}

/** 하나를 고르면 하는 일: 대화에 보낸다(미리보기 뒤) / 입력칸에 넣는다. */
export type ExpressionAction = "send" | "insert";
/**
 * 한 등록을 고르면 하는 일. 등록이 선 칸(J2)이 정한다: 작은 팀 이모지 칸(이모지 탭)은 입력칸에 넣고(글 사이 = inline), 이모티콘·GIF 칸은 입력창 위에서
 * 미리 보고 글과 함께 보낸다(단독 전송 = large). 한 탭 안에서는 동작이 하나다 — 탭이 칸으로 나뉘기 때문이다.
 */
export function expressionActionOf(item: Pick<Expression, "kind" | "media">): ExpressionAction {
  return expressionShelfOf(item) === "team" ? "insert" : "send";
}

/**
 * 보관함을 처음 열 때의 보기. 이모티콘부터 보되, 거기가 비고 GIF에만 등록이 있으면 GIF다(그 보기를 열어 두면 있는 그림이 한 장도
 * 안 보인다). 사람이 보기를 고른 뒤에는 쓰이지 않는다. 지운·숨긴 등록은 세지 않는다.
 */
export function firstFilledView(items: readonly Pick<Expression, "kind" | "media" | "status">[]): ExpressionView {
  const active = items.filter((item) => item.status === "active");
  return EXPRESSION_VIEWS.find((view) => expressionsForView(active, view).length > 0) ?? "emoticon";
}
