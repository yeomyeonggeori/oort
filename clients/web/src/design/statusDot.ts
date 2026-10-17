import type { StatusDotTone } from "@momo/core/features/presence/statusDot";

// =============================================================================
// 상태 점의 클래스 (#3964). 점의 **톤**(어떤 상태가 어떤 색 역할인가)은 코어
// (`@momo/core/features/presence/statusDot`)가 정하고, 이 파일은 그 톤을 웹의 토큰 클래스에 매긴다 -
// `presence/model.ts` 머리말의 분업(웹은 Tailwind, 폰은 토큰 객체)이다. 아바타 점과 생존 칩은 **같은 함수**
// (`agentDotTone`)가 정한 톤을 읽으므로 한 상태가 두 자리에서 다른 색이 될 수 없다.
//
// Buzz식(소유자 결정 2026-10-17 「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」): 채운 초록 = 살아 있음(응답함·살아 있음·대기),
// 속 빈 회색 고리 = 꺼짐(조용함·꺼짐), 채운 주황 = 경고(owner/admin 에게만).
//
// 색은 `--ok`/`--warn`/`--danger` 상태 토큰과 `--ink-muted`/`--line-strong` 뿐이다(SKILL §2: 상태색은
// 이 셋에서만). 점이 색에만 기대지 않도록 muted 는 **모양**도 다르다(아래).
// =============================================================================

/**
 * 글자가 곁에 있는 점(생존 칩, 멤버 목록): 모든 톤이 채워진다. 뜻은 곁의 낱말이 말한다. 칩의 `muted`(조용함·꺼짐)는
 * 채운 회색이다(속 빈 고리는 글자가 없는 자리의 모양이다).
 */
export const STATUS_DOT_FILL_CLASS: Readonly<Record<StatusDotTone, string>> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-ink-muted",
};

/**
 * 아바타 모서리의 점(DM 행: 글자가 없다) - **모양이 말한다**. 살아 있는 톤(ok·warn·danger)은 채운 점이고, 꺼짐을 뜻하는
 * `muted`(조용함·꺼짐)는 **속이 빈 고리**다: 프로필 카드의 오프라인 배지(`PresenceControl`)와 같은 문법이라 「오프라인은
 * 채움이 없는 고리 - 채운 점과도, 아무것도 없는 것과도 다르다」. 살아 있음(채운 초록)과 꺼짐(고리)이 한 점이 되지 않는다
 * (design-review #3964 H1). 테두리 한 겹(`border-surface`)은 점이 아바타에서 떨어져 보이게 하는 면색 고리다.
 */
export const STATUS_DOT_BADGE_CLASS: Readonly<Record<StatusDotTone, string>> = {
  ok: "bg-ok border-surface",
  warn: "bg-warn border-surface",
  danger: "bg-danger border-surface",
  muted: "bg-surface border-line-strong",
};
