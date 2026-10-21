import { describe, expect, it } from "vitest";
import { contrast, fromOklch, hueGap, normalizeHex, toOklch } from "./color";
import {
  BACKDROP_SCRIM_ALPHA,
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  blend,
  fitForeground,
  holdsOnBoth,
  minimumScrimAlpha,
  scrimColor,
  scrimFloor,
  worstCaseBackdrops,
} from "./scrim";
import { MODES, THEME_IDS, THEMES, type Mode, type ThemeId } from "./themes";

// =============================================================================
// ADR-0189 증보 2 (#3907) → core 이전 AP-1c (#4187) — 배경 위 글자 대비를 **최악 입력**으로 잰다.
//
// 그림은 우리가 못 보는 입력이다. 그래서 보장은 「이 그림에서 읽힌다」가 아니라 「어떤 그림이어도
// 읽힌다」다. scrim 합성의 대비는 그림 픽셀의 휘도에 단조이므로 최악은 순흑 그림·순백 그림 둘이고,
// 이 파일은 그 둘과 잡음(결정적 의사난수 픽셀 수백 개)을 잰다.
//
// 이 파일은 산수를 **세 겹**으로 묶는다.
//   1. 교정점 — ADR 증보 2 표의 여섯 값(0.69/0.76 · 0.65/0.73 · 0.69/0.78)을 리터럴로 적어, 산수
//      함수가 통째로 틀어지면 「계산 대 계산」의 초록이 아니라 숫자에서 빨개지게 한다.
//   2. 토큰 — `BACKDROP_SCRIM_ALPHA` 는 눈대중이 아니다. 같은 산수로 다시 구해 대조하고, **토큰을
//      낮추면 빨개진다**는 것을 사보타주로 보인다(실패할 수 없는 가드가 아니다).
//   3. 보정 — `fitForeground` 는 명도만 옮긴다. 색상각 변화 12° 이하를 첫 파티 역할과 색상환
//      격자에서 단정하고, 단정이 헛돌지 않도록 「실제로 옮겨진 색」의 수도 함께 센다.
// =============================================================================

const COMBOS: [ThemeId, Mode][] = THEME_IDS.flatMap((t) => MODES.map((m): [ThemeId, Mode] => [t, m]));

/** ADR-0189 증보 2 D3의 표 — 잉크 7:1에 필요한 최소 불투명도(0.01 올림). 교정점이라 리터럴이다. */
const ADR_FLOOR: Readonly<Record<ThemeId, Readonly<Record<Mode, number>>>> = {
  dawnsky: { light: 0.69, dark: 0.76 },
  graphite: { light: 0.65, dark: 0.73 },
  noeul: { light: 0.69, dark: 0.78 },
};

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

function noisyPixels(count: number, seed: number): string[] {
  const next = prng(seed);
  const byte = () =>
    Math.floor(next() * 256)
      .toString(16)
      .padStart(2, "0");
  return Array.from({ length: count }, () => `#${byte()}${byte()}${byte()}`);
}

/** 극단 일곱 + 잡음 300 = 307픽셀 — 「잡음이 낀 사진」의 대리. 폰 시험(#3907)과 같은 시드다. */
const PIXELS: readonly string[] = [
  "#000000",
  "#ffffff",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  ...noisyPixels(300, 20261016),
];

const canvasMid = (theme: ThemeId, mode: Mode): string => THEMES[theme][mode].canvas[1];
const inkOf = (theme: ThemeId, mode: Mode): string => THEMES[theme][mode].color.ink;

