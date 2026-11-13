import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstPartyGlassSources, glassChrome, glassRange } from "@momo/core/design/glass";
import { blend, worstCaseBackdrops } from "@momo/core/design/scrim";
import { wallpaperTokensOf, wallpaperTreatment } from "@momo/core/design/wallpaper";
import { contrast } from "@momo/core/design/color";
import { catalogEntries, deriveCatalogMode } from "@momo/core/design/deriveCatalog";
import {
  CANVAS_STOPS,
  STANDING_SURFACES,
  THEMES,
  deriveStateSurfaces,
  type ThemeId,
  type ThemeModeTokens,
} from "@momo/core/design/themes";
import type { StatusDotTone } from "@momo/core/features/presence/statusDot";

// =============================================================================
// 아바타 상태 점의 대비 (#5786 · #4725 M2·M3). 점은 이제 도려낸 틈 안에 앉으므로 **점과 맞닿는 것은 아바타가 아니라 그
// 자리의 바탕**이다(틈이 비어 있다). 그래서 잰다: 네 상태의 표식 색(채운 점의 채움, 꺼짐 고리의 선) × 점이 실제로 서는
// 바탕 전부 ≥ 3:1(WCAG 1.4.11 비글자 대비). 상태끼리의 구별은 색이 아니라 모양이 맡는다(채운 원 · 초승달 · 가로 줄 ·
// 속 빈 고리 — `tokens.css` 의 `avatar-status`). 밝기가 거의 같은 초록·주황(1.02~1.26, #4725 M3)과 띠 위에서 둘 다
// 흰빛이 되는 주황·빨강은 색으로 가를 수 없기 때문이다. 아래 「모양」 묶음이 그 규칙이 CSS 에 실제로 있는지 잰다.
//
// 바탕(점이 서는 자리):
//   띠가 있는 테마  사이드바(DM 줄·프로필 줄)는 띠 위: 띠 · 띠 호버(on-band 10%) · 띠 눌림(16%). 선택 줄은 흰 면이고
//                   `band-surface` 로 원래 역할을 되찾는다 — 그 줄은 아래 「면」 칸이 잰다.
//   모든 테마       멤버 목록 카드·멤버 프로필 창·채널 멤버 패널·새 DM 창·선택 줄: 서는 면(surface·surface-muted·sheet)과
//                   가리킴·눌림 면. 띠 없는 테마의 사이드바는 캔버스 위.
//   배경화면        띠 없는 테마의 사이드바는 scrim 위에 선다(r1 H1). 바탕은 scrim 최악 합성 두 끝(순흑·순백 사진 = 가장 어두운
//                   배경화면과 가장 밝은 배경화면)이고, 표식은 배경화면이 사이드바에 다시 묶는 보정값이다(`wallpaperTreatment`).
//   유리            데스크탑 유리를 켠 사이드바: 바닥 세 정지점의 최악 합성(띠가 있으면 반투명 띠를 그 위에 얹은 것), 불투명도는
//                   슬라이더 아래 끝(하한)과 위 끝. 표식은 유리가 묶는 값(`glassChrome`)이다.
//
// 점의 초록이 띠가 없을 때 무엇으로 떨어지는지(사이드바 묶음의 `--status-ok` 뒤 값)는 **CSS 에서 읽어** 배경화면·유리 칸에
// 넣는다: 그 자리의 `--ok`(보정값)면 보정을 받고, 루트 값(`--status-ok-base`)이면 보정을 건너뛴다(r1 H1 — 어두운 배경화면 +
// 밝게에서 2.35~2.57:1). 되돌리면 숫자가 붉다.
//
// 색은 **출하되는 CSS 에서** 읽는다: 띠 위의 주황·빨강이 어느 on-band 단계로 묶이는지, 점의 초록이 띠 위에서 무엇을
// 섞는지, 꺼짐 고리가 어느 역할인지 — 손으로 옮긴 사본이 아니다.
// =============================================================================

const css = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const NON_TEXT_MIN = 3;

function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `tokens.css 에 ${selector} 규칙이 있다`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

