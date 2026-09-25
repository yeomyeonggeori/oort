// =============================================================================
// 디자인 시스템 2.0 토큰 — 폰이 core 원천을 직접 읽는 자리 (ADR-0189 D5).
//
// 값은 `packages/momo-core/src/design/themes.ts` 한 곳에 있고, 폰은 그것을
// `@momo/core/design/*` 경로로 읽는다(Metro `resolveRequest`, jest
// `moduleNameMapper`, tsconfig `paths`가 이미 그 경로를 푼다). 웹처럼 CSS를
// 생성하지 않는다: RN 스타일은 JS 값이라 원천을 그대로 쓰면 된다.
//
// 아직 어느 화면도 이 파일을 읽지 않는다. 폰의 팔레트는 DS2-2(#2714)부터 이
// 표로 옮긴다. 그때까지 `tokens.ts`의 두 팔레트(ADR-0174 값)가 화면을 그린다.
// =============================================================================

import {
  CANVAS_STOPS,
  MODES,
  THEME_IDS,
  THEMES,
  type Mode,
  type ThemeId,
} from '@momo/core/design/themes';

export {
  DEFAULT_THEME_ID,
  MODES,
  THEME_IDS,
  THEME_LABELS,
  THEMES,
  type Mode,
  type ThemeId,
  type ThemeModeTokens,
} from '@momo/core/design/themes';
export {resolveSignal, SIGNAL_PRESETS} from '@momo/core/design/signal';
export {DENSITY, type DensityId} from '@momo/core/design/density';
export {
  MOBILE_APPEARANCE_ENTRY,
  MOBILE_LEGACY_SCHEME_ENTRY,
  readMobileAppearance,
  serializeAppearance,
  type AppearanceV2,
} from '@momo/core/design/appearance';

/**
 * 한 테마 × 모드의 색 역할 전부를 평면 표로(역할 이름은 core 그대로 kebab).
 * 바닥 세 정지점, 띠(있으면), 표의 역할, 표 밖 역할을 한 표에 모은다.
 */
export function ds2Roles(theme: ThemeId, mode: Mode): Readonly<Record<string, string>> {
  const t = THEMES[theme][mode];
  const out: Record<string, string> = {};
  CANVAS_STOPS.forEach((stop, i) => {
    out[stop] = t.canvas[i];
  });
  if (t.band) Object.assign(out, t.band);
  Object.assign(out, t.color, t.derived);
  out.glass = t.glass;
  out.scrim = t.scrim;
  return out;
}

/** 여섯 조합 전부. 시험과 DS2-2가 같은 목록을 돈다. */
export const DS2_COMBOS: ReadonlyArray<readonly [ThemeId, Mode]> = THEME_IDS.flatMap(theme =>
  MODES.map(mode => [theme, mode] as const),
);