describe("scrimFloor — ADR-0189 증보 2 표를 재현한다 (AC 1)", () => {
  it("교정점: 표의 여섯 값이 리터럴로 서 있다", () => {
    expect(THEME_IDS.length * MODES.length).toBe(6);
    expect(ADR_FLOOR).toEqual({
      dawnsky: { light: 0.69, dark: 0.76 },
      graphite: { light: 0.65, dark: 0.73 },
      noeul: { light: 0.69, dark: 0.78 },
    });
  });

  it.each(COMBOS)("%s %s: 잉크 7:1 하한이 표와 같다", (theme, mode) => {
    const tokens = THEMES[theme][mode];
    expect(scrimFloor(tokens, tokens.color.ink, INK_MIN_ON_BACKDROP)).toBe(ADR_FLOOR[theme][mode]);
  });

  it.each(COMBOS)("%s %s: 하한은 진짜 최소다 — 하한에서 지키고 0.01 얇으면 못 지킨다", (theme, mode) => {
    const floor = scrimFloor(THEMES[theme][mode], inkOf(theme, mode), INK_MIN_ON_BACKDROP);
    const canvas = canvasMid(theme, mode);
    expect(holdsOnBoth(inkOf(theme, mode), worstCaseBackdrops(canvas, floor), INK_MIN_ON_BACKDROP)).toBe(true);
    expect(holdsOnBoth(inkOf(theme, mode), worstCaseBackdrops(canvas, floor - 0.01), INK_MIN_ON_BACKDROP)).toBe(false);
  });

  it("바닥의 가운데 정지점(canvas-mid)을 쓴다 — 위·아래 정지점으로는 같은 답이 나오지 않는다", () => {
    // 새벽하늘 다크는 세 정지점이 모두 다르다. 표의 0.76 은 가운데 정지점에서만 나온다.
    const dawn = THEMES.dawnsky.dark;
    const byStop = dawn.canvas.map((stop) => minimumScrimAlpha(stop, dawn.color.ink, INK_MIN_ON_BACKDROP));
    expect(byStop).toEqual([0.78, 0.76, 0.74]);
    expect(scrimFloor(dawn, dawn.color.ink, INK_MIN_ON_BACKDROP)).toBe(byStop[1]);

    // 합성 바닥: 위·아래 정지점은 잉크와 같은 색이라 어떤 두께로도 못 지킨다(1). 가운데만 설 수 있다.
    const synthetic = { canvas: ["#101010", "#f0f0f0", "#101010"] } as const;
    const floor = scrimFloor(synthetic, "#101010", INK_MIN_ON_BACKDROP);
    expect(floor).toBe(minimumScrimAlpha("#f0f0f0", "#101010", INK_MIN_ON_BACKDROP));
    expect(floor).toBeLessThan(1);
    expect(minimumScrimAlpha("#101010", "#101010", INK_MIN_ON_BACKDROP)).toBe(1);
  });

  it("요구 대비가 커질수록 하한은 커지거나 같다(3 ≤ 4.5 ≤ 7)", () => {
    for (const [theme, mode] of COMBOS) {
      const tokens = THEMES[theme][mode];
      const floors = [NON_TEXT_MIN_ON_BACKDROP, TEXT_MIN_ON_BACKDROP, INK_MIN_ON_BACKDROP].map((min) =>
        scrimFloor(tokens, tokens.color.ink, min)
      );
      expect([theme, mode, floors[0] <= floors[1] && floors[1] <= floors[2]]).toEqual([theme, mode, true]);
    }
  });

  it("경계: 요구가 1:1이면 겹이 필요 없고(0), 바닥과 같은 색의 잉크는 1로 닫힌다", () => {
    const tokens = THEMES.dawnsky.light;
    expect(scrimFloor(tokens, tokens.color.ink, 1)).toBe(0);
    expect(scrimFloor({ canvas: tokens.canvas }, tokens.canvas[1], INK_MIN_ON_BACKDROP)).toBe(1);
  });

  it("잘못된 바닥색은 조용히 통과하지 않고 던진다", () => {
    expect(() => scrimFloor({ canvas: ["#fff", "#fff", "#fff"] }, "#000000", INK_MIN_ON_BACKDROP)).toThrow();
  });
});

