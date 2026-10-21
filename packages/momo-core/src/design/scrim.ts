// =============================================================================
// 배경 위 반투명 면(scrim)의 산수 — ADR-0189 증보 2 (#3907), core 이전 AP-1c (#4187).
//
// 사진·바탕화면 위에 바닥색 한 겹을 얹을 때, 그 위의 글자는 **어떤 그림이 와도** 읽혀야
// 한다. 그림은 우리가 못 보는 입력이므로 보장은 최악 입력으로 한다. 데스크탑 유리 배경도
// 같은 문제다: 창 뒤 데스크탑은 우리가 못 보는 그림이고, 유리는 바닥색 한 겹이다.
//
// ## 왜 순흑·순백 둘이면 되는가
//
// scrim 은 바닥색(`canvas-mid`) 한 겹을 불투명도 α 로 그림 위에 얹는다. 합성 채널값은
// `α·바닥 + (1−α)·픽셀` 이고 픽셀의 각 채널에 대해 **증가**한다. 상대휘도는 채널의
// 증가함수이고 대비비는 고정된 글자색에 대해 배경 휘도의 단조함수다. 그래서 어떤
// 사진·잡음·패턴이어도 합성 휘도는 [순흑 합성, 순백 합성] 안에 있고, 글자 대비의 최악은
// 그 두 끝 중 하나다. 라이트(어두운 글자)는 순흑 쪽이, 다크(밝은 글자)는 순백 쪽이
// 최악이다. 시험은 두 끝을 모두 잰다.
//
// ## 불투명도는 눈대중이 아니라 이 산수로 정한 값이다
//
// `BACKDROP_SCRIM_ALPHA` 는 첫 파티 여섯 조합(3 테마 × 2 모드)에서 본문 잉크(`ink`)가
// 최악 합성 위에서 7:1(AAA)이 되는 **최소** 불투명도를 모드별로 올림한 값이다
// (`scrim.test.ts` 가 같은 산수로 다시 구해 대조한다). 4.5 가 아니라 7 인 이유: 보조·강조
// 글자는 잉크보다 연하게 서야 위계가 남는데, 잉크가 4.5 에서 끝나면 그 아래 어떤 색도 4.5 를
// 못 넘는다 — 위계가 사라진다. 잉크에 여유를 두면 그 사이에 보조·강조 색이 4.5 로 설 자리가
// 생긴다(`fitForeground`).
//
// 카탈로그·가져온 테마는 이 두 토큰으로 묶이지 않는다. 테마·모드마다 하한이 다르므로
// (`scrimFloor`) 소비자가 자기 하한을 구해 쓴다.
//
// ## 출처와 폰 사본
//
// `clients/mobile/src/design/background/scrim.ts`(#3907)를 옮긴 사본이다. 우리 코드의
// 이전이라 외부 귀속은 없다. 폰은 AP-6 이 import 를 이 파일로 바꾸고 폰 쪽을 지우기 전까지
// 자기 사본을 쓴다 — 그때까지 두 사본의 산수는 같아야 한다. 사본과 다른 곳은 셋뿐이다.
//   1. import 가 `@momo/core/design/color` 가 아니라 `./color` 다.
//   2. `Mode` 를 따로 두지 않고 `themes.ts` 의 것을 쓴다.
//   3. `fitForeground` 의 「잘못된 hex 면 입력을 그대로 돌려준다」 가지를 뺐다. 앞줄의
//      `normalizeHex` 가 먼저 던지므로 닿은 적이 없는 줄이다(잘못된 입력은 던진다 —
//      `color.ts` 머리말의 약속이고 `scrim.test.ts` 가 못 박는다).
// 더해진 것은 `scrimFloor` 하나다.
//
// 순수 함수만 둔다(UI·플랫폼 API·런타임 의존 없음 — `scripts/purity.mjs`).
// =============================================================================

import { contrast, fromOklch, normalizeHex, toOklch } from "./color";
import type { Mode, ThemeModeSource } from "./themes";

/** 모드별 scrim 불투명도 토큰. 값의 근거는 파일 머리 주석과 `scrim.test.ts`. */
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
/**
 * 보정이 하한에서 멈추지 않게 얹는 여유. 보장은 평면 순흑·순백 기준이고 실제 사진은 글자 가장자리
 * 주변 대비가 흔들린다(리뷰 M6) — 하한을 정확히 넘는 색은 여유가 없다.
 */
export const FIT_MARGIN = 0.3;

const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);

/**
 * `overlay` 를 불투명도 `alpha` 로 `base` 위에 얹은 합성(sRGB 값 선형 혼합 — RN 과 CSS 가 그리는
 * 방식 그대로다). 알파 합성은 감마 공간에서 일어난다.
 */
