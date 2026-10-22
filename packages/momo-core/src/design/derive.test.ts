import { describe, expect, it } from "vitest";
import { contrast, hueGap, oklabDistance, parseHex, toOklch } from "./color";
import {
  DERIVED_VAR_NAMES,
  DERIVE_ENGINE_VERSION,
  TILE_VAR_NAMES,
  deriveCssVars,
  deriveThemeMode,
  presetOutcomes,
  tileVars,
  type DerivedMode,
} from "./derive";
import { THEME_CATALOG } from "./themeCatalog.generated";
import { parseThemeCache } from "./themeCache";
import { extractSeed, type CatalogEntry, type ThemeSeed } from "./themeSeed";
import {
  COLOR_ROLES,
  DERIVED_ROLES,
  NON_TEXT_FOREGROUNDS,
  SIGNAL_MIN_DISTANCE,
  TEXT_FOREGROUNDS,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
  contrastPairs,
  deriveRoles,
  type ColorRole,
  type Mode,
} from "./themes";
import { SIGNAL_PRESET_IDS, resolveSignal } from "./signal";

// =============================================================================
// 파생 엔진 전수 시험 (AP-1b #4188, ADR-0189 증보 3 D2). 카탈로그 41항목 × 가용 모드 = 57행 전부에서
// 첫 파티 3종과 같은 규칙을 단정한다: 356쌍 대비(+본문 판 호스트)·신호/에이전트/위험 거리 0.07·
// `deriveRoles` 성공·`primary = ink`. 행마다 따로 빨개져야 하므로 `it.each`다.
//
// **실패할 수 있는 가드인가.** 같은 위반 함수를 `adjust: false`(보정 없이 씨앗에서 파생만, Buzz처럼)로 돌린
// 결과에 걸어 「보정이 없으면 거의 전부 빨갛다」를 단정한다. 위반 함수가 헛돌거나 보정이 항등이어도 통과하는
// 시험이었다면 이 숫자가 0이다.
// =============================================================================

const ROWS: { id: string; mode: Mode; entry: CatalogEntry; seed: ThemeSeed }[] = THEME_CATALOG.flatMap((entry) =>
  (["light", "dark"] as const).flatMap((mode) => {
    const seed = entry[mode];
    return seed ? [{ id: entry.id, mode, entry, seed }] : [];
  })
);

/** 한 파생 결과의 규칙 위반을 사람이 읽는 줄로. 비어 있으면 위반이 없다. */
function violations(derived: DerivedMode): string[] {
  const out: string[] = [];
  const { tokens, mode, pane } = derived;
  // 356쌍의 계산식 그대로(한 모드만 재도록 걸러 낸다. `contrastPairs`는 두 모드를 다 돌므로 같은 값을 양쪽에 넣는다).
  const pairs = contrastPairs({ x: { light: tokens, dark: tokens } } as never).filter((p) => p.mode === mode);
  for (const p of pairs) {
    const ratio = contrast(p.fg, p.bg);
    if (ratio < p.min - 1e-9) out.push(`${p.foreground}/${p.background} ${ratio.toFixed(2)} < ${p.min}`);
  }
  // 본문 판은 표면과 따로 선 면이다(다크에서 판은 표면·바닥 사이의 셋째 면).
  const c = tokens.color;
  for (const role of TEXT_FOREGROUNDS) {
    if (contrast(c[role], pane) < 4.5 - 1e-9) out.push(`${role}/pane < 4.5`);
  }
  for (const role of NON_TEXT_FOREGROUNDS) {
    if (contrast(c[role], pane) < 3 - 1e-9) out.push(`${role}/pane < 3`);
  }
  for (const [a, b] of [
    ["signal", "agent"],
    ["signal", "danger"],
    ["agent", "danger"],
    ["signal-text", "agent"],
    ["signal-text", "danger"],
  ] as const) {
    if (oklabDistance(c[a], c[b]) < SIGNAL_MIN_DISTANCE) out.push(`${a}~${b} < ${SIGNAL_MIN_DISTANCE}`);
  }
  if (c.primary !== c.ink) out.push("primary != ink");
  return out;
}

