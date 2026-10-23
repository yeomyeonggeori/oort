import { describe, expect, it } from "vitest";
import { contrast, hueGap, normalizeHex, parseHex } from "./color";
import {
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  blend,
  holdsOnBoth,
  minimumScrimAlpha,
  scrimColor,
  worstCaseBackdrops,
} from "./scrim";
import { SIGNAL_PRESET_IDS, resolvePreset, resolveSignal, type SignalValues } from "./signal";
import { MODES, THEME_IDS, THEMES, type Mode, type ThemeId } from "./themes";
import {
  IMPORT_FAILURE_COPY,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_LONG_SIDE,
  PHOTO_MAX_SOURCE_BYTES,
  PHOTO_MAX_SOURCE_PIXELS,
  PHOTO_THUMB_LONG_SIDE,
  PRESET_IDS,
  QUALITY_STEPS,
  SIDE_FACTORS,
  SOLID_IDS,
  WALLPAPER_BLURRY_MIN_PERCENT,
  WALLPAPER_COPY,
  WALLPAPER_NON_TEXT_ROLES,
  WALLPAPER_OFF_COPY,
  WALLPAPER_PRESETS,
  WALLPAPER_SOLIDS,
  WALLPAPER_TEXT_ROLES,
  WALLPAPER_USABLE_MAX_PERCENT,
  WALLPAPER_VARS,
  WALLPAPER_VAR_ROLES,
  importPhoto,
  isKnownWallpaper,
  isPresetId,
  isSolidId,
  resolveWallpaper,
  wallpaperBlocksGlass,
  wallpaperLabel,
  wallpaperTokensOf,
  wallpaperTreatment,
  wallpaperVars,
  type PhotoPorts,
  type WallpaperDecisionInput,
  type WallpaperTokens,
  type WallpaperTreatment,
} from "./wallpaper";

// =============================================================================
// 웹·데스크탑 배경화면의 산수와 판정 (ADR-0189 증보 3 D4·D6, AP-4 #4191).
//
// 그림은 우리가 못 보는 입력이다. 그래서 보장은 「이 그림에서 읽힌다」가 아니라 「어떤 그림이어도 읽힌다」이고,
// 이 파일은 순흑·순백 그림 두 끝과 결정적 의사난수 픽셀 307개를 잰다(폰 `backdropScrim.test.ts`와 같은 방식).
//
// 세 겹으로 묶는다.
//   1. 교정점: ADR 증보 2·3 표의 여섯 값(0.69/0.76 · 0.65/0.73 · 0.69/0.78)을 **리터럴**로 적는다. 산수가 통째로
//      틀어지면 「계산 대 계산」의 초록이 아니라 숫자에서 빨개진다.
//   2. 토큰 = 재계산: 깔리는 불투명도·색이 같은 산수로 다시 구한 값과 같다. 불투명도를 0.15 낮추면 같은 자가
//      최악 입력에서 빨개진다(사보타주).
//   3. 보정: 명도만 옮기고(색상각 12도 이하) 잉크는 손대지 않는다.
// 카탈로그 57 테마-모드는 이 파일이 아니라 웹 쪽 `wallpaper.catalog.test.ts`가 잰다(파생 엔진이 들어오는 순간
// 저절로 켜지는 짝 시험). 여기서는 같은 산수를 의사난수 테마 수백 개로도 재서 첫 파티에만 맞춘 숫자가
// 아님을 보인다.
// =============================================================================

const COMBOS: [ThemeId, Mode][] = THEME_IDS.flatMap((t) => MODES.map((m): [ThemeId, Mode] => [t, m]));

/** ADR-0189 증보 2 D3의 표: 잉크 7:1에 필요한 최소 불투명도(0.01 올림). 교정점이라 리터럴이다. */
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

function randomHex(next: () => number): string {
  const byte = () =>
    Math.floor(next() * 256)
      .toString(16)
      .padStart(2, "0");
  return `#${byte()}${byte()}${byte()}`;
}

/** 바닥에서 순흑이나 순백 쪽(대비가 큰 쪽)으로 걸어 처음으로 `target` 대비에 닿는 색. 닿지 못하면 그 끝이다. */
function inkAtContrast(canvas: string, target: number): string {
  const from = parseHex(canvas);
  if (!from) throw new Error(`not a color: ${canvas}`);
  const end = contrast(canvas, "#000000") >= contrast(canvas, "#ffffff") ? 0 : 255;
  const hex = (t: number) =>
    `#${from
      .map((value) =>
        Math.round(value + (end - value) * t)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")}`;
  for (let step = 0; step <= 200; step += 1) {
    const candidate = hex(step / 200);
    if (contrast(canvas, candidate) >= target) return candidate;
  }
  return hex(1);
}