/** `--name: var(--a, …)` 처럼 다시 묶인 역할의 첫 이름(띠 위에서 무엇이 되는가). */
function boundRole(body: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*var\\(--([a-z-]+)`).exec(body);
  expect(match, `${name} 이 묶여 있다`).not.toBeNull();
  return match![1]!;
}

const sidebarScope = ruleBody("\n.sidebar-drawer,\n.app-shell:not([data-sidebar-collapsed]) > .app-titlebar,");
const avatarStatus = ruleBody("@utility avatar-status {");

/**
 * 띠 위 점의 초록: 사이드바 묶음의 `--band-status-ok: color-mix(in srgb, var(--ok) N%, var(--on-band))` 의 N. 섞은 값이 실제로
 * 점까지 닿는지(묶음이 `--status-ok` 를 그 값으로 묶고, 점 규칙이 `--status-ok` 를 읽는지)도 같이 본다 — 섞기만 적어 두고
 * 묶지 않으면 띠 위 점은 섞지 않은 `--ok`(2.8:1)다.
 */
const bandOkMix = (() => {
  expect(sidebarScope).toMatch(/--status-ok: var\(--band-status-ok, var\(--[a-z-]+\)\);/);
  expect(css).toContain("--status-ok-base: var(--ok);");
  expect(avatarStatus).toContain("background-color: var(--status-ok, var(--ok));");
  const match = /--band-status-ok:\s*color-mix\(in srgb, var\(--(ok|status-ok-base)\) (\d+)%, var\(--on-band\)\);/.exec(sidebarScope);
  expect(match, "--band-status-ok 가 ok 와 on-band 를 섞는다").not.toBeNull();
  return Number(match![2]) / 100;
})();

/**
 * 띠 위에서 섞는 초록이 어느 값인가: `status-ok-base` 면 루트 값, `ok` 면 그 자리의 `--ok`(유리를 켜면 바닥 위 보정값 — 띠
 * 위에서는 너무 어둡다). 불투명한 띠에서는 둘이 같고 유리 띠에서 갈린다.
 */
const bandOkSource = /--band-status-ok:\s*color-mix\(in srgb, var\(--([a-z-]+)\)/.exec(sidebarScope)![1]!;

/**
 * 띠가 없을 때 점의 초록이 읽는 역할: `ok` 면 그 자리(사이드바)의 `--ok` — 배경화면·유리의 보정값 — 이고, `status-ok-base`
 * 면 루트에서 굳은 원래 값이다.
 */
const statusOkFallback = (() => {
  const match = /--status-ok: var\(--band-status-ok, var\(--([a-z-]+)\)\);/.exec(sidebarScope);
  expect(match, "--status-ok 의 뒤 값").not.toBeNull();
  return match![1]!;
})();

const shapeRule = (name: string) => ruleBody(`@utility ${name} {`);

/** 꺼짐 고리의 선 역할. */
const ringRole = (() => {
  const match = /border: var\(--status-gap\) solid var\(--([a-z-]+)\);/.exec(shapeRule("status-shape-ring"));
  expect(match, "꺼짐 고리는 틈 굵기의 선이다").not.toBeNull();
  return match![1]!;
})();

interface Case {
  label: string;
  bg: string;
  marks: Record<StatusDotTone, string>;
}

function baseMarks(t: ThemeModeTokens): Record<StatusDotTone, string> {
  const c = t.color as Record<string, string>;
  return { ok: c.ok!, warn: c.warn!, danger: c.danger!, muted: c[ringRole]! };
}

function casesFor(label: string, t: ThemeModeTokens, mode: "light" | "dark"): Case[] {
  const c = t.color as Record<string, string>;
  const state = deriveStateSurfaces(c.surface!, c.sheet!, mode);
  const base = baseMarks(t);
  const surfaces = [
    ...STANDING_SURFACES.map((role) => ({ role: role as string, bg: c[role]! })),
    { role: "surface-hover", bg: state.hover },
    { role: "surface-pressed", bg: state.pressed },
  ].map(({ role, bg }) => ({ label: `${label} ${role}`, bg, marks: base }));
  if (t.band) {
    const band = t.band.band;
    // 사이드바 묶음이 띠 단계로 다시 묶은 역할은 띠 값을, 묶지 않은 역할은 원래 값을 읽는다.
    const role = (name: string): string => {
      const at = sidebarScope.indexOf(`--${name}:`);
      if (at < 0) return c[name]!;
      const bound = boundRole(sidebarScope, name);
      return bound.startsWith("on-band") ? t.band![bound as "on-band" | "on-band-muted"] : c[name]!;
    };
    const marks: Record<StatusDotTone, string> = {
      ok: blend(c.ok!, t.band["on-band"], bandOkMix),
      warn: role("warn"),
      danger: role("danger"),
      muted: role(ringRole),
    };
    const onBand = t.band["on-band"];
    return [
      { label: `${label} 띠`, bg: band, marks },
      { label: `${label} 띠 호버`, bg: blend(onBand, band, 0.1), marks },
      { label: `${label} 띠 눌림`, bg: blend(onBand, band, 0.16), marks },
      ...surfaces,
    ];
  }
  const stops = [...new Set(t.canvas)].map((bg, i, all) => ({
    label: `${label} ${all.length === 1 ? "canvas" : CANVAS_STOPS[i]}`,
    bg,
    marks: base,
  }));
  return [...stops, ...surfaces];
}

const MODES = ["light", "dark"] as const;
const FIRST_PARTY = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
  MODES.flatMap((mode) => casesFor(`${theme} ${mode}`, THEMES[theme][mode], mode))
);
const CATALOG = catalogEntries().flatMap((entry) =>
  MODES.flatMap((mode) => {
    const derived = deriveCatalogMode(entry.id, mode);
    return derived ? casesFor(`catalog:${entry.id} ${mode}`, derived.tokens, mode) : [];
  })
);

/**
 * 배경화면을 켠 사이드바(띠 없는 테마만 — 띠가 있으면 배경화면은 사이드바를 보정하지 않고 띠가 불투명하다, `wallpaper.css`).
 * 바탕 = scrim 최악 합성 두 끝, 표식 = 배경화면이 사이드바에 묶는 값.
 */
function wallpaperCases(label: string, t: ThemeModeTokens, mode: "light" | "dark"): Case[] {
  if (t.band) return [];
  const treatment = wallpaperTreatment(wallpaperTokensOf(t), mode);
  if (treatment.verdict === "unavailable") return [];
  const roles = treatment.roles as Record<string, string>;
  const marks: Record<StatusDotTone, string> = {
    ok: statusOkFallback === "ok" ? roles.ok! : t.color.ok,
    warn: roles.warn!,
    danger: roles.danger!,
    muted: roles[ringRole]!,
  };
  const [overBlack, overWhite] = worstCaseBackdrops(t.canvas[1], treatment.alpha);
  return [
    { label: `${label} 배경화면(어두운 끝)`, bg: overBlack, marks },
    { label: `${label} 배경화면(밝은 끝)`, bg: overWhite, marks },
  ];
}

/** 유리를 켠 사이드바: 불투명도 하한·최대 × 바닥 정지점 × 최악 합성 두 끝. 띠가 있으면 반투명 띠를 그 위에 얹는다. */
function glassCases(theme: ThemeId, mode: "light" | "dark"): Case[] {
  const source = firstPartyGlassSources(theme)[mode];
  if (!source) return [];
  const range = glassRange(source);
  if (!range.usable) return [];
  return [range.min, range.max].flatMap((percent) => {
    const alpha = percent / 100;
    const chrome = glassChrome(source, mode, percent).band as Record<string, string>;
    const band = source.band;
    const ok = band
      ? blend(bandOkSource === "ok" ? chrome.ok! : THEMES[theme][mode].color.ok, band["on-band"], bandOkMix)
      : statusOkFallback === "ok"
        ? chrome.ok!
        : THEMES[theme][mode].color.ok;
    const marks: Record<StatusDotTone, string> = {
      ok,
      warn: chrome.warn!,
      danger: chrome.danger!,
      muted: chrome[ringRole]!,
    };
    return source.canvas.flatMap((stop, i) =>
      worstCaseBackdrops(stop, alpha).map((host, end) => ({
        label: `${theme} ${mode} 유리 ${percent}% ${CANVAS_STOPS[i]} ${end === 0 ? "어두운 끝" : "밝은 끝"}${band ? " 띠" : ""}`,
        bg: band ? blend(band.band, host, alpha) : host,
        marks,
      }))
    );
  });
}

const WALLPAPER = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
  MODES.flatMap((mode) => wallpaperCases(`${theme} ${mode}`, THEMES[theme][mode], mode))
);
const WALLPAPER_CATALOG = catalogEntries().flatMap((entry) =>
  MODES.flatMap((mode) => {
    const derived = deriveCatalogMode(entry.id, mode);
    return derived ? wallpaperCases(`catalog:${entry.id} ${mode}`, derived.tokens, mode) : [];
  })
);
const GLASS = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) => MODES.flatMap((mode) => glassCases(theme, mode)));

const TONES: readonly StatusDotTone[] = ["ok", "warn", "danger", "muted"];

function failures(cases: readonly Case[]): string[] {
  return cases.flatMap((c) =>
    TONES.flatMap((tone) => {
      const ratio = contrast(c.marks[tone], c.bg);
      return ratio < NON_TEXT_MIN ? [`${c.label} ${tone} ${ratio.toFixed(2)}`] : [];
    })
  );
}

/** 표(PR 본문용): 첫 파티 테마의 칸마다 네 상태의 대비. `AVATAR_STATUS_TABLE=1` 일 때만 찍는다. */
function printTable(cases: readonly Case[]) {
  if (!process.env.AVATAR_STATUS_TABLE) return;
  const lines = cases.map(
    (c) => `| ${c.label} | ${TONES.map((tone) => contrast(c.marks[tone], c.bg).toFixed(2)).join(" | ")} |`
  );
  console.log(["| 바탕 | 온라인 | 자리 비움 | 방해 금지 | 꺼짐 고리 |", "|---|---|---|---|---|", ...lines].join("\n"));
}

describe("상태 점 대비 — 점이 서는 바탕 전부에서 3:1 (#5786, #4725 M2)", () => {
  it("측정 칸이 비어 있지 않고 띠 테마가 들어 있다", () => {
    expect(FIRST_PARTY.length).toBeGreaterThanOrEqual(Object.keys(THEMES).length * 2 * 4);
    expect(FIRST_PARTY.some((c) => c.label.includes(" 띠"))).toBe(true);
    expect(CATALOG.length).toBeGreaterThanOrEqual(catalogEntries().length);
  });

  it("첫 파티 테마 × 밝게/어둡게 × 바탕: 네 상태 모두 3:1 이상", () => {
    printTable(FIRST_PARTY);
    expect(failures(FIRST_PARTY)).toEqual([]);
  });

  it("카탈로그 파생 테마도 같다", () => {
    expect(failures(CATALOG)).toEqual([]);
  });

  it("배경화면을 켠 사이드바(밝게·어둡게 × 가장 어두운·가장 밝은 배경화면): 네 상태 모두 3:1 이상 (r1 H1)", () => {
    // 띠 없는 첫 파티 테마 둘(새벽하늘·그래파이트) × 밝게/어둡게 × 두 끝.
    expect(WALLPAPER.length).toBeGreaterThanOrEqual(2 * 2 * 2);
    printTable(WALLPAPER);
    expect(failures(WALLPAPER)).toEqual([]);
    expect(failures(WALLPAPER_CATALOG)).toEqual([]);
  });

  it("유리를 켠 사이드바(불투명도 하한·최대, 띠 테마는 반투명 띠 위): 네 상태 모두 3:1 이상", () => {
    expect(GLASS.some((c) => c.label.includes(" 띠"))).toBe(true);
    expect(GLASS.some((c) => !c.label.includes(" 띠"))).toBe(true);
    printTable(GLASS);
    expect(failures(GLASS)).toEqual([]);
  });

  it("띠 위의 초록은 섞은 값이다 — 섞지 않은 --ok 는 남색 띠(밝게)에서 3:1 이 안 된다(이 시험이 지키는 까닭)", () => {
    const noeul = THEMES.noeul.light;
    expect(noeul.band).not.toBeNull();
    expect(contrast(noeul.color.ok, noeul.band!.band)).toBeLessThan(NON_TEXT_MIN);
  });
});

describe("상태 점 모양 — 색이 아니라 모양으로 갈린다", () => {
  const toneRule = (tone: StatusDotTone) => {
    const at = avatarStatus.indexOf(`[data-avatar-status-dot][data-tone="${tone}"] {`);
    expect(at, tone).toBeGreaterThan(-1);
    return avatarStatus.slice(at, avatarStatus.indexOf("}", at));
  };

  it("톤 규칙은 색만 칠한다(모양은 뜻이 고르는 `status-shape-*`), 꺼짐 톤에는 채움이 없다", () => {
    for (const tone of ["ok", "warn", "danger"] as const) {
      expect(toneRule(tone)).toContain("background-color");
      expect(toneRule(tone)).not.toContain("mask");
    }
    expect(avatarStatus).not.toContain('[data-tone="muted"]');
    expect(shapeRule("status-shape-ring")).not.toContain("background");
    expect(shapeRule("status-shape-ring")).toContain("border:");
  });

  it("자리 비움은 초승달(원 하나를 덜어 냄), 방해 금지는 가로 줄을 덜어 낸 원 — 둘의 마스크가 서로 다르다", () => {
    expect(shapeRule("status-shape-moon")).toMatch(/mask-image: radial-gradient\(\s*circle at 25% 25%/);
    expect(shapeRule("status-shape-bar")).toContain("mask-composite: exclude");
    expect(shapeRule("status-shape-bar")).toMatch(
      /mask-size: 100% 100%, calc\(var\(--status-dot\) - 2 \* var\(--status-gap\)\) var\(--status-gap\)/
    );
  });

  it("띠 위에서 주황·빨강은 서로 다른 on-band 단계다(색도 남지만 모양이 먼저 가른다)", () => {
    expect(boundRole(sidebarScope, "warn")).toBe("on-band-muted");
    expect(boundRole(sidebarScope, "danger")).toBe("on-band");
  });
});
