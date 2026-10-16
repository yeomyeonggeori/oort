import type { StatusDotTone } from "@momo/core/features/presence/statusDot";

// =============================================================================
// 상태 점의 클래스 (#3964). 점의 **톤**(어떤 상태가 어떤 색 역할인가)은 코어
// (`@momo/core/features/presence/statusDot`)가 정하고, 이 파일은 그 톤을 웹의 토큰 클래스에 매긴다 -
// `presence/model.ts` 머리말의 분업(웹은 Tailwind, 폰은 토큰 객체)이다. 아바타 점과 생존 칩은 같은 판정·같은 색
// 역할(ok·warn)을 읽으므로 한 상태가 두 자리에서 다른 색이 될 수 없다. 다른 것은 **neutral 하나**다: 칩은 낱말이 곁에
// 있어 한 색(채운 회색)으로 그리고, 낱말이 없는 아바타 점은 모양으로 가른다(채운 회색 = 살아 있음, 속 빈 고리 = 아님).
//
// 색은 `--ok`/`--warn`/`--danger` 상태 토큰과 `--ink-muted`/`--line-strong` 뿐이다(SKILL §2: 상태색은
// 이 셋에서만). 점이 색에만 기대지 않도록 muted 는 **모양**도 다르다(아래).
// =============================================================================

/**
 * 글자가 곁에 있는 점(생존 칩, 멤버 목록): 모든 톤이 채워진다. 뜻은 곁의 낱말이 말한다. `idle`·`muted` 는 칩에서 같은
 * 채운 회색이다(칩은 neutral 셋을 한 색으로 그리고 낱말이 가른다).
 */
export const STATUS_DOT_FILL_CLASS: Readonly<Record<StatusDotTone, string>> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  idle: "bg-ink-muted",
  muted: "bg-ink-muted",
};

/**
 * 아바타 모서리의 점(DM 행: 글자가 없다) - **모양이 말한다**. 신호가 오는 톤(ok·warn·danger·idle)은 채운 점이고,
 * 응답을 기대하기 어려운 `muted`(조용함·꺼짐)는 **속이 빈 고리**다: 프로필 카드의 오프라인 배지(`PresenceControl`)와
 * 같은 문법이라 「오프라인은 채움이 없는 고리 - 채운 점과도, 아무것도 없는 것과도 다르다」. 살아 있지만 일이 없는
 * 에이전트(`idle`: 채운 회색)와 꺼진 에이전트(`muted`: 고리)가 한 점이 되지 않는다(design-review #3964 H1).
 * 테두리 한 겹(`border-surface`)은 점이 아바타에서 떨어져 보이게 하는 면색 고리다.
 */
export const STATUS_DOT_BADGE_CLASS: Readonly<Record<StatusDotTone, string>> = {
  ok: "bg-ok border-surface",
  warn: "bg-warn border-surface",
  danger: "bg-danger border-surface",
  idle: "bg-ink-muted border-surface",
  muted: "bg-surface border-line-strong",
};
