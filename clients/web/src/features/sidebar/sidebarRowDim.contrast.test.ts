import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blend } from "@momo/core/design/scrim";
import { contrast } from "@momo/core/design/color";
import { CANVAS_STOPS, STANDING_SURFACES, THEMES, type ThemeId } from "@momo/core/design/themes";

// 읽은 채널·DM 줄의 색 (#5775): 이름은 `--ink-muted`(띠 위에서는 `--on-band-muted`), 이름 옆 `@핸들`은 그 색을 한 번 더 옅게
// 섞은 값이다. tokens.css 에서 규칙을 읽어 **모든 테마 × 밝게/어둡게**에서 4.5:1 을 잰다 — 손으로 고른 값이 아니라 출하되는
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
const HANDLE_MIX = /color-mix\(in srgb, var\(--ink-muted\) (\d+)%, transparent\)/.exec(handleRule);

describe("읽은 줄의 CSS 규칙", () => {
  it("이름은 --ink-muted 이고, 핸들은 그것을 옅게 섞어 이름과 다른 색이다", () => {
    expect(nameRule).toContain("color: var(--ink-muted)");
    expect(HANDLE_MIX).not.toBeNull();
    const alpha = Number(HANDLE_MIX?.[1]) / 100;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });
});

const alpha = Number(HANDLE_MIX?.[1] ?? "100") / 100;

interface Case {
  label: string;
  name: string;
  bg: string;
}

function casesFor(theme: ThemeId, mode: "light" | "dark"): Case[] {
  const t = THEMES[theme][mode];
  // 띠가 있는 테마의 사이드바는 띠 위에 서고(`--ink-muted` 가 `--on-band-muted` 로 다시 묶인다), 나머지는 캔버스 위다.
  if (t.band) return [{ label: `${theme} ${mode} 띠`, name: t.band["on-band-muted"], bg: t.band.band }];
  const stops = [...new Set(t.canvas)].map((bg, i, all) => ({ role: all.length === 1 ? "canvas" : CANVAS_STOPS[i], bg }));
  const surfaces = STANDING_SURFACES.map((role) => ({ role, bg: t.color[role] }));
  return [...stops, ...surfaces].map(({ role, bg }) => ({
    label: `${theme} ${mode} ${role}`,
    name: t.color["ink-muted"],
    bg,
  }));
}

const CASES = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
  (["light", "dark"] as const).flatMap((mode) => casesFor(theme, mode))
);

describe("읽은 줄의 대비 — 모든 테마 × 밝게/어둡게", () => {
  it("측정 칸이 비어 있지 않다", () => {
    // 테마 × 모드마다 적어도 한 칸 — 테마를 더하면 이 표가 저절로 는다.
    expect(CASES.length).toBeGreaterThanOrEqual(Object.keys(THEMES).length * 2);
  });

  it.each(CASES.map((c) => [c.label, c] as const))("%s: 이름과 핸들이 4.5:1 이상이고 서로 다른 색이다", (_label, c) => {
    const handle = blend(c.name, c.bg, alpha);
    expect(contrast(c.name, c.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(handle, c.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(handle).not.toBe(c.name);
  });
});
