import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blend } from "@momo/core/design/scrim";
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
  expect(sidebarScope).toContain("--status-ok: var(--band-status-ok, var(--ok));");
  expect(avatarStatus).toContain("background-color: var(--status-ok, var(--ok));");
  const match = /--band-status-ok:\s*color-mix\(in srgb, var\(--ok\) (\d+)%, var\(--on-band\)\);/.exec(sidebarScope);
  expect(match, "--band-status-ok 가 ok 와 on-band 를 섞는다").not.toBeNull();
  return Number(match![1]) / 100;
})();

/** 꺼짐 고리의 선 역할(`--status-ring` 이 없으면 뒤 값). */
const ringRole = (() => {
  const match = /\[data-tone="muted"\] \{\s*border: var\(--status-gap\) solid var\(--([a-z-]+)\);/.exec(
    avatarStatus
  );
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

  it("띠 위의 초록은 섞은 값이다 — 섞지 않은 --ok 는 남색 띠(밝게)에서 3:1 이 안 된다(이 시험이 지키는 까닭)", () => {
    const noeul = THEMES.noeul.light;
    expect(noeul.band).not.toBeNull();
    expect(contrast(noeul.color.ok, noeul.band!.band)).toBeLessThan(NON_TEXT_MIN);
  });
});

describe("상태 점 모양 — 색이 아니라 모양으로 갈린다", () => {
  const rule = (tone: StatusDotTone) => {
    const at = avatarStatus.indexOf(`[data-avatar-status-dot][data-tone="${tone}"] {`);
    expect(at, tone).toBeGreaterThan(-1);
    return avatarStatus.slice(at, avatarStatus.indexOf("}", at));
  };

  it("온라인은 채운 원(마스크 없음), 꺼짐은 속 빈 고리(채움 없음)", () => {
    expect(rule("ok")).toContain("background-color");
    expect(rule("ok")).not.toContain("mask");
    expect(rule("muted")).not.toContain("background");
    expect(rule("muted")).toContain("border:");
  });

  it("자리 비움은 초승달(원 하나를 덜어 냄), 방해 금지는 가로 줄을 덜어 낸 원 — 둘의 마스크가 서로 다르다", () => {
    expect(rule("warn")).toMatch(/mask-image: radial-gradient\(\s*circle at 25% 25%/);
    expect(rule("danger")).toContain("mask-composite: exclude");
    expect(rule("danger")).toMatch(/mask-size: 100% 100%, calc\(var\(--status-dot\) - 2 \* var\(--status-gap\)\) var\(--status-gap\)/);
  });

  it("띠 위에서 주황·빨강은 서로 다른 on-band 단계다(색도 남지만 모양이 먼저 가른다)", () => {
    expect(boundRole(sidebarScope, "warn")).toBe("on-band-muted");
    expect(boundRole(sidebarScope, "danger")).toBe("on-band");
  });
});
