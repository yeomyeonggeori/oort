import {contrast, fromOklch, normalizeHex, parseHex, toOklch} from '@momo/core/design/color';

// =============================================================================
// 배경 위 반투명 면(scrim)의 산수 — ADR-0189 증보 2 (#3907).
//
// 홈·대화 바닥 뒤에 사진이 깔리면 그 위의 글자는 **어떤 사진이 와도** 읽혀야 한다.
// 사진은 우리가 못 보는 입력이므로 보장은 최악 입력으로 한다.
//
// ## 왜 순흑·순백 둘이면 되는가
//
// scrim 은 바닥색(`canvas-mid`) 한 겹을 불투명도 α 로 사진 위에 얹는다. 합성 채널값은
// `α·바닥 + (1−α)·픽셀` 이고 픽셀의 각 채널에 대해 **증가**한다. 상대휘도는 채널의
// 증가함수이고 대비비는 고정된 글자색에 대해 배경 휘도의 단조함수다. 그래서 어떤
// 사진·잡음·패턴이어도 합성 휘도는 [순흑 합성, 순백 합성] 안에 있고, 글자 대비의 최악은
// 그 두 끝 중 하나다. 라이트(어두운 글자)는 순흑 쪽이, 다크(밝은 글자)는 순백 쪽이
// 최악이다. 시험은 두 끝을 모두 잰다.
//
// ## 불투명도는 눈대중이 아니라 이 산수로 정한 값이다
//
// `BACKDROP_SCRIM_ALPHA` 는 여섯 조합(3 테마 × 2 모드)에서 본문 잉크(`ink`)가 최악
// 합성 위에서 7:1(AAA)이 되는 **최소** 불투명도를 모드별로 올림한 값이다
// (`__tests__/backdropScrim.test.ts` 가 같은 산수로 다시 구해 대조한다). 4.5 가 아니라
// 7 인 이유: 보조·강조 글자는 잉크보다 연하게 서야 위계가 남는데, 잉크가 4.5 에서
// 끝나면 그 아래 어떤 색도 4.5 를 못 넘는다 — 위계가 사라진다. 잉크에 여유를 두면 그
// 사이에 보조·강조 색이 4.5 로 설 자리가 생긴다(`fitForeground`).
// =============================================================================

export type Mode = 'light' | 'dark';

/** 모드별 scrim 불투명도 토큰. 값의 근거는 파일 머리 주석과 `backdropScrim.test.ts`. */
export const BACKDROP_SCRIM_ALPHA: Readonly<Record<Mode, number>> = {
  light: 0.7,
  dark: 0.78,
};

/** 잉크가 최악 합성 위에서 지켜야 하는 대비(AAA). */
export const INK_MIN_ON_BACKDROP = 7;
/** 보조·강조 글자(글자로 서는 색 역할). */
export const TEXT_MIN_ON_BACKDROP = 4.5;
/** 글자 없는 표식(아이콘·채움)의 하한. */
export const NON_TEXT_MIN_ON_BACKDROP = 3;

const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);

/**
 * `overlay` 를 불투명도 `alpha` 로 `base` 위에 얹은 합성(sRGB 값 선형 혼합 — RN 이 그리는
 * 방식 그대로다). 알파 합성은 감마 공간에서 일어난다.
 */
export function blend(overlay: string, base: string, alpha: number): string {
  const out = [0, 1, 2].map(i =>
    Math.round(alpha * channel(overlay, i) + (1 - alpha) * channel(base, i))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${out.join('')}`;
}

/** 최악 입력 둘 — 순흑 사진 위 합성과 순백 사진 위 합성. */
export function worstCaseBackdrops(canvas: string, alpha: number): readonly [string, string] {
  return [blend(canvas, '#000000', alpha), blend(canvas, '#ffffff', alpha)];
}

/** `#rrggbbaa` — scrim 면의 색. 바닥색에 알파를 단다. */
export function scrimColor(canvas: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${normalizeHex(canvas)}${a}`;
}

/** 최소 대비를 두 끝 모두에서 만족하는가. */
export function holdsOnBoth(fg: string, hosts: readonly string[], min: number): boolean {
  return hosts.every(host => contrast(fg, host) >= min);
}

/**
 * 잉크가 `min` 을 최악 합성 두 끝 위에서 지키는 **최소** 불투명도(0.01 단위 올림).
 * 토큰을 정하고 시험이 토큰을 대조할 때 같은 함수를 쓴다.
 */
export function minimumScrimAlpha(canvas: string, ink: string, min: number): number {
  for (let step = 0; step <= 100; step += 1) {
    const alpha = step / 100;
    if (holdsOnBoth(ink, worstCaseBackdrops(canvas, alpha), min)) return alpha;
  }
  return 1;
}

const L_FLOOR = 0.12;
const L_CEIL = 0.97;
const L_STEP = 0.0025;

/**
 * 글자·표식 색을 scrim 최악 합성 위에서 `min` 대비가 되도록 **명도만** 옮긴다. 색상각과
 * 채도는 그대로다(채도는 sRGB 밖에서만 `fromOklch` 가 양보한다). 라이트는 더 어둡게,
 * 다크는 더 밝게만 간다 — 반대로 가면 합성이 더 어려워지는 방향이다.
 *
 * 이미 통과하면 입력 그대로다. 명도 끝(`L_FLOOR`/`L_CEIL`)까지 가도 못 넘으면 끝값을
 * 돌려준다: 그 경우는 scrim 토큰이 너무 약하다는 뜻이고 시험이 모든 조합에서 이를 잡는다.
 */
export function fitForeground(
  fg: string,
  hosts: readonly string[],
  min: number,
  mode: Mode,
): string {
  const start = normalizeHex(fg);
  if (!parseHex(start)) return start;
  if (holdsOnBoth(start, hosts, min)) return start;
  const {L, C, h} = toOklch(start);
  const direction = mode === 'light' ? -1 : 1;
  let candidate = start;
  for (let next = L + direction * L_STEP; next >= L_FLOOR && next <= L_CEIL; next += direction * L_STEP) {
    candidate = fromOklch({L: next, C, h});
    if (holdsOnBoth(candidate, hosts, min)) return candidate;
  }
  return candidate;
}
