// =============================================================================
// 디자인 시스템 2.0 토큰 원천 — 테마 × 모드 × 역할 (ADR-0189 D2·D5).
//
// 값의 정본은 이 파일이다. `docs/design-system/themes-2.0.md` §2는 이 표를 옮겨
// 적은 문서이고, 둘이 어긋나면 이 파일이 이긴다(웹 `themes2.doc.test.ts`가 그
// 어긋남을 빨갛게 알린다). 웹 `themes/palettes/*.css`는 이 파일에서 생성하고
// (`themesCss.ts`), 폰은 `@momo/core/design/themes`를 경로로 직접 읽는다.
//
// 테마가 바꾸는 것은 색과 바닥뿐이다(D2). 반경·그림자·타입·내비 기하는 테마
// 밖이고, 밀도는 `density.ts`가 따로 든다.
//
// ## 표 밖 역할
//
// `surface-hover`·`surface-pressed`·`muted-soft`·`danger-fill`·`on-danger-fill`은
// ADR의 표에 값이 없다. D5가 「새 표면 위에서 다시 계산한다」고 정했으므로 손으로
// 고르지 않고 `deriveRoles`가 표의 값에서 계산한다. 테마를 더하면 이 역할도 같이
// 생기고, 대비 시험이 두 자(대비 1.05 이상, OKLab 0.02 이상)로 잰다.
// =============================================================================

import { contrast, fromOklch, oklabDistance, toOklch } from "./color";

