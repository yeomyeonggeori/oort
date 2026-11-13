import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blend } from "@momo/core/design/scrim";
import { contrast } from "@momo/core/design/color";
import { catalogEntries, deriveCatalogMode } from "@momo/core/design/deriveCatalog";
import { CANVAS_STOPS, STANDING_SURFACES, THEMES, deriveStateSurfaces, type ThemeId, type ThemeModeTokens } from "@momo/core/design/themes";

// 읽은 채널·DM 줄의 색 (#5775): 이름은 `--ink-muted`(띠 위에서는 `--on-band-muted`), 이름 옆 `@핸들`은 그 색을 한 번 더 옅게
// 섞은 값이다. tokens.css 에서 규칙을 읽어 **첫 파티 테마와 카탈로그 파생 테마 전부 × 밝게/어둡게 × 호버·눌림**에서 4.5:1 을 잰다 — 손으로 고른 값이 아니라 출하되는
// CSS 의 숫자다. 이름과 핸들이 같은 색이 아니라는 것도 같은 표에서 잰다.

const css = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const TEXT_MIN = 4.5;

function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `tokens.css 에 ${selector} 규칙이 있다`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

const nameRule = ruleBody("&[data-dim] {");
const handleRule = ruleBody("&[data-dim] [data-row-handle] {");
const HANDLE_MIX = /color-mix\(in srgb, var\(--ink-muted\) (\d+)%, var\(--ink\)\)/.exec(handleRule);

describe("읽은 줄의 CSS 규칙", () => {
  it("이름은 --ink-muted 이고, 핸들은 그것을 옅게 섞어 이름과 다른 색이다", () => {
    expect(nameRule).toContain("color: var(--ink-muted)");
    expect(HANDLE_MIX).not.toBeNull();
    const mixed = Number(HANDLE_MIX?.[1]) / 100;
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(1);
  });
});

const alpha = Number(HANDLE_MIX?.[1] ?? "100") / 100;

interface Case {
  label: string;
  name: string;
  /** 사이드바 범위의 `--ink`(띠 위에서는 `--on-band`). 핸들은 이름 색에 이것을 조금 섞는다. */
  ink: string;
  bg: string;
}

/**
 * 한 테마·모드에서 읽은 줄이 서는 바닥들. 사이드바는 띠가 있는 테마에서는 띠 위(`--ink-muted` 가 `--on-band-muted` 로 다시
 * 묶이고, 호버·눌림 채움은 `--band-fill`·`--band-fill-strong` = on-band 를 10%·16% 섞은 면)에, 나머지는 캔버스 위(호버·눌림은
 * `--surface-hover`·`--surface-pressed`)에 선다.
 */
function casesFor(label: string, t: ThemeModeTokens, mode: "light" | "dark"): Case[] {
  if (t.band) {
    const band = t.band.band;
    const name = t.band["on-band-muted"];
    const ink = t.band["on-band"];
    return [
      { label: `${label} 띠`, name, ink, bg: band },
      { label: `${label} 띠 호버`, name, ink, bg: blend(ink, band, 0.1) },
      { label: `${label} 띠 눌림`, name, ink, bg: blend(ink, band, 0.16) },
    ];
  }
  const stops = [...new Set(t.canvas)].map((bg, i, all) => ({ role: all.length === 1 ? "canvas" : CANVAS_STOPS[i], bg }));
  const state = deriveStateSurfaces(t.color.surface, t.color.sheet, mode);
  const surfaces = [
    ...STANDING_SURFACES.map((role) => ({ role: role as string, bg: t.color[role] })),
    { role: "surface-hover", bg: state.hover },
    { role: "surface-pressed", bg: state.pressed },
  ];
  return [...stops, ...surfaces].map(({ role, bg }) => ({ label: `${label} ${role}`, name: t.color["ink-muted"], ink: t.color.ink, bg }));
}

const MODES_ = ["light", "dark"] as const;
const FIRST_PARTY = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
  MODES_.flatMap((mode) => casesFor(`${theme} ${mode}`, THEMES[theme][mode], mode))
);
// 카탈로그(씨앗에서 파생한 테마 전부). 모드가 하나뿐인 항목은 그 모드만 있다.
const CATALOG = catalogEntries().flatMap((entry) =>
  MODES_.flatMap((mode) => {
    const derived = deriveCatalogMode(entry.id, mode);
    return derived ? casesFor(`catalog:${entry.id} ${mode}`, derived.tokens, mode) : [];
  })
);
const CASES = [...FIRST_PARTY, ...CATALOG];

describe("읽은 줄의 대비 — 첫 파티 테마 × 카탈로그 파생 테마, 밝게/어둡게, 호버·눌림 포함", () => {
  it("측정 칸이 비어 있지 않다", () => {
    // 첫 파티 테마 × 모드마다 적어도 한 칸, 카탈로그 항목마다 적어도 한 칸 — 테마를 더하면 이 표가 저절로 는다.
    expect(FIRST_PARTY.length).toBeGreaterThanOrEqual(Object.keys(THEMES).length * 2);
    expect(CATALOG.length).toBeGreaterThanOrEqual(catalogEntries().length);
  });

  it("이름과 핸들이 모든 칸에서 4.5:1 이상이고 서로 다른 색이다", () => {
    const failures = CASES.flatMap((c) => {
      const handle = blend(c.name, c.ink, alpha);
      const problems: string[] = [];
      const nameRatio = contrast(c.name, c.bg);
      const handleRatio = contrast(handle, c.bg);
      if (nameRatio < TEXT_MIN) problems.push(`이름 ${nameRatio.toFixed(2)}`);
      if (handleRatio < TEXT_MIN) problems.push(`핸들 ${handleRatio.toFixed(2)}`);
      if (handle === c.name) problems.push("핸들 = 이름 색");
      return problems.length > 0 ? [`${c.label}: ${problems.join(", ")}`] : [];
    });
    expect(failures).toEqual([]);
  });
});
