import { describe, expect, it } from "vitest";
import { contrast, hueGap, normalizeHex, toOklch } from "./color";
import {
  GLASS_DEFAULT_OVER_FLOOR,
  GLASS_NON_TEXT_ROLES,
  GLASS_OPACITY_MAX,
  GLASS_PAGE_STEP,
  GLASS_STEP,
  GLASS_TEXT_ROLES,
  GLASS_VARS,
  GLASS_VAR_ROLES,
  firstPartyGlassSources,
  glassChrome,
  glassFloor,
  glassOpacity,
  glassRange,
  glassVariables,
  resolveGlass,
  stepGlassOpacity,
  type GlassInput,
  type GlassSource,
} from "./glass";
import {
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  blend,
  fitForeground,
  minimumScrimAlpha,
  scrimFloor,
  worstCaseBackdrops,
} from "./scrim";
import { MODES, THEME_IDS, THEMES, type Mode, type ThemeId } from "./themes";

// =============================================================================
// ADR-0189 증보 1 D4 · 증보 3 D6 (AP-3 #4190) — 유리 배경의 하한·범위·보정·판정을 **최악 입력**으로 잰다.
//
// 유리 뒤는 우리가 못 보는 데스크탑이다. 그래서 보장은 「이 데스크탑에서 읽힌다」가 아니라 「어떤
// 데스크탑이어도 읽힌다」이고, 합성의 대비는 뒤 픽셀의 휘도에 단조이므로 최악은 순흑·순백 두 끝이다
// (`scrim.ts`). 이 파일은 그 두 끝과 잡음 픽셀을 모두 잰다.
//
// 네 겹으로 묶는다.
//   1. 교정점 — 하한의 값을 리터럴로 적고, 증보 3 D6 표(`scrimFloor`)와 같은 곳·다른 곳을 가른다.
//      다른 곳은 **표의 값으로는 실제로 못 읽는다**는 실측(6.71·6.89·5.14)으로 못 박는다.
//   2. 보장 — 하한 이상의 모든 불투명도에서 주 글자 7:1, 보정된 보조 글자 4.5·표식 3(AC 6).
//   3. 사보타주 — 하한을 0.01 낮추면 같은 자가 빨개진다(실패할 수 없는 가드가 아니다).
//   4. 판정 — 쓸 수 있음·없음(95 경계 포함)·범위·값 정규화·변수·폴백 우선순위.
// =============================================================================

const COMBOS: [ThemeId, Mode][] = THEME_IDS.flatMap((t) => MODES.map((m): [ThemeId, Mode] => [t, m]));

/** 증보 3 D6 표의 여섯 값(`scrimFloor`, 바닥 가운데 정지점). 교정점이라 리터럴이다. */
const ADR_TABLE: Readonly<Record<ThemeId, Readonly<Record<Mode, number>>>> = {
  dawnsky: { light: 0.69, dark: 0.76 },
  graphite: { light: 0.65, dark: 0.73 },
  noeul: { light: 0.69, dark: 0.78 },
};

/** 칠해지는 면에서 잰 하한(이 파일이 정하는 값). 표와 다른 세 곳은 아래 「표와 다른 곳」에서 이유를 잰다. */
const FLOOR: Readonly<Record<ThemeId, Readonly<Record<Mode, number>>>> = {
  dawnsky: { light: 0.7, dark: 0.78 },
  graphite: { light: 0.65, dark: 0.73 },
  noeul: { light: 0.79, dark: 0.78 },
};

const sourceOf = (theme: ThemeId, mode: Mode): GlassSource => firstPartyGlassSources(theme)[mode] as GlassSource;

