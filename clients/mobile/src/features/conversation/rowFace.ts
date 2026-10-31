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
//
// 색(owner 2026-10-31, #4949): 착지 면은 **경고색(`warn`) 10% 이하의 알파 면**이고 테두리가 없다
// (`landedFace`). 옛 착지는 `warnSurface` + `warnBorder` 1px 였다 — 알림으로 들어올 때 테두리가
// 진해서 어색하다는 지적으로 테두리를 없애고, 면도 옅게 했다. 뜻은 그대로다: 「여기를 보라」는
// `warn` 이 맡고 `accent`(「내가 한 것」)는 입지 않는다(`conversationHygiene`).
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

/**
 * 서 있는 착지 면의 불투명도 — 25/255(≈9.8%). owner 의 상한은 「경고색 10% 이하」(2026-10-31, #4949)이고
 * hex 한 칸으로 옮기면 26/255(10.2%)가 되어 상한을 넘으므로 한 칸 내렸다. 값은 87개 테마 조합에서 쟀다:
 * 면이 바닥에서 1.10:1 이상 갈리고(테두리 없이 면만으로 선다), 강조색 말풍선과 2.9:1 이상 갈린다.
 */
export const LANDED_TINT_ALPHA = 25 / 255;

/** 시험이 `landedFace` 의 알파가 넘지 않음을 재는 상한 — owner 「강조색 10% 이하」. */
export const LANDED_TINT_MAX_ALPHA = 0.1;

/**
 * 서 있는 착지의 면 색 — `warn` 위의 알파 hex(`#rrggbbaa`). 그릇의 배경이자 물러나는 덮개의 색이고,
 * **테두리는 없다**. 알파라 아래에 깔린 것(바닥·사용자 배경)이 비친다. `warnSurface` 는 칩들의 채움이라
 * 여기서 쓰지 않는다(다크에서 바닥 대비 1.30~1.46:1 로 진했고 라이트에서는 1.02~1.04:1 로 안 보여 테두리가 필요했다).
 */
export function landedFace(p: Pick<Palette, 'warn'>): string {
  return p.warn + Math.round(LANDED_TINT_ALPHA * 255).toString(16).padStart(2, '0');
}