describe("scrim 불투명도 토큰은 산수의 결과다 (AC 2)", () => {
  it.each(MODES)("%s — 여섯 조합 중 가장 큰 「잉크 7:1 최소 불투명도」 이상이고 0.02 넘게 두껍지 않다", (mode) => {
    const needed = THEME_IDS.map((theme) =>
      scrimFloor(THEMES[theme][mode], inkOf(theme, mode), INK_MIN_ON_BACKDROP)
    );
    const worst = Math.max(...needed);
    expect(BACKDROP_SCRIM_ALPHA[mode]).toBeGreaterThanOrEqual(worst);
    // 필요 이상으로 두꺼우면 그림이 괜히 더 흐려진다 — 성재가 받아들인 「조금 흐리게」의 한도.
    expect(BACKDROP_SCRIM_ALPHA[mode]).toBeLessThanOrEqual(worst + 0.02);
  });

  it("토큰의 값: 라이트 0.70, 다크 0.78 (증보 2 D3)", () => {
    expect(BACKDROP_SCRIM_ALPHA).toEqual({ light: 0.7, dark: 0.78 });
  });

  it("사보타주 — 토큰을 0.15 낮추면 같은 자가 최악 입력에서 빨개진다", () => {
    for (const [theme, mode] of COMBOS) {
      const ink = inkOf(theme, mode);
      const canvas = canvasMid(theme, mode);
      const thin = BACKDROP_SCRIM_ALPHA[mode] - 0.15;
      expect([theme, mode, holdsOnBoth(ink, worstCaseBackdrops(canvas, thin), INK_MIN_ON_BACKDROP)]).toEqual([
        theme,
        mode,
        false,
      ]);
      expect([
        theme,
        mode,
        holdsOnBoth(ink, worstCaseBackdrops(canvas, BACKDROP_SCRIM_ALPHA[mode]), INK_MIN_ON_BACKDROP),
      ]).toEqual([theme, mode, true]);
    }
  });

  it("scrim 색은 바닥색에 모드별 불투명도를 단 #rrggbbaa 다", () => {
    for (const [theme, mode] of COMBOS) {
      const color = scrimColor(canvasMid(theme, mode), BACKDROP_SCRIM_ALPHA[mode]);
      expect(color).toHaveLength(9);
      expect(color.slice(0, 7)).toBe(normalizeHex(canvasMid(theme, mode)));
      expect(color.slice(7)).toBe(Math.round(BACKDROP_SCRIM_ALPHA[mode] * 255).toString(16));
    }
    // 교정점: 알파 바이트는 반올림이다(0.70 → 178.5 → 0xb3, 0.78 → 198.9 → 0xc7).
    expect(scrimColor("#EFEDEA", 0.7)).toBe("#efedeab3");
    expect(scrimColor("#171A20", 0.78)).toBe("#171a20c7");
    expect(scrimColor("#171A20", 0)).toBe("#171a2000");
    expect(scrimColor("#171A20", 1)).toBe("#171a20ff");
  });
});

describe("합성 산수의 기본 — blend · worstCaseBackdrops", () => {
  it("blend: 불투명도 0 은 아래 그림 그대로, 1 은 위 면 그대로, 0.5 는 반올림한 중간", () => {
    expect(blend("#102030", "#ffeedd", 0)).toBe("#ffeedd");
    expect(blend("#102030", "#ffeedd", 1)).toBe("#102030");
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blend("#FF0000", "#0000FF", 0.25)).toBe("#4000bf");
  });

  it("worstCaseBackdrops: 두 끝은 순흑·순백 그림 위 합성이다", () => {
    expect(worstCaseBackdrops("#EFEDEA", 0)).toEqual(["#000000", "#ffffff"]);
    expect(worstCaseBackdrops("#EFEDEA", 1)).toEqual(["#efedea", "#efedea"]);
    const [black, white] = worstCaseBackdrops("#EFEDEA", 0.7);
    expect(black).toBe(blend("#EFEDEA", "#000000", 0.7));
    expect(white).toBe(blend("#EFEDEA", "#ffffff", 0.7));
  });

  it("holdsOnBoth: 두 끝 모두에서 지켜야 참이다(한쪽만이면 거짓)", () => {
    // 어두운 글자는 순백 쪽 합성에서는 잘 읽히지만 순흑 쪽 합성에서는 덜 읽힌다.
    const hosts = worstCaseBackdrops("#EFEDEA", 0.5);
    const ink = "#16171B";
    const [onBlack, onWhite] = hosts.map((host) => contrast(ink, host));
    expect(onWhite).toBeGreaterThan(onBlack);
    expect(holdsOnBoth(ink, hosts, (onBlack + onWhite) / 2)).toBe(false);
    expect(holdsOnBoth(ink, hosts, onBlack)).toBe(true);
  });
});