/** 결정적 의사난수(mulberry32). 시험이 흔들리지 않게 시드를 고정한다. */
function prng(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const PIXELS: readonly string[] = (() => {
  const next = prng(20261022);
  const byte = () =>
    Math.floor(next() * 256)
      .toString(16)
      .padStart(2, "0");
  return [
    "#000000",
    "#ffffff",
    "#7f7f7f",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#ffff00",
    ...Array.from({ length: 300 }, () => `#${byte()}${byte()}${byte()}`),
  ];
})();

/** 한 면의 호스트들: 바닥 정지점마다 (두 끝 + 잡음)에 α로 칠한 합성. 띠가 있으면 그 위에 띠 α를 한 번 더. */
function canvasHosts(source: GlassSource, alpha: number, pixels: readonly string[] = PIXELS): string[] {
  return source.canvas.flatMap((stop) => pixels.map((pixel) => blend(stop, pixel, alpha)));
}
function bandHostsOf(source: GlassSource, alpha: number, pixels: readonly string[] = PIXELS): string[] {
  const band = source.band;
  if (!band) return [];
  return source.canvas.flatMap((stop) =>
    pixels.map((pixel) => blend(band.band, blend(stop, pixel, alpha), alpha))
  );
}
const worstOf = (fg: string, hosts: readonly string[]): number => Math.min(...hosts.map((host) => contrast(fg, host)));

/**
 * 주 글자의 최악 대비. 두 가족을 모두 잰다: 바닥 정지점 위의 `ink`, 그리고 띠가 있으면 띠 위의 `on-band`
 * (사이드바 글자는 띠 위에 서지만, 하한은 두 가족을 모두 지키는 값이다).
 */
function primaryWorst(source: GlassSource, alpha: number, pixels: readonly string[] = PIXELS): number {
  const onCanvas = worstOf(source.color.ink, canvasHosts(source, alpha, pixels));
  const band = source.band;
  return band ? Math.min(onCanvas, worstOf(band["on-band"], bandHostsOf(source, alpha, pixels))) : onCanvas;
}

describe("교정점 — 하한은 칠해지는 면에서 잰다 (증보 3 D6)", () => {
  it("교정점: 표의 여섯 값과 이 파일의 여섯 값이 리터럴로 서 있다", () => {
    expect(THEME_IDS.length * MODES.length).toBe(6);
    expect(ADR_TABLE).toEqual({
      dawnsky: { light: 0.69, dark: 0.76 },
      graphite: { light: 0.65, dark: 0.73 },
      noeul: { light: 0.69, dark: 0.78 },
    });
    expect(FLOOR).toEqual({
      dawnsky: { light: 0.7, dark: 0.78 },
      graphite: { light: 0.65, dark: 0.73 },
      noeul: { light: 0.79, dark: 0.78 },
    });
  });

  it.each(COMBOS)("%s %s: 하한이 위 표와 같다", (theme, mode) => {
    expect(glassFloor(sourceOf(theme, mode))).toBe(FLOOR[theme][mode]);
  });

  it.each(MODES)("흑연 %s: 평면이고 띠가 없어서 증보 3 D6 표(scrimFloor)와 같은 값이다", (mode) => {
    const tokens = THEMES.graphite[mode];
    expect(new Set(tokens.canvas).size).toBe(1);
    expect(tokens.band).toBeNull();
    expect(glassFloor(sourceOf("graphite", mode))).toBe(ADR_TABLE.graphite[mode]);
    expect(glassFloor(sourceOf("graphite", mode))).toBe(scrimFloor(tokens, tokens.color.ink, INK_MIN_ON_BACKDROP));
  });

  it("평면·띠 없는 합성 바닥 여럿에서 scrimFloor와 같다(카탈로그 테마는 모두 이 모양이다)", () => {
    const next = prng(4190);
    const hex = () => {
      const channel = () =>
        Math.floor(next() * 256)
          .toString(16)
          .padStart(2, "0");
      return `#${channel()}${channel()}${channel()}`;
    };
    let compared = 0;
    for (let i = 0; i < 60; i += 1) {
      const canvas = hex();
      const ink = hex();
      const source: GlassSource = {
        canvas: [canvas, canvas, canvas],
        band: null,
        color: { ...THEMES.graphite.light.color, ink },
      };
      expect(glassFloor(source), `${canvas} ${ink}`).toBe(scrimFloor(source, ink, INK_MIN_ON_BACKDROP));
      compared += 1;
    }
    expect(compared).toBe(60);
  });

  describe("표와 다른 곳 — 표의 값으로는 칠해지는 면에서 실제로 못 읽는다 (실측)", () => {
    it("새벽하늘 다크: 표의 0.76은 위 정지점에서 잉크 6.71:1이다(순백 그림 위). 하한 0.78은 7.18이다", () => {
      const source = sourceOf("dawnsky", "dark");
      const top = source.canvas[0];
      const at = (alpha: number) => contrast(source.color.ink, worstCaseBackdrops(top, alpha)[1]);
      expect(source.canvas[1]).not.toBe(top);
      expect(ADR_TABLE.dawnsky.dark).toBe(minimumScrimAlpha(source.canvas[1], source.color.ink, INK_MIN_ON_BACKDROP));
      expect(at(0.76)).toBeCloseTo(6.71, 2);
      expect(at(0.76)).toBeLessThan(INK_MIN_ON_BACKDROP);
      expect(at(0.78)).toBeCloseTo(7.18, 2);
      expect(at(0.78)).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP);
    });

    it("새벽하늘 라이트: 표의 0.69는 아래 정지점에서 잉크 6.89:1이다(순흑 그림 위). 하한 0.70은 7.06이다", () => {
      const source = sourceOf("dawnsky", "light");
      const bottom = source.canvas[2];
      const at = (alpha: number) => contrast(source.color.ink, worstCaseBackdrops(bottom, alpha)[0]);
      expect(at(0.69)).toBeCloseTo(6.89, 2);
      expect(at(0.69)).toBeLessThan(INK_MIN_ON_BACKDROP);
      expect(at(0.7)).toBeCloseTo(7.06, 2);
      expect(at(0.7)).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP);
    });

    it("노을띠 라이트: 사이드바 글자는 띠 위의 on-band이고, 표의 0.69에서는 5.14:1이다. 하한 0.79는 7.10이다", () => {
      const source = sourceOf("noeul", "light");
      expect(source.band).not.toBeNull();
      const onBand = source.band?.["on-band"] as string;
      const worst = (alpha: number) => worstOf(onBand, bandHostsOf(source, alpha, ["#000000", "#ffffff"]));
      expect(ADR_TABLE.noeul.light).toBe(minimumScrimAlpha(source.canvas[1], source.color.ink, INK_MIN_ON_BACKDROP));
      expect(worst(0.69)).toBeCloseTo(5.14, 2);
      expect(worst(0.69)).toBeLessThan(INK_MIN_ON_BACKDROP);
      expect(worst(0.79)).toBeCloseTo(7.1, 2);
      expect(worst(0.79)).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP);
    });

    it("그 밖의 세 조합은 표와 같다(흑연 둘, 노을띠 다크)", () => {
      for (const [theme, mode] of COMBOS) {
        const differs = FLOOR[theme][mode] !== ADR_TABLE[theme][mode];
        expect(differs, `${theme} ${mode}`).toBe(
          (theme === "dawnsky") || (theme === "noeul" && mode === "light")
        );
      }
    });
  });
});

