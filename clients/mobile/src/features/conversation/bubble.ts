import {contrast, fromOklch, mixOklab, toOklch} from '@momo/core/design/color';

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
//   bubble.other.bg / .fg    남 말풍선. 기본 = 표면 두 단(surface · surfacePressed) 중 **대화 목록의
//                            실제 바닥(`conversationFloor`)에서 더 도드라지는 쪽** + 본문 글자(text).
//                            라이트의 대화 바닥은 `surface` 라서 `surface` 는 늘 바닥과 같다 — 그래서 라이트
//                            남 말풍선은 `surfacePressed` 다(#5421: 옛 판은 바닥을 `bg` 로 읽어 dawnsky 라이트에서
//                            `surface` 를 골랐고, 말풍선이 바탕과 같은 `#fffefc` 가 되어 보이지 않았다).
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
  'accent' | 'onAccent' | 'surface' | 'surfacePressed' | 'text' | 'bg' | 'mode' | 'backdrop'
>;

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * 대화 목록이 **실제로 서는 바닥** (#5421) — `ConversationScreen` 의 `screen` 배경(위 25% 에서 `canvasTop` 이 이 색으로 건너가고 그 아래는 평평하다)의
 * 끝 색이자 측정 하네스 `ConversationFloor` 의 끝 색이다. 세 곳이 이 함수 하나를 읽는다 — 화면 배경을 고치면 말풍선 채움과 사진 틀이 함께 움직인다.
 *
 * 라이트는 `surface`(종이색), 다크는 `bg`, 사용자 배경 이미지 위에서는 `bg` 한 장(`AppBackground` 가 그 밑을 그린다)이다. 팔레트의 `bg` 가 늘 바닥인 것이 아니다 —
 * 라이트에서 `bg`(`canvas-mid`)는 대화 목록 바닥에 쓰이지 않고(목록은 `canvasTop` → `surface` 그라디언트), 그 값으로 말풍선을 골랐던 것이 #5421 의 뿌리였다.
 */
export function conversationFloor(
  p: Pick<Palette, 'mode' | 'backdrop' | 'surface' | 'bg'>,
): string {
  return p.backdrop !== 'image' && p.mode === 'light' ? p.surface : p.bg;
}

/** 남 말풍선 기본 채움 — 표면 두 단 중 **대화 바닥**(`conversationFloor`)에서 더 도드라지는 쪽. 같으면 `surfacePressed`. */
export function otherBubbleFill(
  p: Pick<Palette, 'mode' | 'backdrop' | 'surface' | 'surfacePressed' | 'bg'>,
): string {
  const floor = conversationFloor(p);
  return contrast(p.surface, floor) > contrast(p.surfacePressed, floor)
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

// =============================================================================
// 인용 머리의 색 (#5381 Q4 — 말풍선 **안** 윗칸)
//
// 인용은 말풍선 안 윗칸이 머리다(웹 카드의 윗칸과 같은 문법). 머리의 색은 **말풍선 색에서 유도한다** — 말풍선이 신호색(내 글)이든 표면(남 글)이든,
// 개인 덮어쓰기(`bubbleFor`)로 바뀌었든, 못 보낸 글의 옅은 채움(`failedBubbleFor`)이든 머리는 그 위에서 읽혀야 하기 때문이다.
//
//   fill     말풍선 채움을 **검정 쪽으로 한 단 어둡힌** 띠(시안 `.pq4h`의 `rgba(0,0,0,.2)`, 웹 라이트의 `--quote-fill`도 같은 방향이다).
//            띠가 눈에 보이는 가장 작은 단계(말풍선과 대비 1.08)를 쓴다 — 라이트의 흰 말풍선은 조금만, 다크의 어두운 말풍선은 더 어두워져야 보인다.
//            검정 리터럴을 쓰지 않는다(색은 토큰에서 나온다): OKLCH 밝기를 줄여 어둡힌다.
//   line     머리와 본문 사이의 가는 선: 띠에서 글자색 쪽으로 한 걸음.
//   label·excerpt  남 말풍선은 보조 글자색(`textMuted`, 시안 `--ink-muted`), 내 말풍선은 말풍선 본래 글자색이다(신호색 위에 보조 회색이 읽히지 않는다).
//
// 그 띠 위에서 글자 대비가 4.5:1 에 못 닿거나 띠가 보일 만큼 어두워지지 못하면(검정에 가까운 말풍선) 띠 없이(채움 = 말풍선) 말풍선 본래 글자색으로
// 물러난다 — 대비가 먼저다(`failedBubbleFor` 와 같은 규율). 구분선은 그때도 선다.
// =============================================================================

export interface QuoteHeadColors {
  fill: string;
  line: string;
  label: string;
  excerpt: string;
}

/** 띠를 말풍선보다 어둡게 하는 정도(밝기의 비율). 작은 쪽부터 시도해 띠가 보이는 첫 단계에서 멈춘다. */
const QUOTE_HEAD_WASHES = [0.04, 0.06, 0.08, 0.1, 0.12, 0.16, 0.2] as const;
/** 띠가 말풍선과 갈려 보이는 가장 작은 대비. 시안(다크 ≈1.17 · 라이트 ≈1.08)의 아래쪽이다. */
const QUOTE_HEAD_VISIBLE_STEP = 1.08;
/** 구분선: 띠에서 글자색 쪽으로 가는 정도. */
const QUOTE_HEAD_LINE_MIX = 0.14;

/** 색의 OKLCH 밝기를 `wash` 비율만큼 줄인다 — 채도와 색조는 그대로이고 검정 쪽으로 간다. */
function darken(hex: string, wash: number): string {
  const {L, C, h} = toOklch(hex);
  return fromOklch({L: L * (1 - wash), C, h});
}

export function quoteHeadFor(
  p: Pick<Palette, 'textMuted'>,
  tone: {bg: string; fg: string},
  mine: boolean,
): QuoteHeadColors {
  const inks = mine ? [tone.fg] : [p.textMuted, tone.fg];
  const line = (fill: string): string => mixOklab(fill, tone.fg, QUOTE_HEAD_LINE_MIX);
  const band = QUOTE_HEAD_WASHES.map(wash => darken(tone.bg, wash)).find(
    fill => contrast(fill, tone.bg) >= QUOTE_HEAD_VISIBLE_STEP,
  );
  if (band !== undefined) {
    const ink = inks.find(candidate => contrast(candidate, band) >= BUBBLE_MIN_CONTRAST);
    if (ink !== undefined) return {fill: band, line: line(band), label: ink, excerpt: ink};
  }
  // 띠가 서지 못한다: 말풍선 그대로. 글자는 말풍선 위에서 4.5:1 을 지키는 첫 잉크, 없으면 말풍선 본래 글자색.
  const ink = inks.find(candidate => contrast(candidate, tone.bg) >= BUBBLE_MIN_CONTRAST) ?? tone.fg;
  return {fill: tone.bg, line: line(tone.bg), label: ink, excerpt: ink};
}

// =============================================================================
// 찾은 글자 강조의 색 (#5384 — 대화 안 검색으로 착지한 메시지의 말풍선 **본문 안**)
//
// 결과 목록의 강조(`accentSurfaceStrong` 채움 + 굵게)와 같은 말이되, 말풍선이 어떤 색이든 읽혀야 한다: 남 말풍선(표면)과 평면 행 위에서는 같은 신호색 채움이 그대로 서고,
// 내 말풍선(신호색 채움)에서는 같은 채움이 바탕에 묻히므로 **말풍선 채움을 글자색과 반대로 한 단 옮긴 칩**이 선다 — 밝은 글자(신호색 위 흰 글자)면 어둡게, 어두운 글자면 밝게. 반대로 옮기는
// 이유는 글자 대비가 오히려 **오르기** 때문이다(글자 쪽으로 옮기면 라이트 테마의 흰 글자가 4.5:1 아래로 내려간다 — 실측). 검정·흰 리터럴은 쓰지 않는다(OKLCH 밝기만 옮긴다).
//
// 칩이 말풍선과 갈려 보이는 가장 작은 단계를 쓴다. 어느 후보도 눈에 보이면서 4.5:1 을 지키지 못하면(깨진 개인 색) 채움 없이 굵게만 남는다 — 대비가 먼저다
// (`failedBubbleFor`·`quoteHeadFor` 와 같은 규율). 글자색은 말풍선 본래 잉크를 그대로 이어받는다(중첩 글자가 상속한다).
// =============================================================================

export interface SearchMatchColors {
  /** 칩의 채움. 칩을 세울 수 없으면 `null`(굵게만 남는다). */
  fill: string | null;
}

/** 칩이 말풍선과 갈려 보이는 가장 작은 대비(`QUOTE_HEAD_VISIBLE_STEP` 1.08 보다 한 걸음 더 — 강조는 띠보다 눈에 띄어야 한다). */
const SEARCH_MATCH_VISIBLE_STEP = 1.12;
/** 칩을 말풍선에서 글자 반대쪽으로 옮기는 밝기의 비율. 작은 쪽부터 시도해 보이는 첫 단계에서 멈춘다. */
const SEARCH_MATCH_SHIFTS = [0.1, 0.14, 0.18, 0.22, 0.26, 0.3] as const;

/** 색의 OKLCH 밝기를 `shift`(음수면 어둡게, 양수면 밝게) 비율만큼 옮긴다 — 채도와 색조는 그대로다. */
function shifted(hex: string, shift: number): string {
  const {L, C, h} = toOklch(hex);
  return fromOklch({L: shift < 0 ? L * (1 + shift) : L + (1 - L) * shift, C, h});
}

export function searchMatchFor(
  p: Pick<Palette, 'accentSurfaceStrong'>,
  tone: {bg: string; fg: string},
  mine: boolean,
): SearchMatchColors {
  const lightInk = toOklch(tone.fg).L > toOklch(tone.bg).L;
  // 남 말풍선·평면 행: 결과 목록과 같은 신호색 채움이 먼저다(내 말풍선은 신호색 위라 건너뛴다).
  const candidates = mine ? [] : [p.accentSurfaceStrong];
  for (const shift of SEARCH_MATCH_SHIFTS) candidates.push(shifted(tone.bg, lightInk ? -shift : shift));
  const fill = candidates.find(
    candidate =>
      contrast(candidate, tone.bg) >= SEARCH_MATCH_VISIBLE_STEP &&
      contrast(tone.fg, candidate) >= BUBBLE_MIN_CONTRAST,
  );
  return {fill: fill ?? null};
}