describe.each(COMBOS)("%s/%s — 어떤 그림 위에서도", (theme, mode) => {
  const ink = inkOf(theme, mode);
  const canvas = canvasMid(theme, mode);
  const alpha = BACKDROP_SCRIM_ALPHA[mode];

  it("잉크가 순흑·순백·잡음 픽셀 위 합성에서 7:1 이상이다", () => {
    const low = PIXELS.map((pixel) => ({ pixel, ratio: contrast(ink, blend(canvas, pixel, alpha)) })).filter(
      (entry) => entry.ratio < INK_MIN_ON_BACKDROP
    );
    expect(low).toEqual([]);
  });

  it("최악은 정말 두 끝이다 — 어떤 픽셀의 합성도 두 끝 중 나쁜 쪽보다 나쁘지 않다", () => {
    const ends = worstCaseBackdrops(canvas, alpha).map((host) => contrast(ink, host));
    const floor = Math.min(...ends);
    const below = PIXELS.filter((pixel) => contrast(ink, blend(canvas, pixel, alpha)) < floor - 1e-9);
    expect(below).toEqual([]);
  });

  it("잉크는 보정이 건드리지 않는다 — 불투명도 자체가 7:1 을 지키기 때문이다", () => {
    const hosts = worstCaseBackdrops(canvas, alpha);
    expect(fitForeground(ink, hosts, TEXT_MIN_ON_BACKDROP + FIT_MARGIN, mode)).toBe(normalizeHex(ink));
  });
});

// ---- fitForeground — 명도만 옮긴다 (AC 3) -----------------------------------

/** 폰 `paletteFrom(…, onImage)` 가 보정하는 역할과 요구 대비(`DS2_ROLE_MAP` 의 core 쪽 이름). */
const FIT_ROLES = [
  ["ink-muted", TEXT_MIN_ON_BACKDROP],
  ["signal-text", TEXT_MIN_ON_BACKDROP],
  ["agent", TEXT_MIN_ON_BACKDROP],
  ["warn", TEXT_MIN_ON_BACKDROP],
  ["danger", TEXT_MIN_ON_BACKDROP],
  ["ok", TEXT_MIN_ON_BACKDROP],
  ["line-strong", NON_TEXT_MIN_ON_BACKDROP],
  ["icon", NON_TEXT_MIN_ON_BACKDROP],
  ["signal", NON_TEXT_MIN_ON_BACKDROP],
] as const;

/** 무채색에 가까운 색은 8비트 반올림만으로 색상각이 흔들려 색상각이 의미 없다. */
const MIN_CHROMA_FOR_HUE = 0.04;
/** 보정이 색상각을 움직여도 되는 한계(ADR-0189 증보 2 D4). */
const MAX_HUE_SHIFT = 12;