export const THEME_IDS = ["dawnsky", "graphite", "noeul"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** 목록의 첫 값이 기본 테마다(ADR-0174 D4, ADR-0189 D2). */
export const DEFAULT_THEME_ID: ThemeId = THEME_IDS[0];

/** 부트 스크립트·캡처·게이트가 공유하는 id 문자 집합(ADR-0189 D2). */
export const THEME_ID_RE = /^[a-z]+$/;

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = {
  dawnsky: "새벽하늘",
  graphite: "흑연",
  noeul: "노을띠",
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** 표 §2의 색 역할(바닥·띠 제외). 모든 테마가 같은 목록을 든다. */
export const COLOR_ROLES = [
  "surface",
  "surface-muted",
  "sheet",
  "ink",
  "ink-muted",
  "icon",
  "line",
  "line-strong",
  "primary",
  "on-primary",
  "signal",
  "on-signal",
  "signal-text",
  "signal-soft",
  "agent",
  "agent-soft",
  "ok",
  "ok-soft",
  "warn",
  "warn-soft",
  "danger",
  "danger-soft",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const BAND_ROLES = ["band", "on-band", "on-band-muted"] as const;
export type BandRole = (typeof BAND_ROLES)[number];

export const CANVAS_STOPS = ["canvas-top", "canvas-mid", "canvas-bottom"] as const;
export type CanvasStop = (typeof CANVAS_STOPS)[number];

export const DERIVED_ROLES = [
  "surface-hover",
  "surface-pressed",
  "muted-soft",
  "danger-fill",
  "on-danger-fill",
] as const;
export type DerivedRole = (typeof DERIVED_ROLES)[number];

/** 한 테마 × 모드의 원천 값(표 §2 그대로). */
export interface ThemeModeSource {
  /** 위 → 가운데 → 아래. 평면 테마는 세 값이 같다. */
  canvas: readonly [string, string, string];
  /** 띠가 없는 테마는 `null`이다. 헤더·사이드바가 바닥 위에 선다. */
  band: Readonly<Record<BandRole, string>> | null;
  color: Readonly<Record<ColorRole, string>>;
  /** 유리 재료(블러 22와 함께 그린다). */
  glass: string;
  scrim: string;
}

export interface ThemeModeTokens extends ThemeModeSource {
  derived: Readonly<Record<DerivedRole, string>>;
}

const flat = (hex: string): readonly [string, string, string] => [hex, hex, hex];

const LIGHT_SCRIM = "rgba(20,18,16,.34)";
const DARK_SCRIM = "rgba(0,0,0,.55)";

/** 표 §2. 대문자 hex는 문서와 한 글자씩 대조하기 위해 그대로 둔다. */
export const THEME_SOURCE: Readonly<Record<ThemeId, Readonly<Record<Mode, ThemeModeSource>>>> = {
  dawnsky: {
    light: {
      canvas: ["#F7EADB", "#EFEDEA", "#E2E9F3"],
      band: null,
      color: {
        surface: "#FFFEFC",
        "surface-muted": "#F3F1EE",
        sheet: "#F4F2EF",
        ink: "#16171B",
        "ink-muted": "#5A5C64",
        icon: "#7C7F88",
        line: "#E7E4DF",
        "line-strong": "#85837E",
        primary: "#16171B",
        "on-primary": "#FFFEFC",
        signal: "#C2410C",
        "on-signal": "#FFFEFC",
        "signal-text": "#B03A0A",
        "signal-soft": "#FBE9DE",
        agent: "#2F5B8A",
        "agent-soft": "#E3ECF6",
        ok: "#0E7740",
        "ok-soft": "#E1F2E7",
        warn: "#8A5C00",
        "warn-soft": "#FFEDD4",
        danger: "#BE2C4F",
        "danger-soft": "#FFE9E5",
      },
      glass: "rgba(255,254,252,.74)",
      scrim: LIGHT_SCRIM,
    },
    dark: {
      canvas: ["#231D1B", "#171A20", "#0F141C"],
      band: null,
      color: {
        surface: "#1B1E25",
        "surface-muted": "#252933",
        sheet: "#14171D",
        ink: "#F1F1F3",
        "ink-muted": "#A4A7B0",
        icon: "#8A8E98",
        line: "#2C3039",
        "line-strong": "#737782",
        primary: "#F1F1F3",
        "on-primary": "#16171B",
        signal: "#FF8A4C",
        "on-signal": "#16171B",
        "signal-text": "#FF9A62",
        "signal-soft": "#3A2519",
        agent: "#8DB3E2",
        "agent-soft": "#1B2A3C",
        ok: "#4CC47E",
        "ok-soft": "#173325",
        warn: "#D4A72C",
        "warn-soft": "#372E1B",
        danger: "#FF6B63",
        "danger-soft": "#402A26",
      },
      glass: "rgba(32,35,43,.72)",
      scrim: DARK_SCRIM,
    },
  },
  graphite: {
    light: {
      canvas: flat("#F3F4F6"),
      band: null,
      color: {
        surface: "#FDFDFE",
        "surface-muted": "#F3F4F6",
        sheet: "#F3F4F6",
        ink: "#0F1115",
        "ink-muted": "#5B606B",
        icon: "#80858F",
        line: "#E4E6EA",
        "line-strong": "#878C96",
        primary: "#0F1115",
        "on-primary": "#FDFDFE",
        signal: "#2754E0",
        "on-signal": "#FDFDFE",
        "signal-text": "#2754E0",
        "signal-soft": "#E8EEFD",
        agent: "#0B7A74",
        "agent-soft": "#E1F3F1",
        ok: "#1F7A43",
        "ok-soft": "#E1F2E7",
        warn: "#8A5C00",
        "warn-soft": "#FFEDD4",
        danger: "#C4312B",
        "danger-soft": "#FFE9E5",
      },
      glass: "rgba(253,253,254,.72)",
      scrim: LIGHT_SCRIM,
    },
    dark: {
      canvas: flat("#0B0C0E"),
      band: null,
      color: {
        surface: "#141518",
        "surface-muted": "#1B1D21",
        sheet: "#101113",
        ink: "#EDEEF0",
        "ink-muted": "#9A9EA8",
        icon: "#7D818B",
        line: "#25272C",
        "line-strong": "#6C707A",
        primary: "#EDEEF0",
        "on-primary": "#0B0C0E",
        signal: "#7596FF",
        "on-signal": "#0B0C0E",
        "signal-text": "#7596FF",
        "signal-soft": "#1A2340",
        agent: "#45C9C0",
        "agent-soft": "#0F2A28",
        ok: "#4DC27F",
        "ok-soft": "#173325",
        warn: "#D4A72C",
        "warn-soft": "#372E1B",
        danger: "#FF6A60",
        "danger-soft": "#402A26",
      },
      glass: "rgba(20,21,24,.72)",
      scrim: DARK_SCRIM,
    },
  },
  noeul: {
    light: {
      canvas: flat("#F5F1E8"),
      band: { band: "#1C2440", "on-band": "#F4F1EA", "on-band-muted": "#B9BFD3" },
      color: {
        surface: "#FFFDF8",
        "surface-muted": "#F5F1E8",
        sheet: "#F5F1E8",
        ink: "#1D1B18",
        "ink-muted": "#625D55",
        icon: "#857F75",
        line: "#EAE4D8",
        "line-strong": "#8A847A",
        primary: "#1D1B18",
        "on-primary": "#FFFDF8",
        signal: "#BE7200",
        "on-signal": "#1D1406",
        "signal-text": "#A2560A",
        "signal-soft": "#FCEFD9",
        agent: "#3A5A8C",
        "agent-soft": "#E5EBF5",
        ok: "#147A43",
        "ok-soft": "#E1F2E7",
        warn: "#8A5C00",
        "warn-soft": "#FFEDD4",
        danger: "#C0302A",
        "danger-soft": "#FFE9E5",
      },
      glass: "rgba(255,253,248,.74)",
      scrim: LIGHT_SCRIM,
    },
    dark: {
      canvas: flat("#161A25"),
      band: { band: "#0D1222", "on-band": "#F1EEE7", "on-band-muted": "#9DA4BA" },
      color: {
        surface: "#20252F",
        "surface-muted": "#282D38",
        sheet: "#161A25",
        ink: "#EEEBE4",
        "ink-muted": "#A39F97",
        icon: "#8A877F",
        line: "#2A2F3B",
        "line-strong": "#737784",
        primary: "#EEEBE4",
        "on-primary": "#161A25",
        signal: "#F5AE4A",
        "on-signal": "#1D1406",
        "signal-text": "#F8BD68",
        "signal-soft": "#3A2C16",
        agent: "#93B2E0",
        "agent-soft": "#1C2638",
        ok: "#4CC47E",
        "ok-soft": "#173325",
        warn: "#D4A72C",
        "warn-soft": "#372E1B",
        danger: "#FF6B63",
        "danger-soft": "#402A26",
      },
      glass: "rgba(32,37,47,.74)",
      scrim: DARK_SCRIM,
    },
  },
};

/** 그림자는 테마가 바꾸지 않는다(ADR-0189 D2, ADR-0179 D6). */
export const ELEVATION = {
  rest: "0 1px 2px rgba(40,30,20,.05), 0 8px 24px -10px rgba(40,30,20,.14)",
  float: "0 16px 40px -12px rgba(30,24,20,.28), 0 2px 6px rgba(30,24,20,.06)",
  /** 다크에서 위 두 레시피에 더하는 윗면 하이라이트. */
  darkHighlight: "inset 0 1px 0 rgba(255,255,255,.05)",
} as const;

/** 블러 반경(pt/px). 블러를 못 쓰면 `surface` 94% 불투명으로 대체한다(D7). */
export const GLASS_BLUR = 22;
export const GLASS_FALLBACK_OPACITY = 0.94;

// ---- 표 밖 역할 계산 --------------------------------------------------------

/** 그릇·가리킴 채움이 자기 바닥에서 살아남는 두 자(웹 `CHIP_VESSEL_MIN_*`와 같은 값). */
export const VESSEL_MIN_CONTRAST = 1.05;
export const VESSEL_MIN_DISTANCE = 0.02;

/** 텍스트 4.5, 비텍스트 3 (WCAG 1.4.3 · 1.4.11). */
export const TEXT_MIN_CONTRAST = 4.5;
export const NON_TEXT_MIN_CONTRAST = 3;

const L_STEP = 0.0025;

function separated(color: string, hosts: readonly string[]): boolean {
  return hosts.every(
    (host) =>
      contrast(color, host) >= VESSEL_MIN_CONTRAST && oklabDistance(color, host) >= VESSEL_MIN_DISTANCE
  );
}

/**
 * `from`의 색상각·채도를 지키고 명도만 `direction` 쪽으로 옮겨, `ok`를 처음
 * 만족하는 값. 끝까지 못 찾으면 던진다: 원천 표가 역할을 세울 수 없는 테마라는
 * 뜻이고, 조용히 넘어가면 대비 시험이 없는 값을 잰다.
 */
function stepUntil(from: string, direction: 1 | -1, ok: (hex: string) => boolean, what: string): string {
  const start = toOklch(from);
  for (let i = 1; i * L_STEP <= 1; i++) {
    const candidate = fromOklch({ ...start, L: start.L + direction * i * L_STEP });
    if (ok(candidate)) return candidate;
  }
  throw new Error(`cannot derive ${what} from ${from}`);
}

/**
 * 표 밖 역할을 표의 값에서 계산한다.
 *
 * - `surface-hover`: `surface`에서 잉크 쪽으로 한 단. `surface`·`sheet` 둘 다에서
 *   두 자를 넘는다(행은 카드와 시트 위에 선다).
 * - `surface-pressed`: 거기서 한 단 더. `surface`·`sheet`·`surface-hover`에서 넘는다.
 * - `muted-soft`: 톤 없는 칩 그릇. 칩이 서는 행의 모든 상태(`surface`·`sheet`·
 *   `surface-hover`·`surface-pressed`) 위에서 넘는다.
 * - `danger-fill`: 위험 채움 버튼. `danger`에서 시작해 `on-danger-fill`이 4.5를
 *   넘고 채움이 설 수 있는 모든 면에서 3을 넘는 첫 명도. `on-danger-fill`은 그
 *   모드의 `on-primary`와 `ink` 가운데 대비가 큰 쪽이다.
 */
export function deriveRoles(source: ThemeModeSource, mode: Mode): Record<DerivedRole, string> {
  const c = source.color;
  const towardInk: 1 | -1 = mode === "light" ? -1 : 1;
  const hover = stepUntil(c.surface, towardInk, (x) => separated(x, [c.surface, c.sheet]), "surface-hover");
  const pressed = stepUntil(
    hover,
    towardInk,
    (x) => separated(x, [c.surface, c.sheet, hover]),
    "surface-pressed"
  );
  const mutedSoft = stepUntil(
    c.surface,
    towardInk,
    (x) => separated(x, [c.surface, c.sheet, hover, pressed]),
    "muted-soft"
  );

  const fillHosts = [c.surface, c["surface-muted"], c.sheet, ...source.canvas];
  const inks = [c["on-primary"], c.ink];
  const bestInk = (fill: string) =>
    inks.reduce((best, ink) => (contrast(ink, fill) > contrast(best, fill) ? ink : best));
  const fillOk = (fill: string) =>
    fillHosts.every((h) => contrast(fill, h) >= NON_TEXT_MIN_CONTRAST) &&
    contrast(bestInk(fill), fill) >= TEXT_MIN_CONTRAST;
  const dangerFill = fillOk(c.danger)
    ? c.danger
    : stepUntil(c.danger, towardInk, fillOk, "danger-fill");

  return {
    "surface-hover": hover,
    "surface-pressed": pressed,
    "muted-soft": mutedSoft,
    "danger-fill": dangerFill,
    "on-danger-fill": bestInk(dangerFill),
  };
}

function build(): Record<ThemeId, Record<Mode, ThemeModeTokens>> {
  const out = {} as Record<ThemeId, Record<Mode, ThemeModeTokens>>;
  for (const theme of THEME_IDS) {
    out[theme] = {} as Record<Mode, ThemeModeTokens>;
    for (const mode of MODES) {
      const source = THEME_SOURCE[theme][mode];
      out[theme][mode] = { ...source, derived: deriveRoles(source, mode) };
    }
  }
  return out;
}

/** 표의 값 + 표 밖 역할. 화면과 생성기가 읽는 것은 이것이다. */
export const THEMES: Readonly<Record<ThemeId, Readonly<Record<Mode, ThemeModeTokens>>>> = build();

export function themeTokens(theme: ThemeId, mode: Mode): ThemeModeTokens {
  return THEMES[theme][mode];
}

// ---- 대비 쌍 — 표 §3의 전수 범위 -------------------------------------------

/** 텍스트 기준(4.5)으로 재는 전경. */
export const TEXT_FOREGROUNDS = [
  "ink",
  "ink-muted",
  "signal-text",
  "agent",
  "ok",
  "warn",
  "danger",
] as const satisfies readonly ColorRole[];

/** 비텍스트 기준(3)으로 재는 전경(아이콘, 입력 테두리, 신호 점, 채움 버튼 경계). */
export const NON_TEXT_FOREGROUNDS = [
  "icon",
  "line-strong",
  "signal",
  "primary",
] as const satisfies readonly ColorRole[];

/** 글자와 컨트롤이 설 수 있는 면. 바닥은 정지점마다 따로 잰다. */
export const STANDING_SURFACES = ["surface", "surface-muted", "sheet"] as const satisfies readonly ColorRole[];

/** 채움과 그 위의 글자(4.5). */
export const FILL_PAIRS = [
  ["on-primary", "primary"],
  ["on-signal", "signal"],
  ["signal-text", "signal-soft"],
  ["agent", "agent-soft"],
  ["ok", "ok-soft"],
  ["warn", "warn-soft"],
  ["danger", "danger-soft"],
] as const satisfies readonly (readonly [ColorRole, ColorRole])[];

/**
 * 띠 위에 설 수 있는 역할(ADR-0189 D2, 표 §3 「띠 위 규칙」). 다른 역할은 띠 위에
 * 쓰지 않는다. 금지 규칙이라 시험이 이 목록 밖의 역할이 실제로 기준에 못 미치는
 * 것도 함께 잰다.
 */
export const BAND_ALLOWED_FOREGROUNDS = [
  ["on-band", TEXT_MIN_CONTRAST],
  ["on-band-muted", TEXT_MIN_CONTRAST],
  ["signal", NON_TEXT_MIN_CONTRAST],
] as const;

export interface ContrastPair {
  theme: ThemeId;
  mode: Mode;
  foreground: string;
  background: string;
  fg: string;
  bg: string;
  min: number;
}

/**
 * 테마 × 모드 × 쌍 전부. 테마·역할·정지점을 더하면 이 목록이 저절로 는다.
 * 바닥의 정지점은 값이 같아도(평면 테마) 한 번만 센다.
 */
export function contrastPairs(themes: typeof THEMES = THEMES): ContrastPair[] {
  const pairs: ContrastPair[] = [];
  for (const theme of Object.keys(themes) as ThemeId[]) {
    for (const mode of MODES) {
      const t = themes[theme][mode];
      const c = t.color;
      const stops = [...new Set(t.canvas)];
      const backgrounds: [string, string][] = [
        ...STANDING_SURFACES.map((s): [string, string] => [s, c[s]]),
        ...stops.map((hex, i): [string, string] => [
          stops.length === 1 ? "canvas" : CANVAS_STOPS[i],
          hex,
        ]),
      ];
      const fgs: [string, number][] = [
        ...TEXT_FOREGROUNDS.map((r): [string, number] => [r, TEXT_MIN_CONTRAST]),
        ...NON_TEXT_FOREGROUNDS.map((r): [string, number] => [r, NON_TEXT_MIN_CONTRAST]),
      ];
      for (const [fgRole, min] of fgs) {
        for (const [bgRole, bg] of backgrounds) {
          pairs.push({ theme, mode, foreground: fgRole, background: bgRole, fg: c[fgRole as ColorRole], bg, min });
        }
      }
      if (t.band) {
        for (const [role, min] of BAND_ALLOWED_FOREGROUNDS) {
          const fg = role === "signal" ? c.signal : t.band[role];
          pairs.push({ theme, mode, foreground: role, background: "band", fg, bg: t.band.band, min });
        }
      }
      for (const [fgRole, bgRole] of FILL_PAIRS) {
        pairs.push({ theme, mode, foreground: fgRole, background: bgRole, fg: c[fgRole], bg: c[bgRole], min: TEXT_MIN_CONTRAST });
      }
    }
  }
  return pairs;
}

/** 신호와 구분돼야 하는 두 색 사이의 OKLab 하한(ADR-0189 D2·D3). */
export const SIGNAL_MIN_DISTANCE = 0.07;
