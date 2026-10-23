import { describe, expect, it } from "vitest";
import { contrast, toOklch } from "./color";
import { deriveCatalogMode } from "./deriveCatalog";
import { GLASS_NON_TEXT_ROLES, GLASS_OPACITY_MAX, GLASS_TEXT_ROLES, glassChrome, glassRange } from "./glass";
import { INK_MIN_ON_BACKDROP, NON_TEXT_MIN_ON_BACKDROP, TEXT_MIN_ON_BACKDROP, worstCaseBackdrops } from "./scrim";
import { THEME_CATALOG } from "./themeCatalog.generated";
import type { Mode } from "./themes";

// =============================================================================
// 카탈로그 57 테마-모드의 데스크탑 유리 (AP-1b #4188 × AP-3 #4190, 증보 3 D6). AP-3의 유리 산수(`glass.ts`)는 첫 파티 여섯 조합으로만
// 잰다. 카탈로그의 색을 그 산수에 알리는 연결(`registerGlassSourcesResolver`, 웹 `derivedApplier`)이 서면서 같은 산수가 파생
// 토큰 위에서 도는데, 파생 토큰이 유리 위에서도 약속을 지키는가를 이 파일이 57행 × 불투명도 셋(하한·기본·95%)으로 잰다.
//
// 실측(2026-10-22, 엔진 판 4): 57행 모두 쓸 수 있고(하한 최소 61 · 중앙 82 · 최대 92) 청사진 초안의 「불가 9 테마-모드」는 서지 않는다
// (글자 호스트가 늘어 `ink`가 진해진 효과). 글자 4.5 · 표식 3 · 하한에서 잉크 7:1은 171칸 전부 지킨다. 채도 순서의 자(위험 ÷ 경고 ≥ 1.15,
// 경고 ÷ 보조 ≥ 2)는 171칸 가운데 7칸이 못 지키고, 그 가운데 `danger > warn` 순서 자체가 뒤집히는 곳은 material 다크 77% 한 칸이다
// (아래 시험이 천장으로 못 박는다: 줄어들기만 한다).
// =============================================================================

const ROWS = THEME_CATALOG.flatMap((entry) =>
  (["light", "dark"] as const).flatMap((mode: Mode) => (entry[mode] ? [{ id: entry.id, mode }] : []))
);
const tokensOf = (id: string, mode: Mode) => deriveCatalogMode(id, mode, null)!.tokens;
const chroma = (hex: string): number => toOklch(hex).C;

describe("카탈로그의 유리 하한", () => {
  it("57행 모두 유리를 쓸 수 있고 하한 분포가 실측과 같다: 최소 61 · 중앙 82 · 최대 92", () => {
    expect(ROWS).toHaveLength(57);
    const mins = ROWS.map(({ id, mode }) => glassRange(tokensOf(id, mode))).map((range) => {
      expect(range.usable).toBe(true);
      expect(range.max).toBe(GLASS_OPACITY_MAX);
      return range.min;
    });
    mins.sort((a, b) => a - b);
    expect([mins[0], mins[Math.floor(mins.length / 2)], mins[mins.length - 1]]).toEqual([61, 82, 92]);
  });
});

describe("카탈로그 위의 유리 글자·표식 (불투명도 하한·기본·95%)", () => {
  const cells = ROWS.flatMap(({ id, mode }) => {
    const range = glassRange(tokensOf(id, mode));
    return [range.min, range.defaultPercent, GLASS_OPACITY_MAX].map((percent) => ({ id, mode, percent, atFloor: percent === range.min }));
  });

  it("171칸(57행 × 셋)이다", () => {
    expect(cells).toHaveLength(171);
  });

  it.each(cells.map((cell) => [`${cell.id} ${cell.mode} ${cell.percent}%`, cell] as const))("%s: 글자 4.5 · 표식 3을 최악 합성 두 끝에서 지키고 하한에서는 잉크가 7이다", (_name, cell) => {
    const tokens = tokensOf(cell.id, cell.mode);
    const hosts = tokens.canvas.flatMap((stop) => worstCaseBackdrops(stop, cell.percent / 100));
    const chrome = glassChrome(tokens, cell.mode, cell.percent).canvas;
    for (const role of GLASS_TEXT_ROLES) {
      expect([role, Math.min(...hosts.map((host) => contrast(chrome[role], host))) >= TEXT_MIN_ON_BACKDROP - 1e-9]).toEqual([role, true]);
    }
    for (const role of GLASS_NON_TEXT_ROLES) {
      expect([role, Math.min(...hosts.map((host) => contrast(chrome[role], host))) >= NON_TEXT_MIN_ON_BACKDROP - 1e-9]).toEqual([role, true]);
    }
    if (cell.atFloor) {
      expect(Math.min(...hosts.map((host) => contrast(tokens.color.ink, host)))).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP - 1e-9);
    }
  });

  it("채도 순서의 자(위험 ÷ 경고 ≥ 1.15, 경고 ÷ 보조 ≥ 2)를 못 지키는 칸은 7칸 이하이고, 위험 > 경고 순서 자체가 뒤집힌 칸은 한 칸 이하다", () => {
    // 못 지키는 칸(실측): 위험 ÷ 경고는 dracula 다크 76% · laserwave 다크 72% · material 다크 77%(0.926: 순서가 뒤집힘) · red 다크 69%,
    // 경고 ÷ 보조는 catppuccin 다크 90%·95% · vscode-plus 라이트 61%. 같은 색상각·명도에서 경고의 채도만 덜어 내는 AP-3의 보정
    // (`keepWarnBelowDanger`)이 보조 글자의 채도가 높은 테마에서는 두 자를 함께 못 채운다. 이 PR이 고치지 않은 AP-3 산수의 한계다.
    let short = 0;
    let reversed = 0;
    for (const cell of cells) {
      const chrome = glassChrome(tokensOf(cell.id, cell.mode), cell.mode, cell.percent).canvas;
      const danger = chroma(chrome.danger);
      const warn = chroma(chrome.warn);
      const muted = Math.max(1e-6, chroma(chrome["ink-muted"]));
      if (danger / warn < 1.15 - 1e-9 || warn / muted < 2 - 1e-9) short++;
      if (!(danger > warn)) reversed++;
    }
    expect(short).toBeLessThanOrEqual(7);
    expect(reversed).toBeLessThanOrEqual(1);
  });
});
