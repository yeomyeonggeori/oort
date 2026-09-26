// =============================================================================
// 웹 테마 CSS 생성기 (ADR-0189 D5).
//
// 원천(`themes.ts`, `signal.ts`)을 CSS 문자열로 옮기는 순수 함수다. 파일을 쓰는
// 일은 웹이 한다(`clients/web/scripts/gen-palettes.ts`). 웹의 드리프트 시험은
// 이 함수의 결과와 커밋된 `clients/web/src/design/themes/palettes/*.css`를
// 바이트로 비교해, 원천을 고치고 다시 생성하지 않으면 빨개진다.
//
// 모양:
//   - 선택자는 `:root[data-palette="<id>"]`. 스킴은 기존 문법(`data-theme` +
//     `color-scheme`)이 정하므로 두 모드를 `light-dark()` 한 줄에 싣는다.
//   - 바닥은 세 정지점 토큰으로만 싣는다. 그라데이션을 조립하는 일은 셸(DS2-1·6)의
//     몫이다.
//   - 신호 프리셋은 `:root[data-palette="<id>"][data-signal="<preset>"]`이 네 값을
//     다시 묶는다. 커스텀 hex는 루트 인라인 변수로 싣는다(DS2-7).
//   - hex는 소문자로 적는다. 폰·웹의 기존 읽기 정규식이 `#[0-9a-f]{6}`이다.
// =============================================================================

import { normalizeHex } from "./color";
import { SIGNAL_PRESET_IDS, SIGNAL_ROLES, resolvePreset } from "./signal";
import {
  BAND_ROLES,
  CANVAS_STOPS,
  COLOR_ROLES,
  DERIVED_ROLES,
  THEME_IDS,
  THEMES,
  type ThemeId,
} from "./themes";

/** 웹이 커밋하는 파일 이름. 테마를 더하면 파일도 는다. */
export function paletteFileName(theme: ThemeId): string {
  return `${theme}.css`;
}

export const PALETTE_FILES: readonly { theme: ThemeId; file: string }[] = THEME_IDS.map((theme) => ({
  theme,
  file: paletteFileName(theme),
}));

function hexOrRaw(value: string): string {
  return value.startsWith("#") ? normalizeHex(value) : value;
}

function lightDark(light: string, dark: string): string {
  return `light-dark(${hexOrRaw(light)}, ${hexOrRaw(dark)})`;
}

export function renderPaletteCss(theme: ThemeId): string {
  const { light, dark } = THEMES[theme];
  const lines: string[] = [
    "/* GENERATED from packages/momo-core/src/design (ADR-0189 D5). Do not edit by hand.",
    " * Regenerate: npm --prefix clients/web run gen:palettes",
    " * Drift test: clients/web/src/design/themes/palettes/palettes.drift.test.ts */",
    `:root[data-palette="${theme}"] {`,
  ];
  CANVAS_STOPS.forEach((stop, i) => lines.push(`  --${stop}: ${lightDark(light.canvas[i], dark.canvas[i])};`));
  if (light.band && dark.band) {
    for (const role of BAND_ROLES) lines.push(`  --${role}: ${lightDark(light.band[role], dark.band[role])};`);
  }
  for (const role of COLOR_ROLES) lines.push(`  --${role}: ${lightDark(light.color[role], dark.color[role])};`);
  for (const role of DERIVED_ROLES) lines.push(`  --${role}: ${lightDark(light.derived[role], dark.derived[role])};`);
  lines.push(`  --glass: ${lightDark(light.glass, dark.glass)};`);
  lines.push(`  --scrim: ${lightDark(light.scrim, dark.scrim)};`);
  lines.push("}");

  for (const preset of SIGNAL_PRESET_IDS) {
    const l = resolvePreset(preset, theme, "light");
    const d = resolvePreset(preset, theme, "dark");
    if (!l.ok || !d.ok) {
      throw new Error(`preset ${preset} is rejected on ${theme}; the preset list must pass every theme`);
    }
    lines.push("", `:root[data-palette="${theme}"][data-signal="${preset}"] {`);
    for (const role of SIGNAL_ROLES) lines.push(`  --${role}: ${lightDark(l.values[role], d.values[role])};`);
    lines.push("}");
  }
  return lines.join("\n") + "\n";
}
