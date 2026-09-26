import { describe, expect, it } from "vitest";
import { SIGNAL_PRESET_IDS, SIGNAL_ROLES, resolvePreset } from "./signal";
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

// =============================================================================
// 생성 CSS의 **전 값** 대조 (#2735 R1 M1).
//
// 드리프트 시험은 「커밋본 = 생성기 출력」만 보장한다. 여기서는 「생성기 출력 =
// core 값」을 선언 하나하나에 대해 단정한다. 기대값은 생성기를 거치지 않고
// `THEMES`·`resolvePreset`에서 직접 만든다. 선언 집합도 기대 집합과 같아야 한다
// (빠진 줄, 남는 줄, 블록 순서가 바뀐 줄 모두 빨갛다).
// =============================================================================

type Declared = Map<string, Map<string, [string, string]>>;

function parseCss(css: string): Declared {
  const out: Declared = new Map();
  const blockRe = /(:root\[[^{]+)\{([^}]*)\}/g;
  for (const block of css.matchAll(blockRe)) {
    const selector = block[1].trim();
    if (out.has(selector)) throw new Error(`duplicate block ${selector}`);
    const vars = new Map<string, [string, string]>();
    for (const line of block[2].split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m = /^--([a-z-]+): light-dark\((.+)\);$/.exec(line);
      if (!m) throw new Error(`unparsed declaration in ${selector}: ${line}`);
      // 값 안의 rgba(…,…)를 가르지 않도록 괄호 밖 첫 쉼표에서 나눈다.
      let depth = 0;
      let cut = -1;
      for (let i = 0; i < m[2].length; i++) {
        const ch = m[2][i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) {
          cut = i;
          break;
        }
      }
      if (cut < 0) throw new Error(`light-dark without two terms: ${line}`);
      if (vars.has(m[1])) throw new Error(`duplicate --${m[1]} in ${selector}`);
      vars.set(m[1], [m[2].slice(0, cut).trim(), m[2].slice(cut + 1).trim()]);
    }
    out.set(selector, vars);
  }
  return out;
}

const norm = (v: string) => (v.startsWith("#") ? v.toLowerCase() : v);

function expectedFor(theme: (typeof THEME_IDS)[number]): Declared {
  const { light, dark } = THEMES[theme];
  const main = new Map<string, [string, string]>();
  CANVAS_STOPS.forEach((stop, i) => main.set(stop, [norm(light.canvas[i]), norm(dark.canvas[i])]));
  if (light.band && dark.band) {
    for (const r of BAND_ROLES) main.set(r, [norm(light.band[r]), norm(dark.band[r])]);
  }
  for (const r of COLOR_ROLES) main.set(r, [norm(light.color[r]), norm(dark.color[r])]);
  for (const r of DERIVED_ROLES) main.set(r, [norm(light.derived[r]), norm(dark.derived[r])]);
  main.set("glass", [light.glass, dark.glass]);
  main.set("scrim", [light.scrim, dark.scrim]);
  const out: Declared = new Map([[`:root[data-palette="${theme}"]`, main]]);
  for (const preset of SIGNAL_PRESET_IDS) {
    const l = resolvePreset(preset, theme, "light");
    const d = resolvePreset(preset, theme, "dark");
    if (!l.ok || !d.ok) throw new Error(`preset ${preset} rejected on ${theme}`);
    const vars = new Map<string, [string, string]>();
    for (const r of SIGNAL_ROLES) vars.set(r, [norm(l.values[r]), norm(d.values[r])]);
    out.set(`:root[data-palette="${theme}"][data-signal="${preset}"]`, vars);
  }
  return out;
}

const flatten = (d: Declared) =>
  [...d].flatMap(([sel, vars]) => [...vars].map(([name, [l, k]]) => `${sel} --${name}: ${l} | ${k}`));

describe("생성 CSS 전 값 = core 원천 (#2735 R1 M1)", () => {
  it.each(THEME_IDS)("%s: 모든 선언이 원천과 같고 빠지거나 남는 줄이 없다", (theme) => {
    const got = parseCss(renderPaletteCss(theme));
    expect(flatten(got)).toEqual(flatten(expectedFor(theme)));
  });

  it("세 테마를 합쳐 선언 수가 원천에서 센 수와 같다", () => {
    const total = THEME_IDS.reduce((n, t) => n + flatten(parseCss(renderPaletteCss(t))).length, 0);
    // 주 블록: 정지점 3 + 색 22 + 표 밖 5 + 유리·스크림 2 = 32, 노을띠는 띠 3 더
    // 프리셋 블록: 4 × 신호 4 = 16 (테마마다)
    expect(total).toBe(3 * (32 + 16) + 3);
  });

  it("파서가 조용히 비지 않는다", () => {
    expect(() => parseCss(':root[data-palette="x"] {\n  --a: #123456;\n}')).toThrow(/unparsed/);
    expect(parseCss(':root[data-palette="x"] {\n  --a: light-dark(rgba(1,2,3,.5), #abcdef);\n}').get(':root[data-palette="x"]')?.get("a")).toEqual([
      "rgba(1,2,3,.5)",
      "#abcdef",
    ]);
  });
});