/** 극단 + 잡음 — 「잡음이 낀 그림」의 대리. 순흑·순백 둘이 최악이고 나머지는 그 사이다. */
const PIXELS: readonly string[] = [
  "#000000",
  "#ffffff",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  ...(() => {
    const next = prng(20261022);
    return Array.from({ length: 300 }, () => randomHex(next));
  })(),
];

function tokensWithSignal(theme: ThemeId, mode: Mode, values?: SignalValues): WallpaperTokens {
  const base = wallpaperTokensOf(THEMES[theme][mode]);
  if (!values) return base;
  return {
    ...base,
    onSignal: values["on-signal"],
    roles: { ...base.roles, signal: values.signal, "signal-text": values["signal-text"] },
  };
}

const SIGNALS: ReadonlyArray<readonly [string, (theme: ThemeId, mode: Mode) => SignalValues | undefined]> = [
  ["기본", () => undefined],
  ...SIGNAL_PRESET_IDS.map((id) => {
    const pick = (theme: ThemeId, mode: Mode): SignalValues | undefined => {
      const result = resolvePreset(id, theme, mode);
      return result.ok ? result.values : undefined;
    };
    return [`프리셋 ${id}`, pick] as const;
  }),
  ...(["#FFE600", "#3A6BD8"] as const).map((hex) => {
    const pick = (theme: ThemeId, mode: Mode): SignalValues | undefined => {
      const result = resolveSignal(hex, theme, mode);
      return result.ok ? result.values : undefined;
    };
    return [`직접 ${hex}`, pick] as const;
  }),
];

