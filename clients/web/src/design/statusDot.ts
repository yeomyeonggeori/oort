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
// 색은 `--ok`/`--warn`/`--danger` 상태 토큰과 `--ink-muted` 뿐이다(SKILL §2: 상태색은 이 셋에서만). 점이 색에만
// 기대지 않도록 글자가 없는 자리의 점은 **모양**도 다르다(아래).
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

// 아바타 모서리의 점(글자가 없는 자리)은 이 파일의 클래스가 아니라 한 부품(`features/presence/AvatarStatus.tsx`)과 그
// CSS(`tokens.css` 의 `avatar-status` · `status-shape-*`)가 그린다(#5786): 아바타를 점 둘레만큼 도려낸 자리에 앉고, 모양은
// 뜻이 고른다(코어 `statusBadgeShape` — 사람: 채운 원 · 초승달(자리 비움) · 가로 줄(방해 금지) · 속 빈 고리, 에이전트: 채운
// 원(살아 있음·경고) · 속 빈 고리). 색 역할은 위 칩과 같은 `--ok`·`--warn`·`--danger` 이고
// (띠 위의 초록만 점 전용 `--status-ok`), 꺼짐 고리의 선은 `--ink-muted` 다.
