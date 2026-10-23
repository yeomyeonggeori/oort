import { parseHex } from "../../design/color";
import { AVATAR_BACKGROUNDS, type AvatarBackground, type AvatarBackgroundId } from "./avatarPalette";

// =============================================================================
// 아바타 판정: 그려진 글리프가 이 배경 위에서 읽히는가 (#4261).
//
// 이슈의 규칙은 「이모지 대 배경 3:1 이상, 정해진 팔레트 + 자유 색은 판정 통과 때만 저장」이다.
// 이모지와 코메토는 **여러 색의 그림**이라 「그림의 색」이 하나가 아니다. 그래서 이 파일은 색을 하나로
// 줄이지 않고 **그려진 픽셀 전부**를 잰다. (이름의 첫 글자는 굽지 않으므로 글자 판정은 없다: 이름을 바꾸면
// 굽은 글자가 낡는다. 기본 이니셜은 토큰 쌍 `--avatar-N` 대 `--avatar-N-soft` 로 그려지고, 그 대비는 웹
// `tokens.contrast.test.ts` 가 4.5:1 이상으로 잰다.)
//
//   · 불투명한 픽셀(알파 128 이상)만 본다. 가장자리의 반투명 띠는 배경과 섞이는 자리라 빼고,
//     면적 대부분을 이루는 몸통만 센다.
//   · 한 픽셀이 배경과 3:1(WCAG 1.4.11 비텍스트 대비)을 넘으면 「보이는」 픽셀이다.
//   · 보이는 픽셀이 불투명 면적의 절반 이상이면 통과다(`AVATAR_MIN_VISIBLE_SHARE`).
//
// 왜 픽셀 면적인가. 글리프의 평균 색·중앙값은 양쪽에서 틀린다: 노랑 절반·검정 절반인 벌(🐝)은
// 평균이 중간 회색이라 어떤 배경에서도 「안 보임」으로 읽히고, 흰 구름(☁️)은 한 색이라 평균이 맞다.
// 면적 비율은 둘 다 맞게 답하고, 어느 쪽 극단(연한 배경 위 밝은 그림, 진한 배경 위 어두운 그림)이
// 묻히는지도 가린다. 반대로 한 점이라도 3:1을 넘으면 통과로 치면(최댓값) 가장 어두운 눈 한 점이
// 노란 얼굴 전체를 통과시킨다.
//
// 절반 기준은 실측으로 골랐다(2026-10-23, 자주 쓰는 이모지 74종 × 팔레트 15색 × Chromium·WebKit).
// 0.5에서는 모든 이모지가 고를 수 있는 색을 하나 이상 가지고, 0.6에서는 벌·과녁·공구·벌레 네 개가
// 하나도 못 가졌다(양분된 그림은 어느 쪽에서도 60%를 못 넘는다). 코메토(여섯 표정 × 팔레트 열다섯 색)는 진한
// 배경에서 0.70~0.76, 연한 배경에서 0.24~0.25라 기준을 0.3~0.7 어디에 두어도 같게 갈린다.
//
// 이 판정은 **글리프를 그린 쪽의 픽셀**을 받는다: 이모지는 플랫폼의 글꼴로 그려지므로 같은 이모지라도
// 기기마다 픽셀이 다르다. 그래서 판정은 문자열(이모지 코드)이 아니라 이 기기가 실제로 그린 그림을 본다.
// 그리고 통과한 그림이 곧 올라가는 PNG라(`avatarEditor.ts` 의 `composeAvatarPng`) 보이는 것과 판정한
// 것이 같다.
// =============================================================================

/** WCAG 2.1 1.4.11 비텍스트 대비. 이슈의 「3:1 이상」. */
export const AVATAR_MIN_CONTRAST = 3;

/** 불투명 면적 중 배경과 3:1을 넘는 면적의 하한(위 실측). */
export const AVATAR_MIN_VISIBLE_SHARE = 0.5;

/** 표본 전체 중 불투명 면적이 이만큼도 안 되면 글리프가 그려지지 않은 것이다(글꼴에 없는 이모지 등). */
export const AVATAR_MIN_INK_AREA = 0.005;