describe("고를 수 있는 것의 표", () => {
  it("단색 여덟, 기본 제공 여섯이고 id는 표의 키와 같다", () => {
    expect(SOLID_IDS).toHaveLength(8);
    expect(PRESET_IDS).toHaveLength(6);
    expect(Object.keys(WALLPAPER_SOLIDS)).toEqual([...SOLID_IDS]);
    expect(Object.keys(WALLPAPER_PRESETS)).toEqual([...PRESET_IDS]);
  });

  it("라벨은 모두 다르고 비어 있지 않다", () => {
    const labels = [
      ...SOLID_IDS.map((id) => WALLPAPER_SOLIDS[id].label),
      ...PRESET_IDS.map((id) => WALLPAPER_PRESETS[id].label),
    ];
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("값은 #RRGGBB와 닫힌 그라데이션 문법뿐이다 (CSSOM으로 나가는 문자열이라 url()·세미콜론이 들어올 틈이 없다)", () => {
    for (const id of SOLID_IDS) expect(WALLPAPER_SOLIDS[id].hex).toMatch(/^#[0-9A-F]{6}$/);
    for (const id of PRESET_IDS) {
      const { gradient, fallback } = WALLPAPER_PRESETS[id];
      expect(fallback).toMatch(/^#[0-9A-F]{6}$/);
      expect(gradient).toMatch(/^(linear|radial)-gradient\([a-z0-9 .,%#()-]+\)$/i);
      expect(gradient).not.toMatch(/url\(|;|expression|@import|</i);
    }
  });

  it("id 판정은 표에 있는 것만 통과시킨다", () => {
    expect(isSolidId("slate")).toBe(true);
    expect(isSolidId("saebyeok")).toBe(false);
    expect(isPresetId("saebyeok")).toBe(true);
    expect(isPresetId("slate")).toBe(false);
    expect(isSolidId(undefined)).toBe(false);
    expect(isPresetId(7)).toBe(false);
  });

  it("저장된 참조가 지금 코드가 아는 배경인가: 문법만 맞는 모르는 id는 「없음」이다", () => {
    expect(isKnownWallpaper(undefined)).toBe(false);
    expect(isKnownWallpaper({ kind: "solid", id: "slate" })).toBe(true);
    expect(isKnownWallpaper({ kind: "solid", id: "future-color" })).toBe(false);
    expect(isKnownWallpaper({ kind: "preset", id: "bam" })).toBe(true);
    expect(isKnownWallpaper({ kind: "preset", id: "slate" })).toBe(false);
    expect(isKnownWallpaper({ kind: "image", width: 10, height: 10, rev: 1 })).toBe(true);
  });

  it("행이 말하는 이름", () => {
    expect(wallpaperLabel(undefined)).toBe("기본");
    expect(wallpaperLabel({ kind: "solid", id: "slate" })).toBe("석판");
    expect(wallpaperLabel({ kind: "preset", id: "bam" })).toBe("밤");
    expect(wallpaperLabel({ kind: "image" })).toBe("내 사진");
    expect(wallpaperLabel({ kind: "solid", id: "future-color" })).toBe("기본");
  });
});

describe("scrim 불투명도는 하한이고 하한은 산수의 결과다", () => {
  it.each(COMBOS)("%s/%s: 하한이 ADR 표(교정점)와 같다", (theme, mode) => {
    const t = wallpaperTreatment(tokensWithSignal(theme, mode), mode);
    expect(t.floor).toBeCloseTo(ADR_FLOOR[theme][mode], 5);
  });

  it.each(COMBOS)("%s/%s: 깔리는 불투명도는 같은 산수로 다시 구한 하한과 같고 scrim 색은 바닥색에 그 알파를 단 것이다", (theme, mode) => {
    const tokens = tokensWithSignal(theme, mode);
    const t = wallpaperTreatment(tokens, mode);
    expect(t.alpha).toBe(minimumScrimAlpha(THEMES[theme][mode].canvas[1], THEMES[theme][mode].color.ink, INK_MIN_ON_BACKDROP));
    expect(t.scrim).toBe(scrimColor(THEMES[theme][mode].canvas[1], t.alpha));
    expect(t.scrim).toHaveLength(9);
  });

  it.each(COMBOS)("%s/%s: 잉크가 순흑·순백·잡음 픽셀 위 합성에서 7:1 이상이다", (theme, mode) => {
    const tokens = tokensWithSignal(theme, mode);
    const t = wallpaperTreatment(tokens, mode);
    const low = PIXELS.map((pixel) => ({ pixel, ratio: contrast(tokens.ink, blend(tokens.canvas, pixel, t.alpha)) })).filter(
      (entry) => entry.ratio < INK_MIN_ON_BACKDROP
    );
    expect(low).toEqual([]);
  });

  it.each(COMBOS)("%s/%s: 하한은 빠듯하다 (0.01만 얇아도 최악 입력 한쪽에서 7:1이 깨진다)", (theme, mode) => {
    const tokens = tokensWithSignal(theme, mode);
    const t = wallpaperTreatment(tokens, mode);
    expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, t.alpha), INK_MIN_ON_BACKDROP)).toBe(true);
    expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, t.alpha - 0.01), INK_MIN_ON_BACKDROP)).toBe(false);
  });

  it("사보타주: 불투명도를 0.15 낮추면 같은 자가 모든 조합의 최악 입력에서 빨개진다", () => {
    for (const [theme, mode] of COMBOS) {
      const tokens = tokensWithSignal(theme, mode);
      const t = wallpaperTreatment(tokens, mode);
      const thin = t.alpha - 0.15;
      expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, thin), INK_MIN_ON_BACKDROP)).toBe(false);
      expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, t.alpha), INK_MIN_ON_BACKDROP)).toBe(true);
    }
  });

  it("첫 파티 여섯 조합은 모두 쓸 수 있고 이 중 힌트가 서는 것은 없다 (하한 0.65~0.78)", () => {
    for (const [theme, mode] of COMBOS) {
      expect(wallpaperTreatment(tokensWithSignal(theme, mode), mode).verdict).toBe("ok");
    }
  });
});