describe("보장 — 하한 이상의 모든 불투명도에서 읽힌다 (AC 6)", () => {
  it.each(COMBOS)("%s %s: 주 글자가 하한에서 95%까지 매 1%마다 순흑·순백·잡음 307픽셀 위 7:1 이상이다", (theme, mode) => {
    const source = sourceOf(theme, mode);
    const floor = Math.round(glassFloor(source) * 100);
    for (let percent = floor; percent <= GLASS_OPACITY_MAX; percent += 1) {
      expect(primaryWorst(source, percent / 100), `${theme} ${mode} ${percent}%`).toBeGreaterThanOrEqual(
        INK_MIN_ON_BACKDROP
      );
    }
  });

  it.each(COMBOS)("%s %s: 바닥 위의 보정된 보조 글자는 4.5, 아이콘·신호 표식은 3 이상이다(접힌 타이틀바처럼 띠 없이 바닥에 서는 자리)", (theme, mode) => {
    const source = sourceOf(theme, mode);
    const floor = Math.round(glassFloor(source) * 100);
    for (const percent of [floor, floor + 1, floor + 10, GLASS_OPACITY_MAX]) {
      const alpha = Math.min(percent, GLASS_OPACITY_MAX) / 100;
      const chrome = glassChrome(source, mode, Math.min(percent, GLASS_OPACITY_MAX)).canvas;
      const hosts = canvasHosts(source, alpha);
      for (const role of GLASS_TEXT_ROLES) {
        expect(worstOf(chrome[role], hosts), `${theme} ${mode} ${percent}% ${role}`).toBeGreaterThanOrEqual(
          TEXT_MIN_ON_BACKDROP
        );
      }
      for (const role of GLASS_NON_TEXT_ROLES) {
        expect(worstOf(chrome[role], hosts), `${theme} ${mode} ${percent}% ${role}`).toBeGreaterThanOrEqual(
          NON_TEXT_MIN_ON_BACKDROP
        );
      }
    }
  });

  it.each(MODES)("노을띠 %s: 띠 위에 서는 역할은 띠 호스트에서 잰다(보조 4.5, 아이콘·신호 3, on-band 계열 7)", (mode) => {
    const source = sourceOf("noeul", mode);
    const band = source.band as NonNullable<GlassSource["band"]>;
    const floor = Math.round(glassFloor(source) * 100);
    for (const percent of [floor, floor + 1, floor + 10, GLASS_OPACITY_MAX]) {
      const alpha = Math.min(percent, GLASS_OPACITY_MAX) / 100;
      const chrome = glassChrome(source, mode, Math.min(percent, GLASS_OPACITY_MAX)).band;
      const hosts = bandHostsOf(source, alpha);
      const label = `${mode} ${percent}%`;
      // tokens.css 띠 규칙: ink-muted·icon·warn → on-band-muted, agent·danger → on-band, signal → 띠 위 3:1.
      for (const role of ["ink-muted", "warn"] as const) {
        expect(worstOf(chrome[role], hosts), `${label} ${role}`).toBeGreaterThanOrEqual(TEXT_MIN_ON_BACKDROP);
      }
      expect(worstOf(chrome.icon, hosts), `${label} icon`).toBeGreaterThanOrEqual(NON_TEXT_MIN_ON_BACKDROP);
      expect(worstOf(chrome.signal, hosts), `${label} signal`).toBeGreaterThanOrEqual(NON_TEXT_MIN_ON_BACKDROP);
      for (const role of ["agent", "danger"] as const) {
        expect(chrome[role], role).toBe(normalizeHex(band["on-band"]));
        expect(worstOf(chrome[role], hosts), `${label} ${role}`).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP);
      }
    }
  });

  /** 변수 하나가 서는 자리의 원래 색: 띠 테마에서 on-band 계열로 묶이는 역할은 띠의 글자색이다(tokens.css 띠 규칙). */
  function standsFor(source: GlassSource, role: (typeof GLASS_TEXT_ROLES | typeof GLASS_NON_TEXT_ROLES)[number]): string {
    const band = source.band;
    if (!band) return source.color[role];
    if (role === "ink-muted" || role === "icon" || role === "warn") return band["on-band-muted"];
    if (role === "agent" || role === "danger") return band["on-band"];
    return source.color[role];
  }

  it.each(COMBOS)("%s %s: 보정은 명도만 옮기고 색상각은 12° 안이며, 이미 통과하는 색은 그대로다", (theme, mode) => {
    const source = sourceOf(theme, mode);
    for (const percent of [Math.round(glassFloor(source) * 100), GLASS_OPACITY_MAX]) {
      const chrome = glassChrome(source, mode, percent);
      for (const role of [...GLASS_TEXT_ROLES, ...GLASS_NON_TEXT_ROLES]) {
        expect(hueGap(chrome.band[role], standsFor(source, role)), `${percent}% band ${role}`).toBeLessThanOrEqual(12);
        expect(hueGap(chrome.canvas[role], source.color[role]), `${percent}% canvas ${role}`).toBeLessThanOrEqual(12);
      }
    }
    // 95%에서는 합성이 거의 바닥색이라, 보조 글자 가운데 손대지 않는 색이 있다.
    const chrome = glassChrome(source, mode, GLASS_OPACITY_MAX);
    const untouched = GLASS_TEXT_ROLES.filter(
      (role) => normalizeHex(chrome.band[role]) === normalizeHex(standsFor(source, role))
    );
    expect(untouched.length).toBeGreaterThan(0);
  });

  it("보정은 하한에서 가장 크게 일어나고 값이 오를수록 줄어든다(같은 역할의 이동 거리)", () => {
    const source = sourceOf("dawnsky", "light");
    const floor = Math.round(glassFloor(source) * 100);
    const moved = (percent: number) => {
      const chrome = glassChrome(source, "light", percent).canvas;
      return GLASS_TEXT_ROLES.filter(
        (role) => normalizeHex(chrome[role]) !== normalizeHex(source.color[role])
      ).length;
    };
    expect(moved(floor)).toBeGreaterThan(moved(GLASS_OPACITY_MAX));
    expect(moved(floor)).toBeGreaterThanOrEqual(moved(floor + 10));
  });

  it("보정된 signal 위의 on-signal은 4.5 이상이다(노을띠 라이트의 어두운 on-signal이 어두워진 signal 위에서 못 읽히던 자리)", () => {
    for (const [theme, mode] of COMBOS) {
      const source = sourceOf(theme, mode);
      const floor = Math.round(glassFloor(source) * 100);
      for (const percent of [floor, floor + 10, GLASS_OPACITY_MAX]) {
        const chrome = glassChrome(source, mode, Math.min(percent, GLASS_OPACITY_MAX));
        for (const family of ["canvas", "band"] as const) {
          const palette = chrome[family];
          expect(
            contrast(palette["on-signal"], palette.signal),
            `${theme} ${mode} ${percent}% ${family}`
          ).toBeGreaterThanOrEqual(TEXT_MIN_ON_BACKDROP);
        }
      }
    }
  });

  it("고른 강조색(신호)이 보정의 입력이다: 프리셋을 고르면 사이드바 신호색이 그 프리셋에서 나온다", () => {
    const base = firstPartyGlassSources("dawnsky", null).light as GlassSource;
    const preset = firstPartyGlassSources("dawnsky", { preset: "seongun" }).light as GlassSource;
    expect(preset.color.signal).not.toBe(base.color.signal);
    expect(preset.color["signal-text"]).not.toBe(base.color["signal-text"]);
    expect(preset.canvas).toEqual(base.canvas);
    const chromeBase = glassChrome(base, "light", 80).canvas;
    const chromePreset = glassChrome(preset, "light", 80).canvas;
    expect(chromePreset.signal).not.toBe(chromeBase.signal);
    // 거절되는 직접 입력은 테마 기본 신호로 그린다(사람의 선택을 지우지는 않는다).
    const rejected = firstPartyGlassSources("dawnsky", { custom: "#zzzzzz" }).light as GlassSource;
    expect(rejected.color.signal).toBe(base.color.signal);
    // 유효한 직접 입력은 보정된 값이 들어간다.
    const custom = firstPartyGlassSources("dawnsky", { custom: "#0b6e4f" }).light as GlassSource;
    expect(custom.color.signal).not.toBe(base.color.signal);
  });
});