function derivedOrRaw(seed: ThemeSeed, adjust: boolean): DerivedMode | null {
  try {
    return deriveThemeMode(seed, { adjust });
  } catch {
    return null; // 보정 없이는 표 밖 역할이 서지 않는 씨앗도 위반이다.
  }
}

describe("카탈로그 전수: 57 테마-모드가 첫 파티와 같은 규칙을 지킨다", () => {
  it("행 수는 57이다 (쌍 16 × 2 + 라이트 단독 1 + 다크 단독 24)", () => {
    expect(ROWS).toHaveLength(57);
  });

  it.each(ROWS.map((r) => [`${r.id} ${r.mode}`, r] as const))("%s: 대비·거리·역할 위반 0", (_name, row) => {
    const derived = deriveThemeMode(row.seed);
    expect(derived.mode).toBe(row.mode);
    expect(violations(derived)).toEqual([]);
  });

  it.each(ROWS.map((r) => [`${r.id} ${r.mode}`, r] as const))("%s: 역할 목록이 완전하고 값이 형식을 지킨다", (_name, row) => {
    const { tokens, pane } = deriveThemeMode(row.seed);
    expect(Object.keys(tokens.color).sort()).toEqual([...COLOR_ROLES].sort());
    expect(Object.keys(tokens.derived).sort()).toEqual([...DERIVED_ROLES].sort());
    for (const hex of [...Object.values(tokens.color), ...Object.values(tokens.derived), ...tokens.canvas, pane]) {
      expect([hex, parseHex(hex) !== null]).toEqual([hex, true]);
    }
    expect(tokens.band).toBeNull();
    expect(tokens.glass).toMatch(/^rgba\(\d{1,3},\d{1,3},\d{1,3},\.7[24]\)$/);
    expect(tokens.scrim).toMatch(/^rgba\(/);
    // 바닥 세 정지점은 평면이다(그라데이션은 첫 파티의 서명).
    expect(new Set(tokens.canvas).size).toBe(1);
  });

  it.each(ROWS.map((r) => [`${r.id} ${r.mode}`, r] as const))("%s: 표 밖 역할(`deriveRoles`)이 서고 두 자를 넘는다", (_name, row) => {
    const { tokens, mode } = deriveThemeMode(row.seed);
    expect(tokens.derived).toEqual(deriveRoles(tokens, mode));
    const { color: c, derived: d } = tokens;
    const hosts: [keyof typeof d, string[]][] = [
      ["surface-hover", [c.surface, c.sheet]],
      ["surface-pressed", [c.surface, c.sheet, d["surface-hover"]]],
      ["muted-soft", [c.surface, c.sheet, d["surface-hover"], d["surface-pressed"]]],
    ];
    for (const [role, bases] of hosts) {
      for (const base of bases) {
        expect([role, base, contrast(d[role], base) >= VESSEL_MIN_CONTRAST, oklabDistance(d[role], base) >= VESSEL_MIN_DISTANCE]).toEqual([
          role,
          base,
          true,
          true,
        ]);
      }
    }
    expect(contrast(d["on-danger-fill"], d["danger-fill"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ROWS.map((r) => [`${r.id} ${r.mode}`, r] as const))("%s: on-primary는 표면이나 판이고 ink와 4.5 이상이다", (_name, row) => {
    const { tokens, pane } = deriveThemeMode(row.seed);
    const c = tokens.color;
    expect([c.surface, pane]).toContain(c["on-primary"]);
    expect(contrast(c["on-primary"], c.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ROWS.map((r) => [`${r.id} ${r.mode}`, r] as const))("%s: 보정 기록의 끝 값이 실제 토큰이다", (_name, row) => {
    const { tokens, notes } = deriveThemeMode(row.seed);
    for (const note of notes) {
      expect(note.role in tokens.color).toBe(true);
      expect(tokens.color[note.role as ColorRole]).toBe(note.to);
      expect(note.delta).toBeCloseTo(oklabDistance(note.from, note.to), 9);
      expect(note.delta).toBeGreaterThan(0);
    }
  });
});

describe("보정은 필요하고 실제로 일한다 (실패할 수 있는 가드)", () => {
  it("보정 없이 씨앗에서 파생만 하면 57행 가운데 50행 이상이 규칙을 어긴다", () => {
    const rawBad = ROWS.filter((row) => {
      const raw = derivedOrRaw(row.seed, false);
      return raw === null || violations(raw).length > 0;
    });
    // 측정: 54/57 (같은 위반 함수, 보정만 끈 값). 청사진 초안의 프로토타입 값은 56/57이다.
    expect(rawBad.length).toBeGreaterThanOrEqual(50);
  });

  it("보정을 켜면 같은 57행의 위반이 0이다", () => {
    const bad = ROWS.filter((row) => violations(deriveThemeMode(row.seed)).length > 0);
    expect(bad.map((row) => `${row.id} ${row.mode}`)).toEqual([]);
  });

  it("보정이 `ink` 자체를 옮기는 테마는 몇 안 된다 (기록의 role로 센다)", () => {
    const moved = ROWS.filter((row) => deriveThemeMode(row.seed).notes.some((n) => n.role === "ink"));
    expect(moved.map((row) => `${row.id} ${row.mode}`).sort()).toEqual([
      "material light",
      "solarized dark",
      "solarized light",
    ]);
  });

  it("보정은 명도만 옮긴다: 채도 있는 색은 색상각이 거의 그대로다 (에이전트 회전은 일부러 돌린 것이라 뺀다)", () => {
    const gaps: number[] = [];
    for (const row of ROWS) {
      for (const note of deriveThemeMode(row.seed).notes) {
        if (note.rotated !== undefined) continue;
        // 무채색 근처에서는 색상각이 의미가 없다. 두 쪽 다 채도가 있을 때만 잰다.
        if (toOklch(note.from).C < 0.04 || toOklch(note.to).C < 0.04) continue;
        gaps.push(hueGap(note.from, note.to));
      }
    }
    expect(gaps.length).toBeGreaterThan(100);
    expect(Math.max(...gaps)).toBeLessThan(12);
  });
});

describe("결정성과 순수성", () => {
  it("같은 씨앗은 같은 토큰을 낸다 (두 번 파생해도 같다)", () => {
    for (const row of ROWS) {
      expect(deriveThemeMode(row.seed, { adjust: true })).toEqual(deriveThemeMode({ ...row.seed }));
    }
  });

  it("씨앗 객체를 바꾸지 않는다", () => {
    const seed = { ...THEME_CATALOG[0].dark! };
    const before = JSON.stringify(seed);
    deriveThemeMode(seed);
    expect(JSON.stringify(seed)).toBe(before);
  });

  it("엔진 판은 비어 있지 않은 한 줄이다 (부트 캐시 키에 들어간다)", () => {
    expect(DERIVE_ENGINE_VERSION).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("골든: 청사진 부록 C의 값과 한 글자까지 같은 곳과 달라진 곳", () => {
  const get = (id: string, mode: Mode) => deriveThemeMode(THEME_CATALOG.find((e) => e.id === id)![mode]!);

  it("github 라이트: Buzz 산수를 옮긴 면·글자 값이 프로토타입 골든과 같다", () => {
    const { tokens, pane } = get("github", "light");
    const c = tokens.color;
    expect(tokens.canvas[0]).toBe("#f6f6f6");
    expect(pane).toBe("#ffffff");
    expect(c.surface).toBe("#ffffff");
    expect(c["surface-muted"]).toBe("#f5f5f5");
    expect(c.ink).toBe("#24292e");
    expect(c["ink-muted"]).toBe("#68717b");
    expect(c.icon).toBe("#888f96");
    expect(c.line).toBe("#e5e5e6");
    expect(c["line-strong"]).toBe("#8c8e91");
    expect(contrast(c.ink, c.surface)).toBeCloseTo(14.67, 2);
    expect(contrast(c["ink-muted"], c.surface)).toBeCloseTo(4.96, 2);
    expect(contrast(c["ink-muted"], tokens.canvas[0])).toBeCloseTo(4.59, 2);
    expect(contrast(c["line-strong"], tokens.canvas[0])).toBeCloseTo(3.04, 2);
  });

  it("dracula 다크: 다크의 면은 판을 한 단씩 올린 값이다", () => {
    const { tokens, pane } = get("dracula", "dark");
    const c = tokens.color;
    expect(tokens.canvas[0]).toBe("#1c1d25");
    expect(pane).toBe("#282a36");
    expect(c.surface).toBe("#31333e");
    expect(c["surface-muted"]).toBe("#393b46");
    expect(c["ink-muted"]).toBe("#92a4d9");
    expect(c.line).toBe("#474952");
  });

  it("nord 다크 단독: 신호는 테마의 버튼색이고 에이전트는 신호에 비켜 색상각을 돌렸다", () => {
    const derived = get("nord", "dark");
    expect(derived.tokens.color.signal).toBe("#88c0d0");
    expect(derived.notes.find((n) => n.role === "agent")?.rotated).toBeGreaterThan(0);
    const c = derived.tokens.color;
    expect(oklabDistance(c.agent, c.signal)).toBeGreaterThanOrEqual(SIGNAL_MIN_DISTANCE);
    expect(oklabDistance(c.agent, c["signal-text"])).toBeGreaterThanOrEqual(SIGNAL_MIN_DISTANCE);
  });

  it("catppuccin 라이트: 불투명에서도 ink 7:1에 못 닿는 바탕이라 유리 불가 후보다 (글자는 7.06)", () => {
    const { tokens } = get("catppuccin", "light");
    expect(contrast(tokens.color.ink, tokens.color.surface)).toBeCloseTo(7.06, 2);
  });
});

describe("신호: 씨앗 → 기본 → 중립, 에이전트가 비킨다", () => {
  it("테마의 신호 씨앗이 받아들여지면 그 색에서 출발한다 (source seed)", () => {
    const seed = THEME_CATALOG.find((e) => e.id === "nord")!.dark!;
    const derived = deriveThemeMode(seed);
    expect(derived.signal).toEqual({ source: "seed" });
  });

  it("신호 씨앗이 위험색과 가까우면 기본 신호(새벽하늘의 주황)로 물러난다", () => {
    const derived = deriveThemeMode(THEME_CATALOG.find((e) => e.id === "red")!.dark!);
    expect(derived.signal).toEqual({ source: "default", seedRejection: "near-danger" });
  });

  it("기본 신호도 거절되면 잉크(중립)로 물러난다. 중립도 규칙을 지킨다", () => {
    const derived = deriveThemeMode(THEME_CATALOG.find((e) => e.id === "synthwave-84")!.dark!);
    expect(derived.signal.source).toBe("neutral");
    const c = derived.tokens.color;
    expect(c.signal).toBe(c.ink);
    expect(c["on-signal"]).toBe(c["on-primary"]);
    expect(violations(derived)).toEqual([]);
  });

  it("사람이 프리셋을 고르면 받아들여지는 조합은 그 색에서 푼다 (source choice)", () => {
    const seed = THEME_CATALOG.find((e) => e.id === "nord")!.dark!;
    const derived = deriveThemeMode(seed, { signal: { preset: "hyeseong" } });
    expect(derived.signal).toEqual({ source: "choice" });
    expect(derived.tokens.color.signal).not.toBe(deriveThemeMode(seed).tokens.color.signal);
  });

  it("거절되는 조합(catppuccin-frappe 다크 × 홍염)은 이유를 알리고 테마의 신호로 물러난다 (AC 6)", () => {
    const seed = THEME_CATALOG.find((e) => e.id === "catppuccin-frappe")!.dark!;
    const chosen = deriveThemeMode(seed, { signal: { preset: "hongyeom" } });
    expect(chosen.signal.choiceRejection).toBe("near-danger");
    expect(chosen.signal.source).not.toBe("choice");
    expect(chosen.tokens.color.signal).toBe(deriveThemeMode(seed).tokens.color.signal);
    expect(violations(chosen)).toEqual([]);
  });

  it("직접 입력한 색도 같은 길이다: 도달할 수 있으면 받고 형식이 틀리면 거절 이유를 단다", () => {
    const seed = THEME_CATALOG.find((e) => e.id === "github")!.light!;
    const ok = deriveThemeMode(seed, { signal: { custom: "#7a3fd0" } });
    expect(ok.signal.source).toBe("choice");
    const bad = deriveThemeMode(seed, { signal: { custom: "purple" } });
    expect(bad.signal.choiceRejection).toBe("invalid-hex");
    expect(bad.signal.source).toBe("seed");
  });

  it("presetOutcomes는 같은 조합을 deriveThemeMode가 푼 것과 같게 말한다", () => {
    for (const row of ROWS) {
      const outcomes = presetOutcomes(row.seed);
      for (const preset of SIGNAL_PRESET_IDS) {
        const derived = deriveThemeMode(row.seed, { signal: { preset } });
        const outcome = outcomes[preset];
        if (outcome.ok) {
          expect([row.id, row.mode, preset, derived.signal.source]).toEqual([row.id, row.mode, preset, "choice"]);
          expect(derived.tokens.color.signal).toBe(outcome.signal);
          expect(derived.tokens.color["on-signal"]).toBe(outcome.onSignal);
        } else {
          expect([row.id, row.mode, preset, derived.signal.choiceRejection]).toEqual([row.id, row.mode, preset, outcome.reason]);
          expect(outcome.message.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("프리셋 거절 통계: 에이전트가 양보하므로 거절은 전부 near-danger이고 홍염이 가장 많다 (57행 × 4프리셋 = 228)", () => {
    const reasons: Record<string, number> = {};
    const byPreset: Record<string, number> = {};
    for (const row of ROWS) {
      for (const [preset, outcome] of Object.entries(presetOutcomes(row.seed))) {
        if (outcome.ok) continue;
        reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
        byPreset[preset] = (byPreset[preset] ?? 0) + 1;
      }
    }
    expect(Object.keys(reasons)).toEqual(["near-danger"]);
    expect(byPreset.hongyeom).toBeGreaterThan(byPreset.seongun);
    expect(byPreset.hongyeom).toBeGreaterThan(byPreset.gamram ?? 0);
  });

  it("agentYields가 켜진 풀이는 near-agent로 거절하지 않고, 꺼진 풀이는 거절한다", () => {
    const seed = THEME_CATALOG.find((e) => e.id === "nord")!.dark!;
    const derived = deriveThemeMode(seed);
    const tokens = { ...derived.tokens, color: { ...derived.tokens.color, agent: derived.tokens.color.signal } };
    const input = derived.tokens.color.signal;
    expect(resolveSignal(input, "dawnsky", "dark", tokens).ok).toBe(false);
    expect(resolveSignal(input, "dawnsky", "dark", tokens, { agentYields: true }).ok).toBe(true);
  });
});

describe("씨앗 합성 픽스처", () => {
  it("순백 바탕·순흑 글자 같은 극단 씨앗에서도 파생이 선다 (명도 범위가 [0.02, 1.0])", () => {
    const light = deriveThemeMode({ bg: "#ffffff", fg: "#000000" });
    expect(violations(light)).toEqual([]);
    const dark = deriveThemeMode({ bg: "#000000", fg: "#ffffff" });
    expect(violations(dark)).toEqual([]);
    expect(dark.mode).toBe("dark");
  });

  it("글자가 바탕과 거의 같아도 ink가 4.5를 넘게 옮겨진다", () => {
    const derived = deriveThemeMode({ bg: "#202020", fg: "#262626" });
    expect(contrast(derived.tokens.color.ink, derived.tokens.color.surface)).toBeGreaterThanOrEqual(4.5);
    expect(derived.notes.some((n) => n.role === "ink")).toBe(true);
  });

  it("어느 방향으로도 4.5:1에 닿지 못하는 중간 휘도 바탕은 던진다 (거절은 구문 오류와 도달 불가뿐)", () => {
    expect(() => deriveThemeMode({ bg: "#7f7f7f", fg: "#7f7f7f" })).toThrow(/no lightness reaches/);
  });

  it("씨앗이 형식이 틀리면 던진다", () => {
    expect(() => deriveThemeMode({ bg: "nope", fg: "#ffffff" } as ThemeSeed)).toThrow();
  });

  it("전체 파이프라인: 합성 테마 객체 → 씨앗 → 파생이 한 번에 서고, comment가 muted 글자의 출발점이다", () => {
    const seed = extractSeed({
      colors: { "editor.background": "#1b2b34", "editor.foreground": "#cdd3de", focusBorder: "#6699cc" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#65737e" } }],
    })!;
    const derived = deriveThemeMode(seed);
    expect(violations(derived)).toEqual([]);
    expect(derived.tokens.color["ink-muted"]).not.toBe(derived.tokens.color.ink);
  });
});

describe("CSS 변수: 루트에 꽂는 한 벌", () => {
  const nord = deriveThemeMode(THEME_CATALOG.find((e) => e.id === "nord")!.dark!);
  const github = {
    light: deriveThemeMode(THEME_CATALOG.find((e) => e.id === "github")!.light!),
    dark: deriveThemeMode(THEME_CATALOG.find((e) => e.id === "github")!.dark!),
  };

  it("이름 집합은 첫 파티 생성 CSS의 이름 집합 + --pane이다 (띠는 카탈로그에 없다)", () => {
    expect(DERIVED_VAR_NAMES).toHaveLength(33);
    expect(Object.keys(deriveCssVars(github)).sort()).toEqual([...DERIVED_VAR_NAMES].sort());
    expect(Object.keys(deriveCssVars({ dark: nord })).sort()).toEqual([...DERIVED_VAR_NAMES].sort());
  });

  it("쌍 테마는 light-dark(라이트, 다크) 한 줄이고 단일 모드는 색 하나다", () => {
    const pair = deriveCssVars(github);
    expect(pair["--ink"]).toBe(`light-dark(${github.light.tokens.color.ink}, ${github.dark.tokens.color.ink})`);
    expect(pair["--pane"]).toBe(`light-dark(${github.light.pane}, ${github.dark.pane})`);
    const solo = deriveCssVars({ dark: nord });
    expect(solo["--ink"]).toBe(nord.tokens.color.ink);
    expect(solo["--glass"]).toBe(nord.tokens.glass);
    expect(Object.values(solo).some((v) => v.includes("light-dark"))).toBe(false);
  });

  it("모든 값이 부트 캐시 문법(색 하나 또는 light-dark 쌍)을 지킨다 — 하나라도 어기면 캐시가 통째로 버려진다", () => {
    for (const row of ROWS) {
      const parts = row.mode === "light" ? { light: deriveThemeMode(row.seed) } : { dark: deriveThemeMode(row.seed) };
      const vars = deriveCssVars(parts);
      const parsed = parseThemeCache(JSON.stringify({ key: `1|catalog:${row.id}|-`, vars }));
      expect([row.id, row.mode, parsed !== null]).toEqual([row.id, row.mode, true]);
    }
    for (const entry of THEME_CATALOG.filter((e) => e.light && e.dark)) {
      const vars = deriveCssVars({
        light: deriveThemeMode(entry.light!),
        dark: deriveThemeMode(entry.dark!),
      });
      expect([entry.id, parseThemeCache(JSON.stringify({ key: `1|catalog:${entry.id}|-`, vars })) !== null]).toEqual([entry.id, true]);
    }
  });

  it("값에 var()·중첩·세미콜론이 없다", () => {
    for (const value of Object.values(deriveCssVars(github))) {
      expect(value).not.toMatch(/var\(|;|\{|\}|url\(|"|'/);
    }
  });
});

describe("미리보기 타일 변수", () => {
  const derived = deriveThemeMode(THEME_CATALOG.find((e) => e.id === "github")!.dark!);

  it("열둘이고 이름이 TILE_VAR_NAMES와 같다", () => {
    const vars = tileVars(derived.tokens, derived.mode, derived.pane);
    expect(Object.keys(vars).sort()).toEqual([...TILE_VAR_NAMES].sort());
    expect(TILE_VAR_NAMES).toHaveLength(12);
  });

  it("파생 테마는 pane을 그대로, 첫 파티는 웹 셸 규칙(라이트 surface, 다크 canvas-mid)을 쓴다", () => {
    expect(tileVars(derived.tokens, "dark", derived.pane)["--pane"]).toBe(derived.pane);
    expect(tileVars(derived.tokens, "light")["--pane"]).toBe(derived.tokens.color.surface);
    expect(tileVars(derived.tokens, "dark")["--pane"]).toBe(derived.tokens.canvas[1]);
  });
});
