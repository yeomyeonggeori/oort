import {contrast} from '@momo/core/design/color';

import type {Palette} from '../../design/tokens';
import {CONV} from './convDesign';

// =============================================================================
// 말풍선 외양 토큰 (#4300, owner 2026-10-24 「말풍선 디자인도 에이전트와 함께 충분히 커스텀」).
//
// 말풍선의 색·글자색·모서리·배치는 **여기서만** 정해진다. 화면 코드(`MessageBody`)는 이 함수의
// 결과만 읽고 색 리터럴을 박지 않는다 — 그래야 개인 덮어쓰기(#4307 설정 화면·에이전트 명령)가
// 한 자리에서 먹는다.
//
//   bubble.mine.bg / .fg     내 말풍선. 기본 = 신호색(accent) 채움 + 그 위 글자(onAccent).
//   bubble.other.bg / .fg    남 말풍선. 기본 = 표면 두 단(surface · surfacePressed) 중 **바닥(bg)에서
//                            더 도드라지는 쪽** + 본문 글자(text). 테마마다 어느 쪽이 도드라지는지가
//                            다르다(dawnsky 라이트는 surface, 나머지는 surfacePressed).
//   bubble.radius            모서리. **행 강조 면(눌림·착지)의 모서리와 무관하다.**
//   bubble.layout            'bubble'(기본) | 'row'(예전 평면 행).
//
// 덮어쓰기는 대비가 모자라면 **그 값만 버린다**(기본값으로 물러난다): 글자 대비 4.5:1 미만이면
// 사용자의 색은 안 받는다 — 화면을 잠그지도 던지지도 않는다.
// =============================================================================

export type BubbleLayout = 'bubble' | 'row';

export interface BubbleOverrides {
  mine?: {bg?: string; fg?: string};
  other?: {bg?: string; fg?: string};
  radius?: number;
  layout?: BubbleLayout;
}

export interface BubbleTokens {
  mine: {bg: string; fg: string};
  other: {bg: string; fg: string};
  radius: number;
  layout: BubbleLayout;
  padX: number;
  padY: number;
}

/** 말풍선 글자 대비의 바닥 — 본문 AA. */
export const BUBBLE_MIN_CONTRAST = 4.5;

export type BubbleInput = Pick<
  Palette,
  'accent' | 'onAccent' | 'surface' | 'surfacePressed' | 'text' | 'bg'
>;

const HEX = /^#[0-9a-f]{6}$/i;

/** 남 말풍선 기본 채움 — 표면 두 단 중 바닥에서 더 도드라지는 쪽. 같으면 `surfacePressed`. */
export function otherBubbleFill(p: Pick<Palette, 'surface' | 'surfacePressed' | 'bg'>): string {
  return contrast(p.surface, p.bg) > contrast(p.surfacePressed, p.bg)
    ? p.surface
    : p.surfacePressed;
}

function pick(
  want: {bg?: string; fg?: string} | undefined,
  base: {bg: string; fg: string},
): {bg: string; fg: string} {
  const bg = want?.bg !== undefined && HEX.test(want.bg) ? want.bg : base.bg;
  const fg = want?.fg !== undefined && HEX.test(want.fg) ? want.fg : base.fg;
  // 덮어쓴 조합이 대비를 못 지키면 덮어쓰기 전체를 버린다(반쪽만 먹이면 더 나쁘다).
  return contrast(fg, bg) >= BUBBLE_MIN_CONTRAST ? {bg, fg} : base;
}

export function bubbleFor(p: BubbleInput, overrides?: BubbleOverrides): BubbleTokens {
  const mineBase = {bg: p.accent, fg: p.onAccent};
  const otherBase = {bg: otherBubbleFill(p), fg: p.text};
  return {
    mine: pick(overrides?.mine, mineBase),
    other: pick(overrides?.other, otherBase),
    radius:
      overrides?.radius !== undefined && overrides.radius >= 0 && overrides.radius <= 28
        ? overrides.radius
        : CONV.bubbleRadius,
    layout: overrides?.layout === 'row' ? 'row' : 'bubble',
    padX: CONV.bubblePadX,
    padY: CONV.bubblePadY,
  };
}