describe("사보타주 — 하한을 낮추면 같은 자가 빨개진다", () => {
  it.each(COMBOS)("%s %s: 하한에서 지키고 0.01 낮추면 최악 입력(순흑·순백)에서 못 지킨다", (theme, mode) => {
    const source = sourceOf(theme, mode);
    const floor = glassFloor(source);
    const ends = ["#000000", "#ffffff"];
    expect(primaryWorst(source, floor, ends)).toBeGreaterThanOrEqual(INK_MIN_ON_BACKDROP);
    expect(primaryWorst(source, floor - 0.01, ends)).toBeLessThan(INK_MIN_ON_BACKDROP);
  });

  it("하한이 단조가 아닌 합성에서도 「하한 위는 모두 지킨다」: 위에서부터 내려오며 처음 어긋난 자리 다음이 하한이다", () => {
    // 회색 잉크를 오르내리며 하한을 구하고, 구한 하한 위를 모두 다시 잰다(첫 통과 α가 아니라 마지막 실패 α 다음이다).
    for (let gray = 0x20; gray <= 0x70; gray += 6) {
      const hex = `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
      const source: GlassSource = {
        canvas: ["#f0f0f0", "#f0f0f0", "#f0f0f0"],
        band: null,
        color: { ...THEMES.graphite.light.color, ink: hex },
      };
      const floor = glassFloor(source);
      for (let percent = Math.round(floor * 100); percent <= 100; percent += 1) {
        const alpha = percent / 100;
        const holds = worstOf(hex, canvasHosts(source, alpha, ["#000000", "#ffffff"])) >= INK_MIN_ON_BACKDROP;
        if (floor < 1) expect(holds, `${hex} ${percent}%`).toBe(true);
      }
    }
  });
});

describe("범위·판정 — 쓸 수 있는가 (AC 4, 증보 3 D6 불가 기준 「하한 > 0.95」)", () => {
  /** 회색 잉크를 훑어 하한이 정확히 `target`인 합성 테마를 만든다. 못 찾으면 시험이 헛도니 던진다. */
  function sourceWithFloor(target: number): GlassSource {
    for (let gray = 0x10; gray <= 0xa0; gray += 1) {
      const hex = `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
      const source: GlassSource = {
        canvas: ["#f0f0f0", "#f0f0f0", "#f0f0f0"],
        band: null,
        color: { ...THEMES.graphite.light.color, ink: hex },
      };
      if (glassFloor(source) === target) return source;
    }
    throw new Error(`하한이 ${target}인 합성 잉크를 못 찾았다`);
  }

  it("첫 파티 여섯 조합은 모두 쓸 수 있고 범위는 [하한, 95]다", () => {
    for (const [theme, mode] of COMBOS) {
      const range = glassRange(sourceOf(theme, mode));
      expect(range.usable, `${theme} ${mode}`).toBe(true);
      expect(range.min).toBe(Math.round(FLOOR[theme][mode] * 100));
      expect(range.max).toBe(95);
      expect(range.defaultPercent).toBe(Math.min(95, range.min + GLASS_DEFAULT_OVER_FLOOR));
    }
  });

  it("기본값은 하한 + 10%p다: 하한에서 열면 위계가 가장 눌린다(design-review H1) — 같은 면의 끔 상태와 잰다", () => {
    expect(GLASS_DEFAULT_OVER_FLOOR).toBe(10);
    // 띠 없는 두 테마(바닥 위에 직접 서는 글자)로 잰다. 잉크 대 보조 글자 대비가 끔 상태에 얼마나 가까운가.
    const retained = (theme: ThemeId, mode: Mode, percent: number): number => {
      const source = sourceOf(theme, mode);
      const off = contrast(source.color.ink, source.color["ink-muted"]);
      const fitted = glassChrome(source, mode, percent).canvas["ink-muted"];
      return (contrast(source.color.ink, fitted) - 1) / (off - 1);
    };
    for (const [theme, mode] of [
      ["dawnsky", "light"],
      ["dawnsky", "dark"],
      ["graphite", "light"],
      ["graphite", "dark"],
    ] as [ThemeId, Mode][]) {
      const range = glassRange(sourceOf(theme, mode));
      const atFloor = retained(theme, mode, range.min);
      const atDefault = retained(theme, mode, range.defaultPercent);
      // 실측(design-review): 하한에서 끔의 25~45%만 남는다. 기본값에서는 절반 가까이이거나 끔과 같다.
      expect(atFloor, `${theme} ${mode} 하한`).toBeLessThan(0.45);
      expect(atDefault, `${theme} ${mode} 기본값`).toBeGreaterThan(atFloor);
      expect(atDefault, `${theme} ${mode} 기본값`).toBeGreaterThanOrEqual(0.45);
    }
    // 다크는 기본값에서 끔의 위계(잉크 대 보조 글자)가 통째로 돌아온다.
    for (const theme of ["dawnsky", "graphite"] as ThemeId[]) {
      const source = sourceOf(theme, "dark");
      expect(retained(theme, "dark", glassRange(source).defaultPercent), `${theme} 기본값`).toBeGreaterThanOrEqual(0.9);
    }
  });

  // design-review 2차 High + 3차 Medium: 다크에서 위험(붉은색)을 밝히면 sRGB 경계에서 채도가 먼저 깎여 경고(호박색)보다 덜
  // 진해지는 구간이 있었고(새벽하늘 다크 78~86%, 흑연 다크 73~79%, 노을띠 다크 78~84%) 시험이 그 역전을 기대값으로 못박았다.
  // 3차는 한 걸음 더 갔다: 맨 `>`로는 동률이 통과하므로 정본 자(`tokens.contrast.test.ts`)가 비로 잰다. 위험 ÷ 경고 ≥ 1.15,
  // 경고 ÷ 보조 글자 ≥ 2, 둘 다 소수 둘째 자리로 반올림해서(`toFixed(2)`) 정본과 같은 방식으로 단정한다.
  describe("채도 순서 danger > warn > ink-muted (README §2.2, 정본 자 비 1.15·2, 모든 불투명도)", () => {
    const ratios = (palette: { danger: string; warn: string; "ink-muted": string }) => ({
      dangerOverWarn: Number((toOklch(palette.danger).C / toOklch(palette.warn).C).toFixed(2)),
      warnOverMuted: Number((toOklch(palette.warn).C / toOklch(palette["ink-muted"]).C).toFixed(2)),
    });

    it.each(COMBOS)("%s %s: 하한부터 95까지 모든 칸에서 바닥 위 순서가 정본 자를 넘는다", (theme, mode) => {
      const source = sourceOf(theme, mode);
      const floor = Math.round(glassFloor(source) * 100);
      for (let percent = floor; percent <= GLASS_OPACITY_MAX; percent += 1) {
        const { dangerOverWarn, warnOverMuted } = ratios(glassChrome(source, mode, percent).canvas);
        expect(dangerOverWarn, `${theme} ${mode} ${percent}% danger ÷ warn`).toBeGreaterThanOrEqual(1.15);
        expect(warnOverMuted, `${theme} ${mode} ${percent}% warn ÷ ink-muted`).toBeGreaterThanOrEqual(2);
      }
    });

    it("띠가 없는 테마의 띠 위 팔레트도 같은 자를 넘는다(띠 위 값은 바닥 위 값과 같다)", () => {
      for (const [theme, mode] of COMBOS) {
        const source = sourceOf(theme, mode);
        if (source.band) continue; // 띠 테마의 위험·경고는 tokens.css 띠 규칙이 on-band 계열로 묶는다(이 파일의 몫이 아님)
        const floor = Math.round(glassFloor(source) * 100);
        for (const percent of [floor, glassRange(source).defaultPercent, GLASS_OPACITY_MAX]) {
          const { dangerOverWarn } = ratios(glassChrome(source, mode, percent).band);
          expect(dangerOverWarn, `${theme} ${mode} ${percent}% band`).toBeGreaterThanOrEqual(1.15);
        }
      }
    });

    it.each(COMBOS)("%s %s: 순서를 지키려고 경고를 덜어 내도 대비·색상각 보장은 그대로다", (theme, mode) => {
      const source = sourceOf(theme, mode);
      const floor = Math.round(glassFloor(source) * 100);
      for (let percent = floor; percent <= GLASS_OPACITY_MAX; percent += 1) {
        const warn = glassChrome(source, mode, percent).canvas.warn;
        const hosts = source.canvas.flatMap((stop) => worstCaseBackdrops(stop, percent / 100));
        for (const host of hosts) {
          expect(contrast(warn, host), `${theme} ${mode} ${percent}% warn on ${host}`).toBeGreaterThanOrEqual(TEXT_MIN_ON_BACKDROP);
        }
        expect(hueGap(warn, source.color.warn), `${theme} ${mode} ${percent}% warn 색상각`).toBeLessThanOrEqual(12);
      }
    });

    it("역전이 있던 칸에서만 경고를 덜어 낸다: 순서가 이미 서 있으면 경고는 명도만 옮긴 값 그대로다", () => {
      const lightnessOnly = (source: GlassSource, mode: Mode, percent: number): string => {
        const hosts = source.canvas.flatMap((stop) => worstCaseBackdrops(stop, percent / 100));
        return fitForeground(source.color.warn, hosts, TEXT_MIN_ON_BACKDROP + FIT_MARGIN, mode);
      };
      // 라이트 전 구간과 다크 상단(자를 이미 넘는 칸): 명도만 옮긴 값과 같다(채도를 만지지 않았다).
      for (const [theme, mode, percent] of [
        ["dawnsky", "light", 70],
        ["dawnsky", "light", 80],
        ["dawnsky", "light", 95],
        ["dawnsky", "dark", 93],
        ["graphite", "dark", 88],
      ] as [ThemeId, Mode, number][]) {
        const source = sourceOf(theme, mode);
        expect(glassChrome(source, mode, percent).canvas.warn, `${theme} ${mode} ${percent}%`).toBe(
          normalizeHex(lightnessOnly(source, mode, percent))
        );
      }
      // 역전이 있던 칸(새벽하늘 다크 78%): 명도만 옮기면 경고가 위험보다 진했고, 덜어 낸 뒤에는 위험 밑이다.
      const dark = sourceOf("dawnsky", "dark");
      const floor = glassRange(dark).min;
      const palette = glassChrome(dark, "dark", floor).canvas;
      const plain = lightnessOnly(dark, "dark", floor);
      expect(toOklch(plain).C).toBeGreaterThan(toOklch(palette.danger).C);
      expect(toOklch(palette.warn).C).toBeLessThan(toOklch(palette.danger).C);
      expect(hueGap(palette.warn, plain)).toBeLessThanOrEqual(6);
    });
  });

  it("경계 95: 하한이 정확히 95%면 쓸 수 있고(범위 [95, 95]), 96%면 쓸 수 없다", () => {
    const edge = glassRange(sourceWithFloor(0.95));
    expect(edge).toEqual({ usable: true, min: 95, max: 95, defaultPercent: 95 });
    const over = glassRange(sourceWithFloor(0.96));
    expect(over.usable).toBe(false);
    expect(over.min).toBe(96);
    expect(over.min).toBeGreaterThan(over.max);
  });

  it("catppuccin-latte 모양(부드러운 잉크 `#4c4f69`, 바닥 `#eff1f5`)은 1.00이라 쓸 수 없다", () => {
    const latte: GlassSource = {
      canvas: ["#eff1f5", "#eff1f5", "#eff1f5"],
      band: null,
      color: { ...THEMES.graphite.light.color, ink: "#4c4f69" },
    };
    expect(glassFloor(latte)).toBe(1);
    expect(glassRange(latte).usable).toBe(false);
  });

  it("어느 α에서도 못 지키는 입력(잉크가 바닥과 같은 색)은 1로 닫히고 쓸 수 없다", () => {
    const flat: GlassSource = {
      canvas: ["#808080", "#808080", "#808080"],
      band: null,
      color: { ...THEMES.graphite.light.color, ink: "#808080" },
    };
    expect(glassFloor(flat)).toBe(1);
    expect(glassRange(flat).usable).toBe(false);
  });

  it("값 정규화: 없음·숫자 아님은 기본값, 하한 아래는 하한, 95 위는 95, 소수는 반올림", () => {
    const range = glassRange(sourceOf("dawnsky", "dark")); // 78..95, 기본 88(하한 + 10%p)
    expect(glassOpacity(range, undefined)).toBe(88);
    expect(glassOpacity(range, Number.NaN)).toBe(88);
    expect(glassOpacity(range, Number.POSITIVE_INFINITY)).toBe(88);
    expect(glassOpacity(range, 12)).toBe(78);
    expect(glassOpacity(range, 77)).toBe(78);
    expect(glassOpacity(range, 78)).toBe(78);
    expect(glassOpacity(range, 90.4)).toBe(90);
    expect(glassOpacity(range, 90.6)).toBe(91);
    expect(glassOpacity(range, 95)).toBe(95);
    expect(glassOpacity(range, 100)).toBe(95);
  });

  it("한 걸음 = 1, 큰 걸음 = 10, 범위 밖으로 나가지 않는다", () => {
    const range = glassRange(sourceOf("dawnsky", "light")); // 70..95
    expect(GLASS_STEP).toBe(1);
    expect(GLASS_PAGE_STEP).toBe(10);
    expect(stepGlassOpacity(range, 80, GLASS_STEP)).toBe(81);
    expect(stepGlassOpacity(range, 80, -GLASS_STEP)).toBe(79);
    expect(stepGlassOpacity(range, 80, GLASS_PAGE_STEP)).toBe(90);
    expect(stepGlassOpacity(range, 80, -GLASS_PAGE_STEP)).toBe(70);
    expect(stepGlassOpacity(range, 72, -GLASS_PAGE_STEP)).toBe(70);
    expect(stepGlassOpacity(range, 90, GLASS_PAGE_STEP)).toBe(95);
    expect(stepGlassOpacity(range, 95, GLASS_STEP)).toBe(95);
  });
});

describe("CSS 변수", () => {
  const SHAPE = /^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/;

  it("이름 집합: 모드별 색조 둘과 두 가족(바닥 위·띠 위)의 역할 아홉(보정된 여덟 + on-signal)이다", () => {
    const vars = glassVariables(firstPartyGlassSources("dawnsky"), undefined);
    expect(Object.keys(vars).sort()).toEqual(
      [
        GLASS_VARS.tintLight,
        GLASS_VARS.tintDark,
        ...GLASS_VAR_ROLES.map((role) => GLASS_VARS.role(role)),
        ...GLASS_VAR_ROLES.map((role) => GLASS_VARS.bandRole(role)),
      ].sort()
    );
    expect(GLASS_VAR_ROLES).toHaveLength(9);
    expect(GLASS_VARS.tintLight).toBe("--glass-tint-light");
    expect(GLASS_VARS.role("ink-muted")).toBe("--glass-ink-muted");
    expect(GLASS_VARS.bandRole("ink-muted")).toBe("--glass-band-ink-muted");
  });

  it("띠가 없는 테마는 두 가족의 값이 같고, 띠가 있는 테마(노을띠)는 보조 글자가 갈린다", () => {
    const flat = glassVariables(firstPartyGlassSources("graphite"), 83);
    for (const role of GLASS_VAR_ROLES) {
      expect(flat[GLASS_VARS.bandRole(role)], role).toBe(flat[GLASS_VARS.role(role)]);
    }
    const banded = glassVariables(firstPartyGlassSources("noeul"), 83);
    expect(banded[GLASS_VARS.bandRole("ink-muted")]).not.toBe(banded[GLASS_VARS.role("ink-muted")]);
    // 띠 위 에이전트·위험은 on-band 한 색이다(두 모드 모두).
    expect(banded[GLASS_VARS.bandRole("agent")]).toBe(banded[GLASS_VARS.bandRole("danger")]);
  });

  it("역할 값은 `light-dark(색, 색)` 리터럴이다(중첩 var()·알파·함수 없음)", () => {
    for (const theme of THEME_IDS) {
      const vars = glassVariables(firstPartyGlassSources(theme), 83);
      for (const role of GLASS_VAR_ROLES) {
        expect(vars[GLASS_VARS.role(role)], `${theme} ${role}`).toMatch(SHAPE);
        expect(vars[GLASS_VARS.bandRole(role)], `${theme} band ${role}`).toMatch(SHAPE);
      }
    }
  });

  it("모드마다 자기 하한으로 닫힌다: 저장된 값이 한쪽 하한 아래이면 그쪽만 올라간다", () => {
    // 새벽하늘은 라이트 70, 다크 78이다. 저장 74는 라이트에서 74, 다크에서 78이다.
    const vars = glassVariables(firstPartyGlassSources("dawnsky"), 74);
    expect(vars[GLASS_VARS.tintLight]).toBe("74%");
    expect(vars[GLASS_VARS.tintDark]).toBe("78%");
    // 저장이 없으면 모드마다 자기 하한 + 10%p다(라이트 80, 다크 88).
    const defaults = glassVariables(firstPartyGlassSources("dawnsky"), undefined);
    expect(defaults[GLASS_VARS.tintLight]).toBe("80%");
    expect(defaults[GLASS_VARS.tintDark]).toBe("88%");
  });

  it("값이 바뀌면 보정 색도 바뀐다(하한 근처와 95%의 보조 글자색이 다르다)", () => {
    const low = glassVariables(firstPartyGlassSources("dawnsky"), 70);
    const high = glassVariables(firstPartyGlassSources("dawnsky"), 95);
    expect(low[GLASS_VARS.role("ink-muted")]).not.toBe(high[GLASS_VARS.role("ink-muted")]);
  });

  it("쓸 수 없는 모드 칸은 최대 95로 닫힌다(소비자가 그 모드에서 켜지 않으므로 값은 닿지 않는다)", () => {
    const unusable: GlassSource = {
      canvas: ["#eff1f5", "#eff1f5", "#eff1f5"],
      band: null,
      color: { ...THEMES.graphite.light.color, ink: "#4c4f69" },
    };
    const vars = glassVariables({ light: unusable, dark: sourceOf("graphite", "dark") }, 80);
    expect(vars[GLASS_VARS.tintLight]).toBe("95%");
    expect(vars[GLASS_VARS.tintDark]).toBe("80%");
  });

  it("단일 모드 테마는 있는 모드의 값을 두 칸에 쓴다. 모드가 없으면 변수도 없다", () => {
    const only = glassVariables({ dark: sourceOf("graphite", "dark") }, 80);
    expect(only[GLASS_VARS.tintLight]).toBe(only[GLASS_VARS.tintDark]);
    const role = only[GLASS_VARS.role("ink-muted")];
    expect(role).toMatch(SHAPE);
    expect(role.slice("light-dark(".length, "light-dark(#000000".length)).toBe(
      role.slice("light-dark(#000000, ".length, "light-dark(#000000, #000000".length)
    );
    expect(glassVariables({}, 80)).toEqual({});
  });
});

describe("resolveGlass — 폴백 세 갈래와 우선순위 (증보 1 D4)", () => {
  const base: GlassInput = {
    on: true,
    supported: true,
    floorPercent: 70,
    wallpaper: false,
    failed: false,
    reducedTransparency: false,
  };
  const decide = (patch: Partial<GlassInput>) => resolveGlass({ ...base, ...patch });

  it("켬: 그린다", () => {
    expect(decide({})).toEqual({
      reason: null,
      toggleDisabled: false,
      checked: true,
      nativeWanted: true,
      paintWanted: true,
    });
  });

  it("꺼짐: 이유도 잠김도 없다", () => {
    expect(decide({ on: false })).toEqual({
      reason: null,
      toggleDisabled: false,
      checked: false,
      nativeWanted: false,
      paintWanted: false,
    });
  });

  it("폴백 1 미지원(브라우저·다른 OS): 스위치는 잠기고 꺼진 것으로 보이며 아무것도 그리지 않는다(저장값은 상관없다)", () => {
    for (const on of [true, false]) {
      expect(decide({ supported: false, on })).toEqual({
        reason: "unsupported",
        toggleDisabled: true,
        checked: false,
        nativeWanted: false,
        paintWanted: false,
      });
    }
  });

  it("폴백 2 투명도 줄이기·고대비: 스위치는 켠 채로 두고(눌러 끌 수 있다) 그리지 않는다. 네이티브는 깔린 채다", () => {
    expect(decide({ reducedTransparency: true })).toEqual({
      reason: "reduced-transparency",
      toggleDisabled: false,
      checked: true,
      nativeWanted: true,
      paintWanted: false,
    });
  });

  it("폴백 3 켜기 실패: 스위치를 끈 것으로 보이고(다시 눌러 볼 수 있다) 아무것도 그리지 않는다. 저장된 켬이 꺼진 뒤에도 문장은 남는다", () => {
    const failed = {
      reason: "failed",
      toggleDisabled: false,
      checked: false,
      nativeWanted: false,
      paintWanted: false,
    };
    expect(decide({ failed: true })).toEqual(failed);
    // 창 쪽 일이 실패하면 저장된 켬을 끈다. 그 뒤에도 사람이 다시 만질 때까지 문장이 서 있다.
    expect(decide({ failed: true, on: false })).toEqual(failed);
  });

  it("쓸 수 없는 테마(하한 > 95): 잠기고 이유를 말한다. 95는 쓸 수 있고 96은 쓸 수 없다", () => {
    expect(decide({ floorPercent: 96 })).toMatchObject({ reason: "unusable", toggleDisabled: true, checked: false });
    expect(decide({ floorPercent: 100 })).toMatchObject({ reason: "unusable", toggleDisabled: true });
    expect(decide({ floorPercent: 95 })).toMatchObject({ reason: null, toggleDisabled: false, paintWanted: true });
  });

  it("배경화면이 켜져 있으면(결정 9) 잠기고 이유를 말한다. 저장된 켬은 지우지 않으므로 끄면 돌아온다", () => {
    expect(decide({ wallpaper: true })).toMatchObject({ reason: "wallpaper", toggleDisabled: true, checked: false, paintWanted: false });
    expect(decide({ wallpaper: true, on: false })).toMatchObject({ reason: "wallpaper", toggleDisabled: true });
    expect(decide({ wallpaper: false })).toMatchObject({ reason: null, paintWanted: true });
  });

  it("테마의 색을 아직 못 읽은 동안(floorPercent null): 켠 채로 두고 네이티브도 그림도 하지 않는다", () => {
    expect(decide({ floorPercent: null })).toEqual({
      reason: null,
      toggleDisabled: false,
      checked: true,
      nativeWanted: false,
      paintWanted: false,
    });
    expect(decide({ floorPercent: null, on: false })).toMatchObject({ checked: false, nativeWanted: false });
  });

  it("우선순위: 미지원 > 불가 > 배경화면 > 켜기 실패 > (꺼짐) > 투명도 줄이기", () => {
    const all = { supported: false, floorPercent: 99, wallpaper: true, failed: true, reducedTransparency: true };
    expect(decide(all).reason).toBe("unsupported");
    expect(decide({ ...all, supported: true }).reason).toBe("unusable");
    expect(decide({ ...all, supported: true, floorPercent: 70 }).reason).toBe("wallpaper");
    expect(decide({ ...all, supported: true, floorPercent: 70, wallpaper: false }).reason).toBe("failed");
    expect(decide({ ...all, supported: true, floorPercent: 70, wallpaper: false, failed: false }).reason).toBe(
      "reduced-transparency"
    );
    // 꺼짐은 투명도 줄이기 문장을 끌고 오지 않는다(켜기 실패 문장은 위에서 따로 남는다).
    expect(decide({ on: false, reducedTransparency: true }).reason).toBeNull();
  });

  it("네이티브를 원하는 것은 켬과 투명도 줄이기뿐이고, 그림을 원하는 것은 켬뿐이다", () => {
    const grid = [
      { on: true },
      { on: false },
      { on: true, failed: true },
      { on: true, reducedTransparency: true },
      { on: true, wallpaper: true },
      { on: true, floorPercent: 99 },
      { on: true, supported: false },
      { on: true, floorPercent: null },
    ] as const;
    const native = grid.filter((patch) => decide(patch).nativeWanted).map((patch) => JSON.stringify(patch));
    const paint = grid.filter((patch) => decide(patch).paintWanted).map((patch) => JSON.stringify(patch));
    expect(native).toEqual([JSON.stringify({ on: true }), JSON.stringify({ on: true, reducedTransparency: true })]);
    expect(paint).toEqual([JSON.stringify({ on: true })]);
  });
});