describe.each(COMBOS)("%s/%s: 바닥에 직접 서는 글자와 표식", (theme, mode) => {
  describe.each(SIGNALS)("%s", (_label, pick) => {
    const values = pick(theme, mode);
    const tokens = tokensWithSignal(theme, mode, values);
    const t = wallpaperTreatment(tokens, mode);

    it("보조·강조 글자가 모든 픽셀 위 합성에서 4.5:1 이상이다", () => {
      const failures: string[] = [];
      for (const pixel of PIXELS) {
        const host = blend(tokens.canvas, pixel, t.alpha);
        for (const role of WALLPAPER_TEXT_ROLES) {
          const ratio = contrast(t.roles[role], host);
          if (ratio < TEXT_MIN_ON_BACKDROP) failures.push(`${role}@${pixel}=${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it("아이콘·신호 채움이 모든 픽셀 위 합성에서 3:1 이상이다", () => {
      const failures: string[] = [];
      for (const pixel of PIXELS) {
        const host = blend(tokens.canvas, pixel, t.alpha);
        for (const role of WALLPAPER_NON_TEXT_ROLES) {
          const ratio = contrast(t.roles[role], host);
          if (ratio < NON_TEXT_MIN_ON_BACKDROP) failures.push(`${role}@${pixel}=${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it("하한에서 멈추지 않는다: 최악 두 끝에서 FIT_MARGIN을 얹은 값 근처에 선다", () => {
      const thin: string[] = [];
      for (const host of worstCaseBackdrops(tokens.canvas, t.alpha)) {
        for (const role of WALLPAPER_TEXT_ROLES) {
          if (contrast(t.roles[role], host) < TEXT_MIN_ON_BACKDROP + FIT_MARGIN - 0.05) thin.push(`${role}@${host}`);
        }
      }
      expect(thin).toEqual([]);
    });

    it("색상각을 지킨다: 12도를 넘게 옮긴 역할이 없다", () => {
      for (const role of ["signal", "signal-text", "agent", "ok", "warn", "danger"] as const) {
        expect([role, hueGap(tokens.roles[role], t.roles[role]) <= 12]).toEqual([role, true]);
      }
    });

    it("모드의 방향으로만 옮긴다: 라이트는 더 어둡게, 다크는 더 밝게 (밝기의 대리는 흰색 대비의 역수)", () => {
      const lightness = (hex: string) => 1 / contrast(hex, "#ffffff");
      for (const role of [...WALLPAPER_TEXT_ROLES, ...WALLPAPER_NON_TEXT_ROLES]) {
        const before = lightness(tokens.roles[role]);
        const after = lightness(t.roles[role]);
        if (mode === "light") expect([role, after <= before + 1e-9]).toEqual([role, true]);
        else expect([role, after >= before - 1e-9]).toEqual([role, true]);
      }
    });

    it("보정한 신호 채움 위의 글자도 4.5:1 이상이다", () => {
      expect(contrast(t.roles["on-signal"], t.roles.signal)).toBeGreaterThanOrEqual(TEXT_MIN_ON_BACKDROP);
    });
  });
});

describe("보정은 닿는 역할에만 닿는다", () => {
  it("이미 통과하는 색은 입력 그대로다 (정규화한 소문자 hex)", () => {
    const tokens = tokensWithSignal("dawnsky", "light");
    const darkInk: WallpaperTokens = { ...tokens, roles: { ...tokens.roles, "ink-muted": "#101010" } };
    const t = wallpaperTreatment(darkInk, "light");
    expect(t.roles["ink-muted"]).toBe(normalizeHex("#101010"));
  });

  it("잉크는 모든 값에 실리지 않는다 (불투명도가 지킨다)", () => {
    for (const role of WALLPAPER_VAR_ROLES) expect(role).not.toBe("ink");
  });

  it("보정 대상은 글자 여섯과 표식 둘이다", () => {
    expect([...WALLPAPER_TEXT_ROLES]).toEqual(["ink-muted", "signal-text", "agent", "ok", "warn", "danger"]);
    expect([...WALLPAPER_NON_TEXT_ROLES]).toEqual(["icon", "signal"]);
  });

  it("라이트에서 어두운 글자를 쓰는 테마(노을띠)는 신호 채움이 어두워지면 글자를 다시 고른다", () => {
    const tokens = tokensWithSignal("noeul", "light");
    const t = wallpaperTreatment(tokens, "light");
    // 원래 on-signal(어두운 글자)이 보정한 채움 위에서 모자라면 다른 후보로 바뀌어야 한다.
    if (contrast(tokens.onSignal, t.roles.signal) < TEXT_MIN_ON_BACKDROP) {
      expect(t.roles["on-signal"]).not.toBe(normalizeHex(tokens.onSignal));
    }
    expect(contrast(t.roles["on-signal"], t.roles.signal)).toBeGreaterThanOrEqual(TEXT_MIN_ON_BACKDROP);
  });
});

describe("의사난수 테마 수백 개에서도 같은 산수가 선다 (첫 파티에만 맞춘 숫자가 아니다)", () => {
  const next = prng(4191);
  const cases = Array.from({ length: 240 }, (_, index) => {
    const canvas = randomHex(next);
    // 잉크는 바닥과의 대비가 3~19 사이에서 고르게 나오게 만든다: 무작위 쌍은 거의 다 대비가 모자라 쓸 수 있는 쪽이 없다.
    const ink = inkAtContrast(canvas, 3 + next() * 16);
    const mode: Mode = index % 2 === 0 ? "light" : "dark";
    const roles = Object.fromEntries(
      [...WALLPAPER_TEXT_ROLES, ...WALLPAPER_NON_TEXT_ROLES].map((role) => [role, randomHex(next)])
    ) as WallpaperTokens["roles"];
    const tokens: WallpaperTokens = { canvas, ink, onPrimary: randomHex(next), onSignal: randomHex(next), roles };
    return { index, mode, tokens };
  });

  it("쓸 수 있는 테마 모드(하한 <= 95%)에서는 잉크가 최악 두 끝에서 7:1을 지키고 하한은 빠듯하다", () => {
    let usable = 0;
    for (const { mode, tokens } of cases) {
      const t = wallpaperTreatment(tokens, mode);
      if (t.verdict === "unavailable") continue;
      usable += 1;
      expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, t.alpha), INK_MIN_ON_BACKDROP)).toBe(true);
      if (t.alpha > 0) {
        expect(holdsOnBoth(tokens.ink, worstCaseBackdrops(tokens.canvas, t.alpha - 0.01), INK_MIN_ON_BACKDROP)).toBe(false);
      }
    }
    // 시험이 헛돌지 않게: 쓸 수 있는 쌍이 충분히 많아야 하고, 쓸 수 없는 쌍도 있어야 한다.
    expect(usable).toBeGreaterThan(50);
    expect(usable).toBeLessThan(cases.length);
  });

  it("쓸 수 없는 모드는 불투명(1.00)으로도 잉크 7:1에 못 미치거나 하한이 95%를 넘는다", () => {
    for (const { mode, tokens } of cases) {
      const t = wallpaperTreatment(tokens, mode);
      if (t.verdict !== "unavailable") continue;
      expect(Math.round(t.floor * 100)).toBeGreaterThan(WALLPAPER_USABLE_MAX_PERCENT);
    }
  });

  it("판정은 하한의 퍼센트로만 정해진다: 95 이하는 쓸 수 있고, 85 이상은 힌트가 선다", () => {
    for (const { mode, tokens } of cases) {
      const t = wallpaperTreatment(tokens, mode);
      const percent = Math.round(t.floor * 100);
      const expected =
        percent > WALLPAPER_USABLE_MAX_PERCENT ? "unavailable" : percent >= WALLPAPER_BLURRY_MIN_PERCENT ? "blurry" : "ok";
      expect(t.verdict).toBe(expected);
    }
    // 세 판정이 모두 시험에 나온다.
    const seen = new Set(cases.map(({ mode, tokens }) => wallpaperTreatment(tokens, mode).verdict));
    expect([...seen].sort()).toEqual(["blurry", "ok", "unavailable"]);
  });
});

describe("지금 실제로 깔아도 되는가", () => {
  const base: WallpaperDecisionInput = {
    ref: { kind: "solid", id: "slate" },
    verdict: "ok",
    reduceTransparency: false,
    increaseContrast: false,
    photoReady: false,
  };

  it("고른 것이 없으면 꺼져 있고 이유 문장도 없다", () => {
    expect(resolveWallpaper({ ...base, ref: undefined })).toEqual({ live: false, reason: null });
  });

  it("모르는 id의 참조도 「없음」이다", () => {
    expect(resolveWallpaper({ ...base, ref: { kind: "solid", id: "future-color" } })).toEqual({ live: false, reason: null });
  });

  it("쓸 수 있는 테마에서 단색·기본 제공은 사진 준비와 무관하게 깔린다", () => {
    expect(resolveWallpaper(base)).toEqual({ live: true, reason: null });
    expect(resolveWallpaper({ ...base, ref: { kind: "preset", id: "bam" }, verdict: "blurry" })).toEqual({ live: true, reason: null });
  });

  it("사진은 읽혀서 준비되기 전에는 깔리지 않는다", () => {
    const photo = { ...base, ref: { kind: "image" as const, width: 10, height: 10, rev: 1 } };
    expect(resolveWallpaper(photo)).toEqual({ live: false, reason: "no-photo" });
    expect(resolveWallpaper({ ...photo, photoReady: true })).toEqual({ live: true, reason: null });
  });

  it("시스템 접근성이 항상 이긴다: 투명도 줄이기, 대비 높이기", () => {
    expect(resolveWallpaper({ ...base, reduceTransparency: true })).toEqual({ live: false, reason: "reduce-transparency" });
    expect(resolveWallpaper({ ...base, increaseContrast: true })).toEqual({ live: false, reason: "increase-contrast" });
    // 둘 다면 투명도 줄이기의 문장이 먼저다(폰과 같다).
    expect(resolveWallpaper({ ...base, reduceTransparency: true, increaseContrast: true }).reason).toBe("reduce-transparency");
  });

  it("접근성이 켜져 있으면 테마가 불가여도 시스템 쪽 이유를 말한다 (사람이 이길 수 없는 규칙이 먼저다)", () => {
    expect(resolveWallpaper({ ...base, verdict: "unavailable", reduceTransparency: true }).reason).toBe("reduce-transparency");
  });

  it("이 테마에서 쓸 수 없으면 선택은 남아도 꺼진다", () => {
    expect(resolveWallpaper({ ...base, verdict: "unavailable" })).toEqual({ live: false, reason: "unavailable" });
  });

  it("테마의 색을 못 읽으면 안전하게 꺼진다", () => {
    expect(resolveWallpaper({ ...base, verdict: null })).toEqual({ live: false, reason: "unresolved" });
  });

  it("꺼진 이유마다 문장이 있다", () => {
    for (const reason of ["reduce-transparency", "increase-contrast", "unavailable", "unresolved", "no-photo"] as const) {
      expect(WALLPAPER_OFF_COPY[reason].length).toBeGreaterThan(10);
    }
    // 앞의 둘은 폰과 같은 문장이다 (ADR-0189 증보 2 D5).
    expect(WALLPAPER_OFF_COPY["reduce-transparency"]).toBe("시스템 설정이 투명 효과를 끄고 있어서 기본 바닥으로 보여요.");
    expect(WALLPAPER_OFF_COPY["increase-contrast"]).toBe("시스템 설정이 대비를 높이고 있어서 기본 바닥으로 보여요.");
  });
});

describe("유리와의 관계 (증보 3 결정 9)", () => {
  it("배경화면을 고르면 유리는 쓸 수 없고, 고르지 않았으면 막지 않는다", () => {
    expect(wallpaperBlocksGlass(undefined)).toBe(false);
    expect(wallpaperBlocksGlass({ kind: "solid", id: "slate" })).toBe(true);
    expect(wallpaperBlocksGlass({ kind: "preset", id: "bam" })).toBe(true);
    expect(wallpaperBlocksGlass({ kind: "image", width: 1, height: 1, rev: 1 })).toBe(true);
  });

  it("지금 깔렸는가가 아니라 선택을 본다: 접근성이 배경을 꺼도 유리는 같은 이유로 꺼져 있다", () => {
    const chosen = { kind: "solid" as const, id: "slate" };
    expect(resolveWallpaper({ ref: chosen, verdict: "ok", reduceTransparency: true, increaseContrast: false, photoReady: false }).live).toBe(false);
    expect(wallpaperBlocksGlass(chosen)).toBe(true);
  });
});

describe("CSS 변수 표", () => {
  const light = wallpaperTreatment(tokensWithSignal("dawnsky", "light"), "light");
  const dark = wallpaperTreatment(tokensWithSignal("dawnsky", "dark"), "dark");

  it("두 모드의 scrim과 모든 역할을 싣는다", () => {
    const vars = wallpaperVars({ light, dark });
    expect(Object.keys(vars)).toHaveLength(2 * (1 + WALLPAPER_VAR_ROLES.length));
    expect(vars[WALLPAPER_VARS.scrim("light")]).toBe(light.scrim);
    expect(vars[WALLPAPER_VARS.scrim("dark")]).toBe(dark.scrim);
    for (const role of WALLPAPER_VAR_ROLES) {
      expect(vars[WALLPAPER_VARS.role(role, "light")]).toBe(light.roles[role]);
      expect(vars[WALLPAPER_VARS.role(role, "dark")]).toBe(dark.roles[role]);
    }
  });

  it("이름은 --wallpaper-<역할>-<모드> 한 가지 모양이다", () => {
    for (const name of Object.keys(wallpaperVars({ light, dark }))) {
      expect(name).toMatch(/^--wallpaper-(scrim|ink-muted|signal-text|agent|ok|warn|danger|icon|signal|on-signal)-(light|dark)$/);
    }
  });

  it("한 모드만 있는 테마는 있는 모드의 값을 두 칸에 싣는다", () => {
    const vars = wallpaperVars({ dark });
    expect(vars[WALLPAPER_VARS.scrim("light")]).toBe(dark.scrim);
    expect(vars[WALLPAPER_VARS.role("agent", "light")]).toBe(dark.roles.agent);
  });

  it("모드가 하나도 없으면 비어 있다", () => {
    expect(wallpaperVars({})).toEqual({});
  });

  it("쓸 수 없는 모드의 값도 싣는다 (모드가 바뀐 한 프레임 동안 light-dark()가 비지 않게)", () => {
    const unavailable: WallpaperTreatment = { ...dark, verdict: "unavailable" };
    const vars = wallpaperVars({ light, dark: unavailable });
    expect(vars[WALLPAPER_VARS.scrim("dark")]).toBe(unavailable.scrim);
  });
});

// ---- 사진 처리 계단 ---------------------------------------------------------------

interface FakeOptions {
  width?: number;
  height?: number;
  /** (긴 변, 품질) → 바이트 수. 없으면 항상 작다. */
  sizeFor?: (longSide: number, quality: number) => number | null;
  decodeNull?: boolean;
  decodeThrows?: boolean;
  encodeThrows?: boolean;
  thumbThrows?: boolean;
}

function fakePorts(options: FakeOptions = {}) {
  const calls: { longSide: number; quality: number }[] = [];
  let released = 0;
  const ports: PhotoPorts<string, string, string> = {
    async decode() {
      if (options.decodeThrows) throw new Error("decode");
      if (options.decodeNull) return null;
      return { handle: "bitmap", width: options.width ?? 4000, height: options.height ?? 3000 };
    },
    async encode(_handle, { longSide, quality }) {
      calls.push({ longSide, quality });
      const isThumb = longSide <= PHOTO_THUMB_LONG_SIDE;
      if (isThumb && options.thumbThrows) throw new Error("thumb");
      if (!isThumb && options.encodeThrows) throw new Error("encode");
      const size = options.sizeFor ? options.sizeFor(longSide, quality) : 100_000;
      if (size === null) return null;
      return { bytes: `jpeg:${longSide}:${quality}`, size, width: longSide, height: Math.round(longSide * 0.75) };
    },
    release() {
      released += 1;
    },
    now: () => 1_700_000_000_000,
  };
  return { ports, calls, released: () => released };
}

describe("사진을 상한 안으로 줄인다", () => {
  it("상한은 긴 변 2560, JPEG 1.5MB다 (증보 3 D4)", () => {
    expect(PHOTO_MAX_LONG_SIDE).toBe(2560);
    expect(PHOTO_MAX_BYTES).toBe(1_500_000);
  });

  it("계단은 품질 네 단을 먼저, 해상도 세 단이 그 바깥이다", () => {
    expect([...QUALITY_STEPS]).toEqual([0.85, 0.7, 0.55, 0.4]);
    expect([...SIDE_FACTORS]).toEqual([1, 0.75, 0.56]);
  });

  it("큰 사진은 2560에서 시작하고 첫 시도가 맞으면 한 번에 끝난다 (썸네일 한 번 더)", async () => {
    const { ports, calls } = fakePorts({ width: 6000, height: 4000 });
    const outcome = await importPhoto(ports, "file", 5_000_000);
    expect(outcome.ok).toBe(true);
    expect(calls[0]).toEqual({ longSide: 2560, quality: 0.85 });
    expect(calls).toHaveLength(2);
    expect(calls[1].longSide).toBe(PHOTO_THUMB_LONG_SIDE);
    if (outcome.ok) {
      expect(outcome.photo.bytes).toBe("jpeg:2560:0.85");
      expect(outcome.photo.rev).toBe(1_700_000_000_000);
      expect(outcome.photo.thumb?.bytes).toBe(`jpeg:${PHOTO_THUMB_LONG_SIDE}:0.7`);
    }
  });

  it("작은 사진은 키우지 않는다: 긴 변이 목표보다 작으면 그 변에서 시작한다", async () => {
    const { ports, calls } = fakePorts({ width: 800, height: 600 });
    await importPhoto(ports, "file", 100_000);
    expect(calls[0].longSide).toBe(800);
  });

  it("긴 변이 썸네일보다 작으면 썸네일도 그 변을 넘지 않는다", async () => {
    const { ports, calls } = fakePorts({ width: 100, height: 80 });
    await importPhoto(ports, "file", 10_000);
    expect(calls.map((call) => call.longSide)).toEqual([100, 100]);
  });

  it("품질을 먼저 내리고, 그래도 크면 해상도를 한 단 낮춘다", async () => {
    // 긴 변이 2560이면 1.5MB를 못 맞추고 1920(= 0.75배)의 품질 0.7에서 처음 맞는다.
    const { ports, calls } = fakePorts({
      width: 4000,
      height: 3000,
      sizeFor: (longSide, quality) => (longSide === 1920 && quality <= 0.7 ? 1_400_000 : 2_000_000),
    });
    const outcome = await importPhoto(ports, "file", 9_000_000);
    expect(outcome.ok).toBe(true);
    expect(calls.slice(0, 6)).toEqual([
      { longSide: 2560, quality: 0.85 },
      { longSide: 2560, quality: 0.7 },
      { longSide: 2560, quality: 0.55 },
      { longSide: 2560, quality: 0.4 },
      { longSide: 1920, quality: 0.85 },
      { longSide: 1920, quality: 0.7 },
    ]);
  });

  it("딱 상한(1,500,000바이트)은 받고 1바이트 넘으면 다음 단으로 간다", async () => {
    const exact = fakePorts({ sizeFor: () => PHOTO_MAX_BYTES });
    expect((await importPhoto(exact.ports, "file", 9_000_000)).ok).toBe(true);
    const over = fakePorts({ sizeFor: (_l, quality) => (quality === 0.85 ? PHOTO_MAX_BYTES + 1 : PHOTO_MAX_BYTES) });
    const outcome = await importPhoto(over.ports, "file", 9_000_000);
    expect(outcome.ok).toBe(true);
    expect(over.calls[0].quality).toBe(0.85);
    expect(over.calls[1].quality).toBe(0.7);
  });

  it("계단 끝까지 가도 크면 거절한다 (열두 번 시도)", async () => {
    const { ports, calls, released } = fakePorts({ sizeFor: () => 9_000_000 });
    const outcome = await importPhoto(ports, "file", 9_000_000);
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
    expect(calls).toHaveLength(QUALITY_STEPS.length * SIDE_FACTORS.length);
    expect(released()).toBe(1);
  });

  it("읽지 못하는 사진: 디코드가 null이거나 던진다", async () => {
    for (const options of [{ decodeNull: true }, { decodeThrows: true }]) {
      const { ports, calls, released } = fakePorts(options);
      expect(await importPhoto(ports, "file", 1000)).toEqual({ ok: false, reason: "unreadable" });
      expect(calls).toHaveLength(0);
      expect(released()).toBe(0);
    }
  });

  it("다시 쓰지 못하는 사진: 인코드가 모두 null이거나 던진다", async () => {
    const none = fakePorts({ sizeFor: () => null });
    expect(await importPhoto(none.ports, "file", 1000)).toEqual({ ok: false, reason: "unreadable" });
    expect(none.released()).toBe(1);
    const throws = fakePorts({ encodeThrows: true });
    expect(await importPhoto(throws.ports, "file", 1000)).toEqual({ ok: false, reason: "unreadable" });
    expect(throws.released()).toBe(1);
  });

  it("썸네일을 못 만들어도 사진은 받는다", async () => {
    const { ports } = fakePorts({ thumbThrows: true });
    const outcome = await importPhoto(ports, "file", 1000);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.photo.thumb).toBeNull();
  });

  it("너무 큰 원본은 읽기 전에 거절한다 (디코드를 부르지 않는다)", async () => {
    const { ports, calls } = fakePorts();
    expect(await importPhoto(ports, "file", PHOTO_MAX_SOURCE_BYTES + 1)).toEqual({ ok: false, reason: "too-large" });
    expect(calls).toHaveLength(0);
  });

  it("픽셀 수가 상한을 넘으면 인코드를 부르지 않고 거절하며 그림은 놓는다", async () => {
    const side = Math.ceil(Math.sqrt(PHOTO_MAX_SOURCE_PIXELS)) + 1;
    const { ports, calls, released } = fakePorts({ width: side, height: side });
    expect(await importPhoto(ports, "file", 1_000_000)).toEqual({ ok: false, reason: "too-large" });
    expect(calls).toHaveLength(0);
    expect(released()).toBe(1);
  });

  it("크기가 0이거나 숫자가 아니면 읽을 수 없는 사진이다", async () => {
    const { ports } = fakePorts();
    expect(await importPhoto(ports, "file", 0)).toEqual({ ok: false, reason: "unreadable" });
    expect(await importPhoto(ports, "file", Number.NaN)).toEqual({ ok: false, reason: "unreadable" });
    const zero = fakePorts({ width: 0, height: 0 });
    expect(await importPhoto(zero.ports, "file", 1000)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("거절 문장이 있다", () => {
    expect(IMPORT_FAILURE_COPY.unreadable).toContain("읽지 못했어요");
    expect(IMPORT_FAILURE_COPY["too-large"]).toContain("너무 커요");
    expect(IMPORT_FAILURE_COPY["save-failed"]).toContain("저장하지 못했어요");
  });
});

describe("문장", () => {
  it("행의 문장은 해요체이고 서버로 올라가지 않는다고 말한다", () => {
    expect(WALLPAPER_COPY.privacy).toContain("서버로는 올라가지 않아요");
    expect(WALLPAPER_COPY.description).toContain("반투명 면");
    expect(WALLPAPER_COPY.reset).toBe("기본으로");
  });
});
