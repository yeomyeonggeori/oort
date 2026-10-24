import {contrast, parseHex} from '@momo/core/design/color';

import {ds2Radius, type Palette} from '../../design/tokens';

// =============================================================================
// 행 강조 면 (#4300, owner 2026-10-24) — 눌림 · 서 있는 착지 · 물러나는 덮개의 한 모양.
//
// 옛 규칙은 「강조는 행 전체 폭 사각형」이었다(`rowInner` 가 좌우 `SAFE_GUTTER` 를 문
// 채 배경을 입었다). owner 가 「배경 영역이 너무 각지고 패딩이 애매하다」고 짚어 이 근거를
// 대체한다: 강조 면은 **화면 끝에서 띄운 둥근 면**이고, 내용은 면 가장자리에 닿지 않는다
// (Buzz 폰 `MessageLongPressInkWell` — 화면 끝에서 뜨고 모서리가 둥글다).
//
//   바깥 `outer`  면이 화면 끝에서 떨어진 거리. 행 그릇(`styles.row`)의 좌우 마진이다.
//   안쪽 `inner`  면 가장자리에서 아바타·이름·본문까지. 눌림 면인 `rowInner` 의 좌우 패딩이다.
//   모서리        DS2 사다리 `ds2Radius.row`(행 선택·입력). **말풍선 모서리(`bubble.radius`)를
//                 읽지 않는다** — 말풍선을 키운다고 강조 면까지 부풀면 안 된다(#4307).
//
// 관계: `outer + inner = SAFE_GUTTER` — 내용의 x 는 오늘과 같다(`rowAvatarReserve`, 감사
// H-11). 세 겹은 모두 **그릇 상자**(= 이 면)를 같은 좌표로 채운다: 눌림은 그릇 안의
// `rowInner`, 착지는 그릇 자신의 배경, 덮개는 그릇을 꽉 채우는 절대 배치.
// =============================================================================
export const ROW_FACE = {
  outer: 6,
  inner: 10,
  radius: ds2Radius.row,
} as const;

/** 눌림 틴트의 불투명도 — Buzz `highlightColor: primary 10%`. */
export const PRESS_TINT_ALPHA = 0.1;
/** 틴트가 합성된 면이 바닥(bg)에서 이만큼은 갈려야 「눌렸다」가 보인다(실측 최저 1.114 아래). */
export const PRESS_FACE_MIN_CONTRAST = 1.1;

/** `fg` 를 `bg` 위에 `alpha` 로 얹은 불투명 hex. */
export function blendOver(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (f === null || b === null) throw new Error(`not a hex color: ${fg} / ${bg}`);
  return (
    '#' +
    f
      .map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)))
      .map(c => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

export type PressFaceInput = Pick<Palette, 'accent' | 'bg' | 'surface'>;

/**
 * 길게 누르는 동안의 면 색. 기본은 **강조색 10%**(Buzz). 그 면이 바닥에서 안 보이는 테마
 * (`PRESS_FACE_MIN_CONTRAST` 미만)만 예전 표면 단계(`surface`)로 물러난다 — 이슈 #4300.
 * 틴트는 알파 hex(`#rrggbbaa`)라 아래에 깔린 것(바닥·사용자 배경)이 비친다.
 */
export function pressFace(p: PressFaceInput): {color: string; fellBack: boolean} {
  const seen = blendOver(p.accent, p.bg, PRESS_TINT_ALPHA);
  if (contrast(seen, p.bg) >= PRESS_FACE_MIN_CONTRAST) {
    const a = Math.round(PRESS_TINT_ALPHA * 255).toString(16).padStart(2, '0');
    return {color: p.accent + a, fellBack: false};
  }
  return {color: p.surface, fellBack: true};
}
