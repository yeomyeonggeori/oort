import type { StatusDotTone } from "./statusDot";

// =============================================================================
// 아바타 모서리 상태 점의 크기와 모양 (#5786, owner 2026-11-13 QA 15 「상태 칩의 크기 비율 및 유려한 곡선 처리」).
//
// 점의 지름과 점 둘레의 틈을 **아바타 한 변 하나에서** 정한다. 웹(데스크탑 셸 포함)과 폰이 같은 함수를 읽는다:
//
//   웹  아바타를 점 둘레만큼 CSS 마스크로 도려내고(틈 = 그 자리의 바탕이 그대로 보인다) 그 자리에 점을 앉힌다.
//       인라인 스타일을 쓰지 않는 집이라(디자인 스킬 §1) 값은 `tokens.css` 의 `avatar-status` 규칙에 크기마다 적혀
//       있고, `avatarStatus.geometry.test.ts` 가 그 값이 이 함수와 같은지 잰다(값이 두 곳에서 갈라지면 붉다).
//   폰  도려내기가 기본 기능이 아니라(마스크는 새 의존) 고리를 두되, 고리 두께 = 틈, 점 = 같은 지름이다. 고리 색은
//       얼굴이 서는 바탕이다(`FaceStatusDot` 의 `ground`).
//
// 크기 표(수리 1회차, design-review r1 B1·M2):
//
//   아바타  24 · 28 · 32 · 40 · 56 · 112
//   점       8 · 10 · 12 · 16 · 22 ·  28
//   틈       2 ·  2 ·  2 ·  2 ·  3 ·   4
//
//   작은 얼굴(≤ 24)   점 ≈ 1/3. 38% 점(10)과 틈 2 는 구멍 지름이 아바타의 58% 라 이니셜의 오른쪽 아래(받침)를 12~21%
//                    먹었다(「김」이 「기」로 읽혔다). 점 8 로 줄이고, 점이 있을 때만 이니셜을 구멍 반대쪽(왼쪽 위)으로
//                    1px 옮긴다(`glyphShift`) — 두 엔진에서 이니셜 잉크 손실 0.5% 이하.
//   보통 얼굴         점 ≈ 38%(짝수 px 로 반올림 — 점의 중심이 정수 px 에 앉아 가장자리가 흐려지지 않는다).
//   큰 얼굴           점은 28 을 넘지 않는다. 112 에서 42(38%)는 프로필 창에서 주 단추보다 먼저 눈에 들어왔다
//                    (Slack·Teams 처럼 큰 얼굴만 비율이 내려간다: 112 → 25%).
//   틈               점 지름의 1/7(최소 2). 꺼짐을 뜻하는 속 빈 고리의 두께도 틈과 같다 — 고리와 틈이 한 굵기다.
//
// 점은 아바타 상자 **안**의 오른쪽 아래에 붙는다(점 상자의 오른쪽·아래 = 아바타 상자의 오른쪽·아래). 상자 밖으로
// 나가지 않으므로 줄 높이·잘림이 바뀌지 않는다.
// =============================================================================

/** 점 지름 / 아바타 한 변(보통 얼굴). */
export const STATUS_BADGE_RATIO = 0.38;

/** 작은 얼굴의 경계와 비율: 이 크기 이하에서는 점이 아바타의 1/3 이다(이니셜이 아바타의 절반을 차지하는 크기). */
export const STATUS_BADGE_SMALL_FACE = 24;
export const STATUS_BADGE_SMALL_RATIO = 1 / 3;

/** 점 지름의 상한(px/pt). 큰 얼굴에서 점이 화면의 주인공이 되지 않게 한다. */
export const STATUS_BADGE_MAX_DOT = 28;

/** 틈의 바닥(px/pt). 이보다 얇으면 배경이 비쳐 보이지 않는다. */
export const STATUS_BADGE_MIN_GAP = 2;

export interface StatusBadgeGeometry {
  /** 아바타 한 변. */
  face: number;
  /** 점 지름(짝수). */
  dot: number;
  /** 점 둘레의 틈 = 도려낸 원의 반지름 - 점 반지름. 속 빈 고리의 두께도 이 값이다. */
  gap: number;
  /**
   * 점이 있을 때 이니셜(글자 아바타의 한 글자)을 왼쪽 위로 옮기는 거리(px). 작은 얼굴에서만 1, 나머지는 0 이다 —
   * 구멍이 받침 자리에 닿는 것은 글자가 아바타의 절반을 차지하는 작은 얼굴뿐이다. 사진·기본 아바타는 옮기지 않는다.
   */
  glyphShift: number;
}

const even = (n: number) => 2 * Math.round(n / 2);

export function statusBadgeGeometry(face: number): StatusBadgeGeometry {
  const small = face <= STATUS_BADGE_SMALL_FACE;
  const dot = Math.min(STATUS_BADGE_MAX_DOT, even(face * (small ? STATUS_BADGE_SMALL_RATIO : STATUS_BADGE_RATIO)));
  const gap = Math.max(STATUS_BADGE_MIN_GAP, Math.round(dot / 7));
  return { face, dot, gap, glyphShift: small ? 1 : 0 };
}

/**
 * 웹이 그리는 아바타 크기 셋: 사이드바 DM 줄·접힌 레일 24, 목록·프로필 줄 32(`AVATAR_SIZE`), 멤버 프로필 창의 큰 얼굴
 * 112(`--spacing-avatar-hero`). `tokens.css` 의 `[data-status-face]` 규칙이 이 셋을 모두 갖는지도 시험이 잰다.
 */
export const WEB_STATUS_BADGE_FACES = [24, 32, 112] as const;
export type WebStatusBadgeFace = (typeof WEB_STATUS_BADGE_FACES)[number];

// ---- 모양: 톤이 아니라 뜻에 묶는다 ----------------------------------------------------------------

/**
 * 점의 모양. 글자가 곁에 없는 자리라 색만으로 말하지 않는다:
 *
 *   fill  채운 원
 *   moon  초승달(왼쪽 위를 둥글게 덜어 냄)
 *   bar   가로 줄이 빠진 원
 *   ring  속 빈 고리(굵기 = 틈)
 */
export type StatusBadgeShape = "fill" | "moon" | "bar" | "ring";

/** 점이 누구의 상태인가. 같은 톤이라도 사람과 에이전트에서 뜻이 다르다. */
export type StatusBadgeSubject = "human" | "agent";

/**
 * 톤 + 누구 → 모양 (design-review r1 H2). 모양은 **뜻**을 말한다:
 *
 *   사람      온라인 = 채운 원 · 자리 비움 = 초승달 · 방해 금지 = 가로 줄 · 오프라인 = 속 빈 고리
 *   에이전트  살아 있음 = 채운 원 · 경고(owner/admin: 일이 안 가져가짐·응답 없음·거절됨) = **채운 원**(주황) · 꺼짐 = 속 빈 고리
 *
 * 에이전트의 경고는 「손이 필요하다」이고 사람의 자리 비움(「쉬는 중」)과 뜻이 반대다. 그래서 초승달을 빌리지 않고 이
 * 칸 전의 모양(채운 주황, Buzz식 소유자 결정 2026-10-17)을 지킨다. 속 빈 고리는 둘 다 「꺼져 있다」라 같다.
 */
export function statusBadgeShape(tone: StatusDotTone, subject: StatusBadgeSubject): StatusBadgeShape {
  if (tone === "muted") return "ring";
  if (subject === "agent") return "fill";
  if (tone === "warn") return "moon";
  if (tone === "danger") return "bar";
  return "fill";
}
