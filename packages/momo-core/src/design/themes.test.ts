import { describe, expect, it } from "vitest";
import { contrast, hueGap, oklabDistance, parseHex } from "./color";
import {
  BAND_ALLOWED_FOREGROUNDS,
  COLOR_ROLES,
  DEFAULT_THEME_ID,
  DERIVED_ROLES,
  FILL_PAIRS,
  MODES,
  NON_TEXT_FOREGROUNDS,
  SIGNAL_MIN_DISTANCE,
  TEXT_FOREGROUNDS,
  THEME_IDS,
  THEME_ID_RE,
  THEMES,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
  contrastPairs,
  type Mode,
  type ThemeId,
} from "./themes";

// =============================================================================
// ADR-0189 D5·D7 — 테마 × 모드 전 조합 대비 시험.
//
// 입력은 원천 표에서 계산한다(`contrastPairs`). 테마·역할·바닥 정지점을 더하면
// 쌍이 저절로 늘고, 늘어난 쌍이 기준 밑이면 여기서 빨개진다. 쌍 수 356은 표 §3의
// 전수 범위이고, 「계산이 무력화돼도 초록」이 되지 않도록 표 §3의 실측값 몇 개를
// 교정점으로 함께 단정한다.
// =============================================================================

const COMBOS: [ThemeId, Mode][] = THEME_IDS.flatMap((t) => MODES.map((m): [ThemeId, Mode] => [t, m]));
const PAIRS = contrastPairs();

describe("원천 표의 모양", () => {
  it("기본 테마는 목록의 첫 값이고 id는 a-z만 쓴다", () => {
    expect(DEFAULT_THEME_ID).toBe("dawnsky");
    expect(THEME_IDS).toEqual(["dawnsky", "graphite", "noeul"]);
    for (const id of THEME_IDS) expect(id).toMatch(THEME_ID_RE);
  });

  it.each(COMBOS)("%s %s: 역할 목록이 같고 값이 전부 #RRGGBB다", (theme, mode) => {
    const t = THEMES[theme][mode];
    expect(Object.keys(t.color).sort()).toEqual([...COLOR_ROLES].sort());
    expect(Object.keys(t.derived).sort()).toEqual([...DERIVED_ROLES].sort());
    const hexes = [...Object.values(t.color), ...Object.values(t.derived), ...t.canvas, ...Object.values(t.band ?? {})];
    for (const hex of hexes) expect([hex, parseHex(hex) !== null]).toEqual([hex, true]);
  });

  it.each(COMBOS)("%s %s: 순백·순흑이 없다(디자인 시스템 §2.2)", (theme, mode) => {
    const t = THEMES[theme][mode];
    const hexes = [...Object.values(t.color), ...Object.values(t.derived), ...t.canvas, ...Object.values(t.band ?? {})];
    for (const hex of hexes) expect(["#ffffff", "#000000"]).not.toContain(hex.toLowerCase());
  });

  it("띠는 노을띠에만 있고 두 모드 모두에 있다", () => {
    for (const [theme, mode] of COMBOS) {
      expect([theme, mode, THEMES[theme][mode].band !== null]).toEqual([theme, mode, theme === "noeul"]);
    }
  });

  it("primary는 잉크다(주 행동은 잉크 채움, ADR-0189 D2)", () => {
    for (const [theme, mode] of COMBOS) {
      const c = THEMES[theme][mode].color;
      expect([theme, mode, c.primary]).toEqual([theme, mode, c.ink]);
    }
  });
});

describe("전 조합 대비 — 표 §3의 356쌍", () => {
  it("쌍 수가 표 §3의 전수 범위와 같다", () => {
    // 새벽하늘 2모드 × 11전경 × (면 3 + 정지점 3) = 132
    // 평면 4조합 × 11전경 × (면 3 + 바닥 1) = 176
    // 띠 3쌍 × 노을띠 2모드 = 6, 채움 7쌍 × 6조합 = 42
    expect(TEXT_FOREGROUNDS.length + NON_TEXT_FOREGROUNDS.length).toBe(11);
    expect(FILL_PAIRS.length).toBe(7);
    expect(PAIRS.length).toBe(356);
  });

  it("테마를 더하면 입력이 저절로 는다", () => {
    const extended = { ...THEMES, extra: THEMES.graphite } as unknown as typeof THEMES;
    // 평면 테마 하나 = 2모드 × (44 + 7)
    expect(contrastPairs(extended).length).toBe(356 + 2 * (44 + 7));
  });

  it.each(PAIRS.map((p) => [`${p.theme} ${p.mode} ${p.foreground} / ${p.background} ≥ ${p.min}`, p] as const))(
    "%s",
    (_name, p) => {
      expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
    }
  );

  // 표 §3에서 옮긴 교정점. 대비 계산을 상수로 바꾸거나 원천 값이 흘러가면 여기가
  // 먼저 빨개진다. 나머지 전 행은 웹 `themes2.doc.test.ts`가 문서와 대조한다.
  it.each([
    ["dawnsky", "light", "ink", "surface", 17.77],
    ["dawnsky", "light", "icon", "canvas-bottom", 3.27],
    ["dawnsky", "dark", "ink-muted", "sheet", 7.46],
    ["graphite", "dark", "agent", "canvas", 9.66],
    ["graphite", "light", "line-strong", "sheet", 3.07],
    ["graphite", "light", "agent", "agent-soft", 4.52],
    ["noeul", "light", "signal", "band", 4.07],
    ["noeul", "dark", "on-band", "band", 16.09],
    ["noeul", "light", "on-signal", "signal", 4.85],
  ] as const)("교정: %s %s %s / %s = %s", (theme, mode, fg, bg, expected) => {
    const found = PAIRS.find(
      (p) => p.theme === theme && p.mode === mode && p.foreground === fg && p.background === bg
    );
    expect(found).toBeDefined();
    expect(contrast(found!.fg, found!.bg)).toBeCloseTo(expected, 2);
  });
});