export function blend(overlay: string, base: string, alpha: number): string {
  const out = [0, 1, 2].map((i) =>
    Math.round(alpha * channel(overlay, i) + (1 - alpha) * channel(base, i))
      .toString(16)
      .padStart(2, "0")
  );
  return `#${out.join("")}`;
}

function blendRgb(overlay: string, base: readonly [number, number, number], alpha: number): string {
  const out = base.map((value, i) =>
    Math.round(alpha * channel(overlay, i) + (1 - alpha) * value)
      .toString(16)
      .padStart(2, "0")
  );
  return `#${out.join("")}`;
}

/** 최악 입력 둘 — 순흑 사진 위 합성과 순백 사진 위 합성. 순흑·순백은 채널값으로 적는다(색 리터럴은 토큰 표에만 둔다). */
export function worstCaseBackdrops(canvas: string, alpha: number): readonly [string, string] {
  return [blendRgb(canvas, [0, 0, 0], alpha), blendRgb(canvas, [255, 255, 255], alpha)];
}

/** `#rrggbbaa` — scrim 면의 색. 바닥색에 알파를 단다. */
export function scrimColor(canvas: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${normalizeHex(canvas)}${a}`;
}

/** 최소 대비를 두 끝 모두에서 만족하는가. */
export function holdsOnBoth(fg: string, hosts: readonly string[], min: number): boolean {
  return hosts.every((host) => contrast(fg, host) >= min);
}

/**
 * 잉크가 `min` 을 최악 합성 두 끝 위에서 지키는 **최소** 불투명도(0.01 단위 올림).
 * 토큰을 정하고 시험이 토큰을 대조할 때 같은 함수를 쓴다.
 *
 * 1.00 에서도 못 지키면 1 을 돌려준다(없는 답을 만들지 않고 가장 두꺼운 값으로 닫는다).
 */
export function minimumScrimAlpha(canvas: string, ink: string, min: number): number {
  for (let step = 0; step <= 100; step += 1) {
    const alpha = step / 100;
    if (holdsOnBoth(ink, worstCaseBackdrops(canvas, alpha), min)) return alpha;
  }
  return 1;
}

/**
 * 한 테마 × 모드에서 바닥색 한 겹(scrim 또는 유리 색조)이 가져야 하는 불투명도 **하한** —
 * 글자 `ink` 가 최악 합성(순흑·순백 그림 위) 두 끝에서 모두 `min` 대비를 지키는 최소값
 * (0.01 단위 올림). 유리 슬라이더의 아래 끝과 배경화면 scrim 의 두께가 이 값에서 나온다.
 *
 * 면의 색은 바닥의 가운데 정지점(`canvas[1]`, 역할 `canvas-mid`)이다. 폰의 scrim 이 그 한 색을
 * 깔고(`DS2_ROLE_MAP.bg`) ADR 증보 2 의 표도 그 값이다. 평면 테마(흑연·노을띠·카탈로그)는 세
 * 정지점이 같지만 새벽하늘은 위·아래 정지점의 하한이 가운데와 최대 0.02 다르다(다크 0.78 /
 * 0.76 / 0.74). 바닥 그라데이션 자체를 색조로 쓰는 면은 정지점마다 `minimumScrimAlpha` 를
 * 구해 큰 쪽을 쓴다.
 *
 * `tokens` 는 `canvas` 만 읽으므로 첫 파티의 `THEMES[t][m]` 도, 카탈로그·가져온 테마에서 파생한
 * 토큰도 그대로 받는다. `ink` 를 따로 받는 것은 본문 잉크(`min` 7)뿐 아니라 다른 글자(`ink-muted`
 * 4.5 등)도 같은 자로 재기 위해서다. 띠 위 글자는 호스트가 바닥이 아니라 띠이므로
 * `minimumScrimAlpha(띠, on-band, min)` 를 직접 부른다.
 *
 * 1 은 두 경우를 함께 뜻한다: 완전 불투명(1.00)이어야 `min` 이 나오거나, 완전 불투명으로도
 * `min` 이 안 나온다. 어느 쪽이든 그림을 비치게 할 수 없으므로 소비자는 「쓸 수 없음」으로
 * 읽는다.
 */
export function scrimFloor(tokens: Pick<ThemeModeSource, "canvas">, ink: string, min: number): number {
  return minimumScrimAlpha(tokens.canvas[1], ink, min);
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
  mode: Mode
): string {
  const start = normalizeHex(fg);
  if (holdsOnBoth(start, hosts, min)) return start;
  const { L, C, h } = toOklch(start);
  const direction = mode === "light" ? -1 : 1;
  let candidate = start;
  for (let next = L + direction * L_STEP; next >= L_FLOOR && next <= L_CEIL; next += direction * L_STEP) {
    candidate = fromOklch({ L: next, C, h });
    if (holdsOnBoth(candidate, hosts, min)) return candidate;
  }
  return candidate;
}
