import {contrast, mixOklab} from '@momo/core/design/color';

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
//
// ## 보내지 못한 내 말풍선 (#5294, 화면 검수 5a M5)
//
// 못 보낸 글은 옅게 보여야 한다(서버가 모르는 글이다). 옅기를 말풍선 전체의 불투명도 막(`opacity: 0.6`)으로 걸면 **글자도 함께 바탕으로
// 녹는다** — 채움 위 글자가 밝음 2.66:1 · 어두움 3.52:1 이 됐다(웹은 같은 상태를 `text-ink-muted`, AA 로 흐린다). 글자색(`onAccent`)이
// 바탕(`bg`)과 거의 같은 색이라, 채움을 바탕 쪽으로 옅히면 둘이 함께 사라지는 것이 원인이다. 그래서 흐림은 **채움만** 맡고, 글자는
// 옅어진 채움 위에서 4.5:1 을 지키는 잉크로 바꾼다(`failedBubbleFor`). 정상 전송의 메아리·확정 말풍선은 이 함수를 거치지 않는다.
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

/**
 * 채움을 바탕 쪽으로 옅히는 정도(0 = 그대로, 1 = 바탕). 덜 옅은 쪽부터 시도한다 — 옅어야 못 보냈다는 것이 보이되, 글자 대비가 먼저다.
 * 마지막 1 은 채움이 바탕 그 자체가 되는 단계라, 본문 글자색(`text`)이 바탕 위에서 4.5:1 을 지키는 어떤 팔레트에서도 반드시 닿는다.
 */
const FAILED_FILL_FADES = [0.5, 0.65, 0.8, 1] as const;

/**
 * 보내지 못한 말풍선의 채움·글자. 채움은 `tone.bg` 를 바탕(`p.bg`) 쪽으로 옅힌 불투명 색이고(불투명도 막이 아니다), 글자는 그 위에서
 * `BUBBLE_MIN_CONTRAST` 를 지키는 잉크다: 말풍선 본래 글자색(`tone.fg`)이 지키면 그것, 아니면 본문 글자색(`p.text`).
 * 어떤 단계에서도 못 지키면(바탕 위 본문 글자도 4.5 미달인 깨진 팔레트) 옅히지 않은 `tone` 그대로다 — 대비가 먼저다.
 */
export function failedBubbleFor(
  p: Pick<BubbleInput, 'bg' | 'text'>,
  tone: {bg: string; fg: string},
): {bg: string; fg: string} {
  for (const fade of FAILED_FILL_FADES) {
    const bg = mixOklab(tone.bg, p.bg, fade);
    for (const fg of [tone.fg, p.text]) {
      if (contrast(fg, bg) >= BUBBLE_MIN_CONTRAST) return {bg, fg};
    }
  }
  return tone;
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
