// =============================================================================
// 아바타 모서리 상태 점의 크기 (#5786, owner 2026-11-13 QA 15 「상태 칩의 크기 비율 및 유려한 곡선 처리」).
//
// 점의 지름과 점 둘레의 틈을 **아바타 한 변 하나에서** 정한다. 웹(데스크탑 셸 포함)과 폰이 같은 함수를 읽는다:
//
//   웹  아바타를 점 둘레만큼 CSS 마스크로 도려내고(틈 = 그 자리의 바탕이 그대로 보인다) 그 자리에 점을 앉힌다.
//       인라인 스타일을 쓰지 않는 집이라(디자인 스킬 §1) 값은 `tokens.css` 의 `avatar-status` 규칙에 크기마다 적혀
//       있고, `avatarStatus.geometry.test.ts` 가 그 값이 이 함수와 같은지 잰다(값이 두 곳에서 갈라지면 붉다).
//   폰  도려내기가 기본 기능이 아니라(마스크는 새 의존) 면색 고리를 그대로 두되, 고리 두께 = 틈, 점 = 같은 지름이다.
//
// 비율: 점 지름 ≈ 아바타의 38%(짝수 px 로 반올림 — 점의 중심이 정수 px 에 앉아 가장자리가 흐려지지 않는다),
// 틈은 점 지름의 1/6(최소 2). 24·32 에서 틈은 2, 큰 얼굴(112)에서는 비례해 7 이다. 꺼짐을 뜻하는 속 빈 고리의 두께도
// 틈과 같다 — 고리와 틈이 한 굵기라 작은 얼굴에서도 고리가 한 줄로 읽힌다.
//
// 점은 아바타 상자 **안**의 오른쪽 아래에 붙는다(점 상자의 오른쪽·아래 = 아바타 상자의 오른쪽·아래). 상자 밖으로
// 나가지 않으므로 줄 높이·잘림이 바뀌지 않는다.
// =============================================================================

/** 점 지름 / 아바타 한 변. */
export const STATUS_BADGE_RATIO = 0.38;

/** 틈의 바닥(px/pt). 이보다 얇으면 배경이 비쳐 보이지 않는다. */
export const STATUS_BADGE_MIN_GAP = 2;

export interface StatusBadgeGeometry {
  /** 아바타 한 변. */
  face: number;
  /** 점 지름(짝수). */
  dot: number;
  /** 점 둘레의 틈 = 도려낸 원의 반지름 - 점 반지름. 속 빈 고리의 두께도 이 값이다. */
  gap: number;
}

export function statusBadgeGeometry(face: number): StatusBadgeGeometry {
  const dot = 2 * Math.round((face * STATUS_BADGE_RATIO) / 2);
  const gap = Math.max(STATUS_BADGE_MIN_GAP, Math.round(dot / 6));
  return { face, dot, gap };
}

/**
 * 웹이 그리는 아바타 크기 셋: 사이드바 DM 줄·접힌 레일 24, 목록·프로필 줄 32(`AVATAR_SIZE`), 멤버 프로필 창의 큰 얼굴
 * 112(`--spacing-avatar-hero`). `tokens.css` 의 `[data-status-face]` 규칙이 이 셋을 모두 갖는지도 시험이 잰다.
 */
export const WEB_STATUS_BADGE_FACES = [24, 32, 112] as const;
export type WebStatusBadgeFace = (typeof WEB_STATUS_BADGE_FACES)[number];
