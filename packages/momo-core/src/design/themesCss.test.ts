import { describe, expect, it } from "vitest";
import { SIGNAL_PRESET_IDS, SIGNAL_ROLES } from "./signal";
import { BAND_ROLES, CANVAS_STOPS, COLOR_ROLES, DERIVED_ROLES, THEME_IDS, THEMES } from "./themes";
import { PALETTE_FILES, renderPaletteCss } from "./themesCss";

describe("웹 테마 CSS 생성기", () => {
  it("테마마다 파일 하나", () => {
    expect(PALETTE_FILES.map((f) => f.file)).toEqual(THEME_IDS.map((t) => `${t}.css`));
  });

  it.each(THEME_IDS)("%s: 모든 역할을 light-dark 한 줄로 싣는다", (theme) => {
    const css = renderPaletteCss(theme);
    const roles = [...CANVAS_STOPS, ...COLOR_ROLES, ...DERIVED_ROLES, "glass", "scrim"];
    for (const role of roles) {
      expect(css).toMatch(new RegExp(`\\n  --${role}: light-dark\\([^;]+\\);`));
    }
    const band = THEMES[theme].light.band !== null;
    for (const role of BAND_ROLES) expect([role, css.includes(`  --${role}: `)]).toEqual([role, band]);
  });

  it.each(THEME_IDS)("%s: 원천 값이 그 자리에 들어간다", (theme) => {
    const css = renderPaletteCss(theme);
    const { light, dark } = THEMES[theme];
    expect(css).toContain(
      `  --surface: light-dark(${light.color.surface.toLowerCase()}, ${dark.color.surface.toLowerCase()});`
    );
    expect(css).toContain(`  --canvas-top: light-dark(${light.canvas[0].toLowerCase()}, ${dark.canvas[0].toLowerCase()});`);
  });

  it.each(THEME_IDS)("%s: 프리셋 네 개가 data-signal로 신호 네 값을 다시 묶는다", (theme) => {
    const css = renderPaletteCss(theme);
    for (const preset of SIGNAL_PRESET_IDS) {
      const block = css.split(`:root[data-palette="${theme}"][data-signal="${preset}"] {`)[1]?.split("}")[0] ?? "";
      for (const role of SIGNAL_ROLES) expect([preset, role, block.includes(`  --${role}: light-dark(`)]).toEqual([preset, role, true]);
    }
  });

  it.each(THEME_IDS)("%s: 대문자 hex도 순백·순흑도 없다(웹 pre-flight pure_bw)", (theme) => {
    const css = renderPaletteCss(theme);
    expect(css).not.toMatch(/#[0-9a-f]*[A-F][0-9a-fA-F]*\b/);
    expect(css.toLowerCase()).not.toMatch(/#ffffff|#000000|#fff\b|#000\b/);
  });

  it("결정적이다 — 같은 원천은 같은 바이트", () => {
    for (const theme of THEME_IDS) expect(renderPaletteCss(theme)).toBe(renderPaletteCss(theme));
  });
});