describe("fitForeground — 명도만 옮기고 색상각을 지킨다", () => {
  const lightHosts = worstCaseBackdrops(canvasMid("dawnsky", "light"), BACKDROP_SCRIM_ALPHA.light);
  const darkHosts = worstCaseBackdrops(canvasMid("dawnsky", "dark"), BACKDROP_SCRIM_ALPHA.dark);

  it("이미 통과하는 색은 입력 그대로(소문자 정규화만), 못 넘는 색은 모드의 방향으로만 옮긴다", () => {
    // 라이트: 아주 어두운 글자는 이미 통과 → 그대로.
    expect(fitForeground("#101010", lightHosts, 4.5, "light")).toBe("#101010");
    expect(fitForeground("#F1F1F3", darkHosts, 4.5, "dark")).toBe("#f1f1f3");

    // 라이트: 연한 호박은 못 넘는다 → 더 어두워지고 색상각은 거의 그대로다.
    const amber = "#D9902F";
    const fitted = fitForeground(amber, lightHosts, 4.5, "light");
    expect(fitted).not.toBe(amber.toLowerCase());
    expect(toOklch(fitted).L).toBeLessThan(toOklch(amber).L);
    expect(holdsOnBoth(fitted, lightHosts, 4.5)).toBe(true);
    expect(hueGap(amber, fitted)).toBeLessThanOrEqual(MAX_HUE_SHIFT);

    // 다크: 어두운 글자는 못 넘는다 → 더 밝아진다.
    const navy = "#3A4A8C";
    const lifted = fitForeground(navy, darkHosts, 4.5, "dark");
    expect(toOklch(lifted).L).toBeGreaterThan(toOklch(navy).L);
    expect(holdsOnBoth(lifted, darkHosts, 4.5)).toBe(true);
    expect(hueGap(navy, lifted)).toBeLessThanOrEqual(MAX_HUE_SHIFT);
  });

  it.each(COMBOS)("%s %s: 첫 파티 역할이 하한 + 여유로 서고, 방향과 색상각을 지킨다", (theme, mode) => {
    const tokens = THEMES[theme][mode];
    const hosts = worstCaseBackdrops(tokens.canvas[1], BACKDROP_SCRIM_ALPHA[mode]);
    const failures: string[] = [];
    let moved = 0;
    let hueChecked = 0;
    for (const [role, min] of FIT_ROLES) {
      const input = tokens.color[role];
      const fitted = fitForeground(input, hosts, min + FIT_MARGIN, mode);
      if (!holdsOnBoth(fitted, hosts, min + FIT_MARGIN)) failures.push(`${role}: 하한 + 여유 미달`);
      const before = toOklch(input);
      const after = toOklch(fitted);
      if (normalizeHex(input) !== fitted) {
        moved += 1;
        const wrongWay = mode === "light" ? after.L > before.L : after.L < before.L;
        if (wrongWay) failures.push(`${role}: 반대 방향으로 옮겼다`);
      }
      if (before.C >= MIN_CHROMA_FOR_HUE) {
        hueChecked += 1;
        const gap = hueGap(input, fitted);
        if (gap > MAX_HUE_SHIFT) failures.push(`${role}: 색상각 ${gap.toFixed(1)}° 이동`);
      }
    }
    expect(failures).toEqual([]);
    // 단정이 헛돌지 않게: 옮겨진 색이 있어야 방향·색상각 단정이 뜻을 가진다.
    expect(moved).toBeGreaterThanOrEqual(5);
    expect(hueChecked).toBeGreaterThanOrEqual(5);
  });

  it("색상환 격자 — 채도가 있는 어떤 색도 색상각을 12° 넘게 옮기지 않는다", () => {
    let checked = 0;
    let moved = 0;
    const failures: string[] = [];
    for (const mode of MODES) {
      const hosts = worstCaseBackdrops(canvasMid("dawnsky", mode), BACKDROP_SCRIM_ALPHA[mode]);
      for (let h = 0; h < 360; h += 15) {
        for (const C of [0.06, 0.15, 0.3]) {
          for (const L of [0.3, 0.6, 0.9]) {
            const input = fromOklch({ L, C, h });
            if (toOklch(input).C < MIN_CHROMA_FOR_HUE) continue;
            checked += 1;
            const fitted = fitForeground(input, hosts, TEXT_MIN_ON_BACKDROP + FIT_MARGIN, mode);
            if (fitted !== input) moved += 1;
            const gap = hueGap(input, fitted);
            if (gap > MAX_HUE_SHIFT) failures.push(`${mode} ${input} -> ${fitted}: ${gap.toFixed(1)}°`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // 격자가 비어 있거나 아무것도 안 움직였다면 위 단정은 아무것도 재지 못한 것이다.
    expect(checked).toBeGreaterThan(200);
    expect(moved).toBeGreaterThan(100);
  });

  it("명도 끝까지 가도 못 넘으면 끝값을 돌려준다(던지지 않는다)", () => {
    const hosts = ["#808080"];
    const darkest = fitForeground("#5A5C64", hosts, 21, "light");
    const lightest = fitForeground("#A4A7B0", hosts, 21, "dark");
    expect(holdsOnBoth(darkest, hosts, 21)).toBe(false);
    expect(holdsOnBoth(lightest, hosts, 21)).toBe(false);
    expect(toOklch(darkest).L).toBeGreaterThan(0.115);
    expect(toOklch(darkest).L).toBeLessThan(0.13);
    expect(toOklch(lightest).L).toBeGreaterThan(0.96);
    expect(toOklch(lightest).L).toBeLessThan(0.975);
  });

  it("잘못된 색은 조용히 통과하지 않고 던진다", () => {
    expect(() => fitForeground("not-a-color", lightHosts, 4.5, "light")).toThrow();
    expect(() => minimumScrimAlpha("#fff", "#000000", INK_MIN_ON_BACKDROP)).toThrow();
  });
});