describe("띠 위 규칙(ADR-0189 D2)", () => {
  it("띠 위 허용 목록은 on-band · on-band-muted · signal 셋뿐이다", () => {
    expect(BAND_ALLOWED_FOREGROUNDS.map(([role]) => role)).toEqual(["on-band", "on-band-muted", "signal"]);
  });

  it("목록 밖 역할은 실제로 띠 위에서 기준에 못 미친다 — 금지가 장식이 아니다", () => {
    const t = THEMES.noeul.light;
    expect(contrast(t.color.ink, t.band!.band)).toBeCloseTo(1.13, 2);
    expect(contrast(t.color.ink, t.band!.band)).toBeLessThan(4.5);
    expect(contrast(t.color["ink-muted"], t.band!.band)).toBeLessThan(4.5);
  });
});

describe("신호와 에이전트·위험의 거리(OKLab ≥ 0.07)", () => {
  it.each(COMBOS)("%s %s", (theme, mode) => {
    const c = THEMES[theme][mode].color;
    expect(oklabDistance(c.signal, c.agent)).toBeGreaterThanOrEqual(SIGNAL_MIN_DISTANCE);
    expect(oklabDistance(c.signal, c.danger)).toBeGreaterThanOrEqual(SIGNAL_MIN_DISTANCE);
    expect(oklabDistance(c.agent, c.danger)).toBeGreaterThanOrEqual(SIGNAL_MIN_DISTANCE);
  });

  it.each([
    ["dawnsky", "light", "danger", 0.082],
    ["dawnsky", "dark", "danger", 0.078],
    ["graphite", "dark", "agent", 0.191],
  ] as const)("교정: %s %s signal–%s = %s", (theme, mode, other, expected) => {
    const c = THEMES[theme][mode].color;
    expect(oklabDistance(c.signal, c[other])).toBeCloseTo(expected, 3);
  });
});

describe("표 밖 역할 — 새 표면 위 재계산, 두 자(1.05 · 0.02)", () => {
  const rulers = (a: string, b: string) => [
    contrast(a, b) >= VESSEL_MIN_CONTRAST,
    oklabDistance(a, b) >= VESSEL_MIN_DISTANCE,
  ];

  it.each(COMBOS)("%s %s: 가리킴·눌림·칩 그릇이 자기 바닥에서 살아남는다", (theme, mode) => {
    const { color: c, derived: d } = THEMES[theme][mode];
    const hosts: [string, string[]][] = [
      ["surface-hover", [c.surface, c.sheet]],
      ["surface-pressed", [c.surface, c.sheet, d["surface-hover"]]],
      ["muted-soft", [c.surface, c.sheet, d["surface-hover"], d["surface-pressed"]]],
    ];
    for (const [role, bases] of hosts) {
      for (const base of bases) {
        expect([role, base, ...rulers(d[role as keyof typeof d], base)]).toEqual([role, base, true, true]);
      }
    }
  });

  it.each(COMBOS)("%s %s: 그 채움 위에서도 본문 글자가 4.5를 넘는다", (theme, mode) => {
    const { color: c, derived: d } = THEMES[theme][mode];
    for (const fill of ["surface-hover", "surface-pressed", "muted-soft"] as const) {
      for (const ink of ["ink", "ink-muted"] as const) {
        expect([fill, ink, contrast(c[ink], d[fill]) >= 4.5]).toEqual([fill, ink, true]);
      }
    }
  });

  it.each(COMBOS)("%s %s: 위험 채움은 위험 계열이고 3·4.5를 넘는다", (theme, mode) => {
    const t = THEMES[theme][mode];
    const { color: c, derived: d } = t;
    expect(hueGap(d["danger-fill"], c.danger)).toBeLessThan(15);
    expect(contrast(d["on-danger-fill"], d["danger-fill"])).toBeGreaterThanOrEqual(4.5);
    for (const host of [c.surface, c["surface-muted"], c.sheet, ...t.canvas]) {
      expect(contrast(d["danger-fill"], host)).toBeGreaterThanOrEqual(3);
    }
  });
});