/** 이 알파(0~255) 이상이면 불투명한 몸통으로 센다. */
export const AVATAR_OPAQUE_ALPHA = 128;

export type GlyphVisibility =
  | { readonly ok: true; readonly share: number }
  | {
      readonly ok: false;
      /**
       * `blank`: 그려진 것이 거의 없다. `low-contrast`: 그려졌지만 이 배경에 묻힌다.
       * `invalid-color`: 배경이 `#rrggbb` 가 아니다(입력 단계에서 걸러야 하는 일이라 판정은 막기만 한다).
       */
      readonly reason: "blank" | "low-contrast" | "invalid-color";
      readonly share: number;
    };

/** sRGB 8비트 채널 → 선형 값. `design/color.ts` 의 `luminance` 와 같은 식이고, 시험이 두 길을 대조한다. */
const LINEAR: readonly number[] = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function channel(value: number): number {
  const rounded = Math.round(value);
  return LINEAR[rounded < 0 ? 0 : rounded > 255 ? 255 : rounded] ?? 0;
}

function backgroundLuminance(bg: string): number | null {
  const rgb = parseHex(bg);
  if (rgb === null) return null;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/**
 * 그려진 글리프(RGBA, 곧은 알파)가 `bg`(`#rrggbb`) 위에서 읽히는가.
 *
 * `pixels` 는 **배경 없이** 투명한 층에 글리프만 그린 표본이다. 호스트가 premultiplied 로 읽었다면
 * 호스트가 곧은 알파로 풀어서 넘긴다(여기서 되돌리지 않는다: 어느 쪽인지 이 함수는 알 수 없다).
 */
export function judgeGlyphVisibility(pixels: ArrayLike<number>, bg: string): GlyphVisibility {
  const bgLuminance = backgroundLuminance(bg);
  if (bgLuminance === null) return { ok: false, reason: "invalid-color", share: 0 };
  const total = Math.floor(pixels.length / 4);
  let opaque = 0;
  let visible = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if ((pixels[index + 3] ?? 0) < AVATAR_OPAQUE_ALPHA) continue;
    opaque += 1;
    const luminance =
      0.2126 * channel(pixels[index] ?? 0) +
      0.7152 * channel(pixels[index + 1] ?? 0) +
      0.0722 * channel(pixels[index + 2] ?? 0);
    const hi = luminance > bgLuminance ? luminance : bgLuminance;
    const lo = luminance > bgLuminance ? bgLuminance : luminance;
    if ((hi + 0.05) / (lo + 0.05) >= AVATAR_MIN_CONTRAST) visible += 1;
  }
  if (total === 0 || opaque / total < AVATAR_MIN_INK_AREA) {
    return { ok: false, reason: "blank", share: 0 };
  }
  const share = visible / opaque;
  return share >= AVATAR_MIN_VISIBLE_SHARE
    ? { ok: true, share }
    : { ok: false, reason: "low-contrast", share };
}

/**
 * 팔레트 열다섯 색 각각의 판정. 편집기가 칩을 흐리게 하고, 사용자가 건드리지 않은 배경을 통과하는
 * 첫 색으로 옮기는 데 쓴다. 표본 하나를 열다섯 번 재므로 글리프를 다시 그리지 않는다.
 */
export function judgePalette(
  pixels: ArrayLike<number>
): Readonly<Record<AvatarBackgroundId, GlyphVisibility>> {
  const result = {} as Record<AvatarBackgroundId, GlyphVisibility>;
  for (const entry of AVATAR_BACKGROUNDS) result[entry.id] = judgeGlyphVisibility(pixels, entry.hex);
  return result;
}

/** 팔레트 순서에서 처음으로 통과하는 색. 하나도 없으면 `null`(그림이 비었거나 모든 색에 묻힌다). */
export function firstVisibleBackground(pixels: ArrayLike<number>): AvatarBackground | null {
  for (const entry of AVATAR_BACKGROUNDS) {
    if (judgeGlyphVisibility(pixels, entry.hex).ok) return entry;
  }
  return null;
}
