import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, oklabDistance } from "@momo/core/design/color";
import { THEMES, type Mode, type ThemeId } from "@momo/core/design/themes";

// =============================================================================
// ADR-0189 — 문서 `docs/design-system/themes-2.0.md`의 표와 core 원천을 대조한다.
//
// §2(값)은 한 글자씩 같아야 한다. §3(대비 실측)과 OKLab 거리 표는 core 값으로
// 다시 계산해 문서의 소수 둘째(거리는 셋째) 자리와 맞아야 한다. 문서는 core를
// 옮겨 적은 것이라(문서 머리말: 「둘이 어긋나면 core가 이긴다」) 어긋나면 문서를
// 다시 적는다. 이 시험은 그 어긋남을 조용히 두지 않는다.
//
// 문서 §3의 행 전부가 교정점 구실도 한다. 대비 계산식이 틀어지면 이 파일의
// 수십 행이 한꺼번에 빨개진다.
// =============================================================================

const DOC = readFileSync(
  new URL("../../../../../../docs/design-system/themes-2.0.md", import.meta.url),
  "utf8"
);

/** 표의 열 순서(문서 §2·§3 머리행 그대로). */
const COLUMNS: [ThemeId, Mode][] = [
  ["dawnsky", "light"],
  ["dawnsky", "dark"],
  ["graphite", "dark"],
  ["graphite", "light"],
  ["noeul", "light"],
  ["noeul", "dark"],
];

function section(title: string): string {
  const start = DOC.indexOf(title);
  if (start < 0) throw new Error(`section not found: ${title}`);
  const next = DOC.indexOf("\n## ", start + title.length);
  return DOC.slice(start, next < 0 ? undefined : next);
}

function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

const HEX = /#[0-9A-Fa-f]{6}/g;

describe("§2 값 = core THEME 원천", () => {
  const table = rows(section("## 2. 값"));
  const byRole = new Map(table.map((r) => [r[0].replace(/`/g, ""), r.slice(1)]));

  it("문서 표의 역할 행을 찾았다(읽기 경로가 조용히 비지 않는다)", () => {
    expect(table.length).toBe(26);
  });

  it.each(COLUMNS.map(([t, m], i) => [t, m, i] as const))("%s %s", (theme, mode, i) => {
    const tokens = THEMES[theme][mode];
    const doc = (role: string) => {
      const cell = byRole.get(role)?.[i];
      if (cell === undefined) throw new Error(`doc row missing: ${role}`);
      return cell;
    };
    const canvas = doc("canvas").match(HEX) ?? [];
    const expectedCanvas = canvas.length === 1 ? [canvas[0], canvas[0], canvas[0]] : canvas;
    expect(expectedCanvas).toEqual([...tokens.canvas]);
    for (const role of ["band", "on-band", "on-band-muted"] as const) {
      const cell = doc(role);
      expect([role, cell === "—" ? null : cell.replace(/`/g, "")]).toEqual([role, tokens.band?.[role] ?? null]);
    }
    for (const [role, value] of Object.entries(tokens.color)) {
      expect([role, doc(role).replace(/`/g, "")]).toEqual([role, value]);
    }
  });
});

describe("§3 대비 실측 = core 값으로 다시 잰 값", () => {
  const measured = rows(section("## 3. 대비 실측")).filter((r) => r[0].includes(" / "));

  it("문서 표의 쌍 행을 찾았다", () => {
    expect(measured.length).toBe(54); // 11전경 × 4면 + 띠 3 + 채움 7
  });

  const cases = measured.flatMap((r) => {
    const [fgRole, bgRaw] = r[0].split(" / ").map((s) => s.replace(/`/g, "").trim());
    return COLUMNS.flatMap(([theme, mode], i) => {
      const cell = r[2 + i];
      return cell === "—" ? [] : [[`${theme} ${mode} ${fgRole} / ${bgRaw}`, theme, mode, fgRole, bgRaw, Number(cell)] as const];
    });
  });

  it("쌍 × 조합 수", () => {
    // 51행 × 6 + 띠 3행 × 노을띠 2 = 312
    expect(cases.length).toBe(312);
  });

  it.each(cases)("%s", (_n, theme, mode, fgRole, bgRaw, expected) => {
    const t = THEMES[theme][mode];
    const lookup = (role: string): string => {
      if (role in t.color) return t.color[role as keyof typeof t.color];
      if (t.band && role in t.band) return t.band[role as keyof typeof t.band];
      throw new Error(`unknown role ${role}`);
    };
    const fg = lookup(fgRole);
    const got = bgRaw.startsWith("canvas")
      ? Math.min(...t.canvas.map((bg) => contrast(fg, bg)))
      : contrast(fg, lookup(bgRaw));
    expect(Math.abs(got - expected)).toBeLessThanOrEqual(0.006);
  });
});

describe("§3 OKLab 거리 = core 값으로 다시 잰 값", () => {
  const table = rows(section("## 3. 대비 실측")).filter((r) => r[0].includes("–"));

  it("세 행", () => {
    expect(table.map((r) => r[0])).toEqual(["`signal`–`agent`", "`signal`–`danger`", "`agent`–`danger`"]);
  });

  it.each(COLUMNS.map(([t, m], i) => [t, m, i] as const))("%s %s", (theme, mode, i) => {
    const c = THEMES[theme][mode].color;
    for (const r of table) {
      const [a, b] = r[0].split("–").map((s) => s.replace(/`/g, "")) as [keyof typeof c, keyof typeof c];
      expect([r[0], Math.abs(oklabDistance(c[a], c[b]) - Number(r[1 + i])) <= 0.0015]).toEqual([r[0], true]);
    }
  });
});
