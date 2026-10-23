// =============================================================================
// 테마 파생 엔진 — 색 씨앗 열두 색에서 oort 의미 토큰을 만든다 (ADR-0189 증보 3 D2, AP-1b #4188).
//
// Adapted from block/buzz `desktop/src/shared/theme/adaptive-theme.ts` @ af5bb0a
// (https://github.com/block/buzz, Apache-2.0, Copyright 2026 Block, Inc.).
// Changed by oort (Apache-2.0 §4(b)):
//   · 유지한 것: 바탕 휘도로 라이트·다크를 가르는 규칙(`< 0.5`), 사이드바 바탕(`chrome`)을 바탕보다
//     `0.035·ln(1+(L+0.0135)·10)`만큼 낮은 휘도로 잡는 산수와 그 휘도를 찾는 이분 탐색, 위 면을
//     `elevate`로 한 단 올리는 방식, 선을 바탕과 글자의 12%(라이트)·15%(다크)로 섞는 식. 섞는 색 공간은
//     Buzz처럼 sRGB다.
//   · 바꾼 것: 출력이 shadcn HSL 변수 35개가 아니라 oort의 의미 토큰(`COLOR_ROLES` 22 · 바닥 3 ·
//     표 밖 5 · `glass`·`scrim` · 웹 전용 `pane`)이다. Buzz는 대비를 강제하지 않지만(알파로 눌러 둔다) oort는
//     ADR-0189 D7의 대비 규칙을 모든 테마에 전수로 건다: 위반한 색은 **OKLCH 명도만** 옮겨 맞춘다
//     (라이트는 더 어둡게, 다크는 더 밝게만). 글자·톤 글자·아이콘·테두리는 표면 다섯뿐 아니라 **가리킨 행·눌린 행·칩
//     그릇**(`surface-hover`·`surface-pressed`·`muted-soft`) 위에서도 지킨다. 톤·에이전트의 옅은 채움(칩 그릇)은 그 띠의 끝(`muted-soft`의
//     휘도)에 **한 평면으로** 서고 색상각은 그 색의 것, 채도는 중립 그릇과 갈릴 만큼이다(첫 파티의 「한 평면, 색상만 다르다」). 선택 행
//     채움(`signal-soft`)은 면과 그 평면 사이에 앉아 그릇이 그 위에서도 산다(띠의 끝에서 지키면 안쪽은 따라온다, README §2.2 ·
//     설계 리뷰 H1·H-B·3차 H-1). 상태색은 의미 색상각
//     창 밖이면 oort 기본값으로 바꾼다. 신호가 먼저 정해지고 에이전트 색이 색상각을 돌려 비킨다(OKLab ≥ 0.07). 주 버튼은
//     Buzz처럼 액센트가 아니라 잉크다(`primary = ink`).
//   · 더한 것(명도 맞춤의 예외, 설계 리뷰 H2·H3·H-C): ① **채도 순서** `danger > warn > ink-muted`(README §2.2)를 지키려고
//     채도를 만진다(`ink-muted`·`icon`·`line-strong`은 상한, danger는 warn보다 선명하게 올리고 색역에 막히면 warn을 누른다.
//     색상각과 명도는 그대로). ② 신호가 중립 역할(글자·선·아이콘)과 같은 색으로 접히지 않게 한다: 테마의 신호 씨앗이 중립에
//     너무 가까우면 채도를 올려 보고, 그래도 안 되면 기본 신호 → 네 프리셋 → 중립 순으로 물러난다. ③ 에이전트 색상각은 작은
//     쪽으로 돌린다(±15° 단위). ④ **위계**: `ink`는 `ink-muted`보다 OKLab 명도로 .10 이상 글자 쪽에 있다. `ink-muted`가
//     글자 호스트 때문에 4.5 문턱까지 올라와 `ink`와 겹치면 `ink`를 씨앗 너머로 민다(씨앗의 comment가 fg와 같은 색이면
//     섞은 색에서 출발한다).
//   · 일부러 뺀 것: 없다. 첫 파티는 눌린 행·칩 그릇 위의 톤 글자와 선택 행 위의 테두리를 손으로 맞춘 값이 못 지켜서 빼
//     두었지만, 카탈로그는 기계가 맞추므로 첫 파티의 닫힌 표(17면)를 **전부** 지킨다(웹 `derivedCatalog.contract.test.ts`).
//
// 순수 함수만 둔다. 같은 씨앗은 언제나 같은 토큰을 낸다(난수·시계 없음). 이 파일은 카탈로그를 모른다:
// 씨앗은 호출자가 넘기고, 카탈로그 위의 조회는 `deriveCatalog.ts`가 한다. 그래서 가져온 테마·사용자
// 테마(AP-5)도 같은 함수를 쓴다.
//
// 거절은 구문 오류뿐이다. 씨앗이 어떻게 생겼든 명도만으로 도달할 수 있는 역할(글자·선·상태색·에이전트)은
// 항상 도달하고, 도달할 수 없거나 중립 역할에 접히는 신호는 기본 신호 → 네 프리셋 → 잉크(중립) 순으로 물러난다. 정말로
// 어떤 역할도 세울 수 없는 씨앗(바탕이 중간 휘도라 어느 방향으로도 4.5:1에 못 닿는 경우)은 `DeriveError`를 던진다.
// =============================================================================

import { contrast, fromOklch, luminance, mixOklab, normalizeHex, oklabDistance, parseHex, toOklab, toOklch } from "./color";
import type { SignalChoice } from "./appearance";
import {
  SIGNAL_PRESETS,
  SIGNAL_PRESET_IDS,
  resolveSignal,
  type SignalPresetId,
  type SignalRejection,
  type SignalResult,
} from "./signal";
import { seedMode, type ThemeSeed } from "./themeSeed";
import { BAND_ROLES, CANVAS_STOPS, COLOR_ROLES, DERIVED_ROLES, type ColorRole } from "./themeRoles";
import {
  SIGNAL_MIN_DISTANCE,
  TEXT_MIN_CONTRAST,
  THEMES,
  NON_TEXT_MIN_CONTRAST,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
  deriveRoles,
  deriveStateSurfaces,
  type Mode,
  type ThemeModeSource,
  type ThemeModeTokens,
} from "./themes";

/** 알고리즘이 바뀌면 올린다. 부트 캐시 키에 들어가서 낡은 캐시를 한꺼번에 무효로 한다. */
export const DERIVE_ENGINE_VERSION = "4";

export class DeriveError extends Error {
  constructor(
    readonly role: string,
    message: string
  ) {
    super(message);
    this.name = "DeriveError";
  }
}

/** 보정이 색을 옮긴 기록(「대비를 위해 N곳 조정됨」이 읽는다). */
export interface DeriveNote {
  readonly role: string;
  readonly from: string;
  readonly to: string;
  /** OKLab 거리. */
  readonly delta: number;
  /** 에이전트 색상각을 돌린 각도(돌렸을 때만). */
  readonly rotated?: number;
}

/** 신호가 어디서 왔는가: 사람의 선택 · 테마의 씨앗 · oort 기본 · 네 프리셋 가운데 처음 서는 것 · 중립(잉크). */
export type SignalSource = "choice" | "seed" | "default" | "preset" | "neutral";

/** 테마 자신의 신호 후보가 거절된 이유: `resolveSignal`의 이유 또는 「중립 역할과 너무 가깝다」. */
export type OwnSignalRejection = SignalRejection | "near-neutral";

export interface SignalOutcome {
  readonly source: SignalSource;
  /** 사람이 고른 신호(프리셋·직접 입력)가 이 테마·모드에서 거절된 이유. 받아들여졌거나 고른 적이 없으면 없다. */
  readonly choiceRejection?: SignalRejection;
  /** 테마의 신호 씨앗이 거절된 이유. */
  readonly seedRejection?: OwnSignalRejection;
  /** oort 기본 신호가 이 테마·모드에서 거절된 이유(씨앗이 쓰이지 못했을 때만 본다). */
  readonly defaultRejection?: OwnSignalRejection;
  /** 폴백으로 쓴 프리셋(`source`가 `preset`일 때). */
  readonly preset?: SignalPresetId;
  /** 씨앗이 중립 역할에 너무 가까워 채도를 올려서 받았다(`source`가 `seed`일 때만). 색상각은 씨앗 그대로다. */
  readonly boosted?: true;
}

export interface DerivedMode {
  readonly mode: Mode;
  readonly tokens: ThemeModeTokens;
  /** 본문 판 색(웹 전용 역할). */
  readonly pane: string;
  readonly notes: readonly DeriveNote[];
  readonly signal: SignalOutcome;
}

export interface DeriveOptions {
  /** 사람이 고른 신호(프리셋·직접 입력). 없으면 테마의 신호 씨앗이다. */
  readonly signal?: SignalChoice;
  /**
   * 대비 보정(명도 맞춤)과 에이전트 색상각 회전을 한다. 기본 참이다. 거짓은 **분석용**이다: Buzz처럼 씨앗에서
   * 파생만 하면 규칙을 얼마나 어기는지(시험이 보정의 필요를 재고, 보정이 항등으로 망가지면 시험이 빨개짐을 보인다).
   * 화면에는 쓰지 않는다.
   */
  readonly adjust?: boolean;
}

// ---- Buzz의 sRGB 산수 ------------------------------------------------------------

type Channels = readonly [number, number, number];

const WHITE: Channels = [255, 255, 255];
const BLACK: Channels = [0, 0, 0];

function channelsOf(hex: string): Channels {
  const channels = parseHex(hex);
  if (!channels) throw new DeriveError("seed", `not a #RRGGBB color: ${hex}`);
  return channels;
}

function hexOfChannels(channels: readonly number[]): string {
  return (
    "#" +
    channels
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** `from`에서 `to` 쪽으로 `factor`만큼 섞는다(채널별 선형, sRGB). Buzz `mix`. */
function mixToward(from: string, to: Channels, factor: number): string {
  const a = channelsOf(from);
  return hexOfChannels(a.map((v, i) => v + (to[i] - v) * factor));
}

function mixHex(from: string, to: string, factor: number): string {
  return mixToward(from, channelsOf(to), factor);
}

/** 위(+)·아래(-)로 흰색·검정 쪽에 섞는다. Buzz `adjust`. */
function adjust(hex: string, amount: number): string {
  return mixToward(hex, amount > 0 ? WHITE : BLACK, Math.abs(amount));
}

const CHROME_CONTRAST_VALUE = 0.035;
const CHROME_CONTRAST_OFFSET = 0.0135;

function chromeLuminanceDrop(bgLuminance: number): number {
  return CHROME_CONTRAST_VALUE * Math.log(1 + (bgLuminance + CHROME_CONTRAST_OFFSET) * 10);
}

/** `base`를 검정·흰색 쪽으로 섞어 목표 휘도에 닿는 색. Buzz `findColorWithLuminance`(이분 탐색 20회). */
function findColorWithLuminance(base: string, target: number): string {
  const baseLuminance = luminance(base);
  if (Math.abs(baseLuminance - target) < 0.001) return base;
  const toward = target < baseLuminance ? BLACK : WHITE;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const probe = luminance(mixToward(base, toward, mid));
    if (Math.abs(probe - target) < 0.001) break;
    if (toward === BLACK) {
      if (probe > target) lo = mid;
      else hi = mid;
    } else if (probe < target) lo = mid;
    else hi = mid;
  }
  return mixToward(base, toward, (lo + hi) / 2);
}

/**
 * 바탕에서 사이드바 색(`chrome`)과 본문 판 색(`primary`)을 낸다. 바탕이 너무 어두워 휘도를 그만큼 내릴 수
 * 없으면 바닥은 순흑이고 판이 휘도 d만큼 올라간 색이다(Buzz `calculateChromeColors`).
 */
function chromeColors(bg: string): { chrome: string; primary: string } {
  const bgLuminance = luminance(bg);
  const drop = chromeLuminanceDrop(bgLuminance);
  const target = bgLuminance - drop;
  if (target >= 0) return { chrome: findColorWithLuminance(bg, target), primary: bg };
  return { chrome: findColorWithLuminance(bg, 0), primary: findColorWithLuminance(bg, drop) };
}

// ---- 명도 맞춤 ---------------------------------------------------------------------

const L_STEP = 0.0025;
/** 순백·순흑 씨앗에서도 출발해야 한다(바닥 0.02, 천장 1.0). */
const L_FLOOR = 0.02;
const L_CEIL = 1;

const holds = (color: string, hosts: readonly string[], min: number): boolean =>
  hosts.every((host) => contrast(color, host) >= min);

/**
 * 색상각·채도를 지키고 명도만 `ok`가 처음 참이 되는 곳까지 옮긴다. 라이트는 어둡게, 다크는 밝게만 간다.
 * 입력이 이미 `ok`면 그대로다. 끝까지 못 찾으면 `null`이다(정수 단계로 세어 부동소수점 누적이 없다).
 * `minChroma`를 주면 채도를 그만큼 **올려서** 출발한다(후보마다 그 명도의 색역 한계까지만 올라간다).
 */
function fitLightness(start: string, mode: Mode, ok: (hex: string) => boolean, minChroma = 0): string | null {
  const given = normalizeHex(start);
  const o = toOklch(given);
  const C = Math.max(o.C, minChroma);
  const first = C > o.C ? fromOklch({ L: o.L, C, h: o.h }) : given;
  if (ok(first)) return first;
  const dir = mode === "light" ? -1 : 1;
  for (let i = 1; ; i++) {
    const n = o.L + dir * i * L_STEP;
    if (n < L_FLOOR - 1e-9 || n > L_CEIL + 1e-9) return null;
    const candidate = fromOklch({ L: n, C, h: o.h });
    if (ok(candidate)) return candidate;
  }
}

/** 역할 하나를 맞추는 함수. 기본은 명도 맞춤이고, 분석용(`adjust: false`)은 씨앗을 그대로 쓴다. */
type Fitter = (role: string, start: string, mode: Mode, ok: (hex: string) => boolean, minChroma?: number) => string;

const fitOrThrow: Fitter = (role, start, mode, ok, minChroma) => {
  const fitted = fitLightness(start, mode, ok, minChroma);
  if (fitted === null) throw new DeriveError(role, `no lightness reaches the contrast rule for ${role} (${start})`);
  return fitted;
};

const keepAsIs: Fitter = (_role, start) => normalizeHex(start);

/** 톤·에이전트의 옅은 채움(칩 그릇)을 만드는 함수: 색 하나를 받아 그 색의 그릇을 낸다(면·모드·띠가 안에 묶여 있다). */
type SoftFor = (color: string) => string;

/** 분석용(보정 없음)의 옅은 채움: 면(`surface`)에서 색 쪽으로 OKLab 12%(라이트)·18%(다크) 섞은 색이다. */
function mixSoft(surface: string, color: string, mode: Mode): string {
  return mixOklab(surface, color, mode === "light" ? 0.12 : 0.18);
}

// ---- 칩 그릇의 평면과 선택 행 채움 -----------------------------------------------------
//
// 글자(`ink`·`ink-muted`·톤 글자·아이콘·테두리)는 가리킨 행·눌린 행·칩 그릇 위에서도 지킨다. 칩 그릇(`muted-soft`)이 이 띠의 가장
// 바깥이라, 옅은 채움이 그 띠 안에 있으면 「띠의 끝에서 지키면 안쪽은 따라온다」(대비는 휘도만 본다).
//
// 첫 파티는 네 그릇(`muted-soft`·`ok-soft`·`warn-soft`·`danger-soft`)을 **한 평면**에 세우고 색상·채도로만 가른다(README §2.2
// 「한 평면, 색상만 다르다」). 톤 쪽으로 섞는 비율을 줄여서 띠 안에 가두면(설계 리뷰 3차 H-1) 밝은 톤 색이 휘도를 끌어올려서
// 비율이 3~12%까지 내려가고, 그러면 채도가 같이 지워져 톤 그릇이 중립 그릇으로 접힌다. 그래서 휘도는 띠 끝(`muted-soft`)에
// 두고, 색상각은 그 색의 것을 지키고, 채도는 중립 그릇과 갈릴 만큼 **올린다**: 휘도와 채도는 서로 다른 축이다.

/** 그릇의 채도(OKLab C) 바닥과 상한. 첫 파티의 톤 그릇은 .034~.043이다. 상한은 면의 색조가 짙은 테마에서 그 색조 위로 올라간다. */
const VESSEL_CHROMA_FLOOR = 0.03;
const VESSEL_CHROMA_CAP = 0.09;
const VESSEL_CHROMA_STEP = 0.005;
/** 톤 그릇이 중립 그릇(`muted-soft`)과 갈리는 목표(OKLab). 가드는 .02이고(첫 파티 최저 .0456) 여기서는 반 넘는 여유를 둔다. */
const VESSEL_SIBLING_TARGET = 0.03;
/** 평면에서 면 쪽으로 물러날 수 있는 최대 칸 수(칸마다 OKLab 명도 한 걸음). */
const VESSEL_LIFT_STEPS = 6;
/** 선택 행 채움: 채도 바닥, 그리고 「면·칩 그릇·눌린 행과 두 자(살아남는 두 자)를 이만큼 넘는다」는 목표 여유(비율). */
const TINT_CHROMA_FLOOR = 0.03;
const TINT_MARGIN_TARGET = 0.04;
/** 선택 행 채움을 면에서 칩 그릇 평면까지의 대비 공간에서 어디에 앉혀 보는가(0 = 면, 1 = 평면). 한가운데부터 바깥으로. */
const TINT_POSITIONS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9] as const;
/** 살아남는 두 자(`VESSEL_MIN_*`)에 더하는 여유: 8비트로 내릴 때 생기는 어긋남을 흡수한다. */
const SURVIVAL_CONTRAST_MARGIN = 0.002;
const SURVIVAL_DISTANCE_MARGIN = 0.002;

/** 가리킨 행·눌린 행·칩 그릇: `deriveStateSurfaces`의 값이다. */
interface StateFills {
  readonly hover: string;
  readonly pressed: string;
  readonly mutedSoft: string;
}

interface Fills {
  /** 톤·에이전트의 그릇: 휘도는 띠 끝, 색상각은 그 색의 것, 채도는 중립 그릇과 갈릴 만큼. */
  readonly softFor: SoftFor;
  /** 선택 행 채움(`signal-soft`)을 띠 안에 앉힌다: 그릇이 그 위에서도 살아남는 휘도, 신호의 색상각, 눌린 행과 갈리는 채도. */
  readonly placeSelected: (soft: string) => string;
}

/** 휘도가 `target`에 가장 가까이 닿는 OKLab 명도(같은 채도·색상각). `below`는 그 휘도 이하, `above`는 이상, `near`는 가장 가까운 쪽이다. */
function lightnessForLuminance(target: number, C: number, h: number, side: "below" | "above" | "near"): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(fromOklch({ L: mid, C, h })) < target) lo = mid;
    else hi = mid;
  }
  return side === "below" ? lo : side === "above" ? hi : (lo + hi) / 2;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function makeFills(surface: string, states: StateFills, mode: Mode, adjusting: boolean): Fills {
  if (!adjusting) return { softFor: (color) => mixSoft(surface, color, mode), placeSelected: (soft) => soft };
  const { hover, pressed, mutedSoft } = states;
  const dark = mode === "dark";
  const edgeY = luminance(mutedSoft);
  const planeLab = toOklab(mutedSoft);
  const planeChroma = Math.hypot(planeLab.a, planeLab.b);
  const planeHue = Math.atan2(planeLab.b, planeLab.a);
  const towardSurface = dark ? -1 : 1;
  const beyond = (hex: string) => (dark ? luminance(hex) > edgeY + 1e-9 : luminance(hex) < edgeY - 1e-9);
  const apart = (hex: string, host: string) =>
    contrast(hex, host) >= VESSEL_MIN_CONTRAST + SURVIVAL_CONTRAST_MARGIN &&
    oklabDistance(hex, host) >= VESSEL_MIN_DISTANCE + SURVIVAL_DISTANCE_MARGIN;
  const rowHosts = [surface, hover, pressed];

  const vessels = new Map<string, string>();
  const softFor: SoftFor = (color) => {
    const o = toOklch(normalizeHex(color));
    const key = `${o.h.toFixed(1)}|${o.C.toFixed(3)}`;
    const known = vessels.get(key);
    if (known !== undefined) return known;
    // 시작 채도: 톤이 내던 몫(섞는 비율 × 그 색의 채도), 바닥, 그리고 면의 색조가 이 톤 방향으로 이미 가진 몫. 마지막 것이
    // 없으면 면이 이미 붉은 테마에서 위험 그릇이 중립 그릇보다 **덜** 붉어진다(같은 색상각에서는 채도 차이가 거리의 전부다).
    const nominal = o.C * (dark ? 0.18 : 0.12);
    const along = Math.max(0, planeChroma * Math.cos((o.h * Math.PI) / 180 - planeHue));
    const start = Math.max(nominal, VESSEL_CHROMA_FLOOR, along);
    const cap = Math.max(VESSEL_CHROMA_CAP, along + 2 * VESSEL_SIBLING_TARGET);
    let best: { hex: string; gap: number } | null = null;
    let found: string | null = null;
    search: for (let c = start; c <= cap + 1e-9; c = round3(c + VESSEL_CHROMA_STEP)) {
      // 휘도를 띠 끝에 맞춘 명도에서 시작한다: 같은 명도라도 색상각마다 휘도가 달라서(초록은 빨강보다 밝다) 명도를 그대로 쓰지 않는다.
      const matched = lightnessForLuminance(edgeY, c, o.h, dark ? "below" : "above");
      let clipped = false;
      for (let k = 0; k < VESSEL_LIFT_STEPS; k++) {
        const hex = fromOklch({ L: matched + towardSurface * k * L_STEP, C: c, h: o.h });
        if (k === 0) clipped = toOklch(hex).C < c - 0.002; // 색역이 막아서 더 올릴 채도가 없다.
        if (beyond(hex) || !rowHosts.every((host) => apart(hex, host))) continue;
        const gap = oklabDistance(hex, mutedSoft);
        if (gap >= VESSEL_SIBLING_TARGET) {
          found = hex;
          break search;
        }
        if (best === null || gap > best.gap) best = { hex, gap };
        break;
      }
      if (clipped) break;
    }
    const result = found ?? best?.hex ?? mutedSoft;
    vessels.set(key, result);
    return result;
  };

  // 선택 행 채움: 면과 칩 그릇(평면) 사이의 휘도에 앉힌다. 그러면 칩 그릇이 그 위에서도, 면에서도 산다. 면의 색조가 짙은 테마에서는
  // 채도만으로는 눌린 행과 안 갈려서 휘도의 위치도 함께 움직여 본다(여유가 가장 큰 곳을 고른다).
  const yFrom = (position: number) =>
    Math.exp((1 - position) * Math.log(luminance(surface) + 0.05) + position * Math.log(edgeY + 0.05)) - 0.05;
  const margin = (hex: string): number =>
    Math.min(
      contrast(hex, surface) / VESSEL_MIN_CONTRAST - 1,
      oklabDistance(hex, surface) / VESSEL_MIN_DISTANCE - 1,
      contrast(hex, mutedSoft) / VESSEL_MIN_CONTRAST - 1,
      oklabDistance(hex, mutedSoft) / VESSEL_MIN_DISTANCE - 1,
      oklabDistance(hex, pressed) / VESSEL_MIN_DISTANCE - 1
    );
  const tintCap = Math.max(VESSEL_CHROMA_CAP, planeChroma + 2 * VESSEL_SIBLING_TARGET);
  const placeSelected = (soft: string): string => {
    const o = toOklch(soft);
    const original = luminance(soft);
    // 채도는 원래 채움의 것에 가까운 쪽부터 본다(면의 색조가 짙은 테마에서는 원래 채움의 채도에 그 색조가 섞여 있어서 위아래 양쪽을 본다).
    const chromas: number[] = [];
    for (let c = TINT_CHROMA_FLOOR; c <= tintCap + 1e-9; c = round3(c + VESSEL_CHROMA_STEP)) chromas.push(c);
    chromas.sort((a, b) => Math.abs(a - o.C) - Math.abs(b - o.C));
    // 두 단계로 고른다: 살아남는 두 자의 여유 목표를 채우는 후보 가운데 가리킨 행과도 갈리는 첫 후보(키보드 강조와 가리킴은 다른 단계다),
    // 그런 후보가 없으면 가리킨 행과 가장 먼 후보, 여유 목표를 채우는 후보가 없으면 여유가 가장 큰 후보.
    let best: { hex: string; margin: number } | null = null;
    let apartFromHover: { hex: string; gap: number } | null = null;
    for (const position of TINT_POSITIONS) {
      const target = yFrom(position);
      // 원래 채움보다 글자 쪽(`signal-text`가 그 채움 위 4.5로 풀린 쪽)으로는 가지 않는다: 다크는 더 어둡게만, 라이트는 더 밝게만.
      if (dark ? target > original + 1e-9 : target < original - 1e-9) continue;
      for (const c of chromas) {
        const hex = fromOklch({ L: lightnessForLuminance(target, c, o.h, "near"), C: c, h: o.h });
        if (beyond(hex)) continue;
        const m = margin(hex);
        if (m >= TINT_MARGIN_TARGET) {
          const gap = oklabDistance(hex, hover);
          if (gap >= VESSEL_MIN_DISTANCE + SURVIVAL_DISTANCE_MARGIN) return hex;
          if (apartFromHover === null || gap > apartFromHover.gap) apartFromHover = { hex, gap };
        }
        if (best === null || m > best.margin) best = { hex, margin: m };
      }
    }
    return apartFromHover?.hex ?? best?.hex ?? soft;
  };
  return { softFor, placeSelected };
}

/**
 * 글자로 서는 색과 그 색의 옅은 채움. 채움(그릇)은 칩 그릇 띠의 끝에 서므로(`makeFills`) 띠 호스트(칩 그릇 `muted-soft` 포함)
 * 위 4.5가 자기 채움 위 4.5를 이미 보장한다(대비는 휘도만 본다). 그래서 후보마다 채움을 만들지 않고, 맞춘 색의 채움을 한 번만 낸다.
 */
function fitWithSoft(
  role: string,
  rawSeed: string,
  hosts: readonly string[],
  softFor: SoftFor,
  mode: Mode,
  fit: Fitter,
  minChroma = 0
): Status & { readonly start: string } {
  const start = normalizeHex(rawSeed);
  const ok = (hex: string) => holds(hex, hosts, TEXT_MIN_CONTRAST);
  const color = fit(role, start, mode, ok, minChroma);
  return { color, soft: softFor(color), start };
}

// ---- 기본값: oort의 첫 파티(새벽하늘) ------------------------------------------------

function defaults(mode: Mode) {
  return THEMES.dawnsky[mode];
}

/** 의미 색상각 창(OKLCH h, 도). 창 밖이거나 채도가 0.04 미만이면 그 테마의 색을 쓰지 않는다. */
const HUE_WINDOWS = { danger: [10, 40], ok: [120, 170], warn: [60, 100] } as const;
const MIN_SEMANTIC_CHROMA = 0.04;

function inWindow(hex: string, [lo, hi]: readonly [number, number]): boolean {
  const { C, h } = toOklch(hex);
  return C >= MIN_SEMANTIC_CHROMA && h >= lo && h <= hi;
}

function semanticSeed(
  candidates: readonly (string | undefined)[],
  window: readonly [number, number],
  fallback: string
): { hex: string; fromTheme: boolean } {
  for (const candidate of candidates) {
    if (candidate !== undefined && inWindow(candidate, window)) return { hex: candidate, fromTheme: true };
  }
  return { hex: fallback, fromTheme: false };
}

// ---- 채도 (OKLCH C) ----------------------------------------------------------------

/** 중립 글자·선·아이콘(`ink-muted`·`icon`·`line-strong`)의 채도 상한. 위험 순서의 자는 채도다: danger > warn > ink-muted(README §2.2). */
const NEUTRAL_CHROMA_CAP = 0.04;
/** danger가 warn보다 이만큼 더 선명하길 바란다(첫 파티는 .04~.08). 못 미치면 danger를 먼저 올리고, 그래도 모자라면 warn을 누른다. */
const DANGER_OVER_WARN = 0.03;
/** danger의 채도 상한. 첫 파티 위험색이 .18이고, 이보다 선명하면 앱 안에서 혼자 튄다. */
const DANGER_CHROMA_MAX = 0.19;
const WARN_OVER_MUTED = 0.02;
/** 맞춘 뒤 실제 색(8비트 반올림·색역)에서 다시 재는 최소 순서 간격. */
const ORDER_MARGIN = 0.01;
/** 8비트 반올림이 채도를 이만큼 키울 수 있다. */
const CHROMA_ROUNDING = 0.004;
/** warn을 누를 때 한 번에 내리는 채도. */
const WARN_PRESS_STEP = 0.015;

const chromaOf = (hex: string): number => toOklch(normalizeHex(hex)).C;

/** 색상각·명도를 지키고 채도만 `c`로 둔다(색역 밖이면 `fromOklch`가 그 한계까지만 올린다). */
function withChroma(hex: string, c: number): string {
  const o = toOklch(normalizeHex(hex));
  return fromOklch({ L: o.L, C: c, h: o.h });
}

const capChroma = (hex: string, max: number): string =>
  chromaOf(hex) > max ? withChroma(hex, max) : normalizeHex(hex);

// ---- 위계: ink와 ink-muted ----------------------------------------------------------

/**
 * `ink`는 `ink-muted`보다 이만큼(OKLab 명도, 글자 쪽으로) 더 나가 있다. 첫 파티는 .23~.31이고 카탈로그 씨앗의 중앙값이 .28이다.
 * 글자 호스트가 늘면 `ink-muted`가 4.5 문턱까지 올라와 `ink`와 겹치므로(설계 리뷰 2차 H-C), `ink`를 씨앗 너머로 더 민다.
 */
const INK_OVER_MUTED = 0.1;
/** 씨앗의 comment가 fg와 이만큼(OKLab)도 안 다르면 쓸모없는 값이다(houston·material은 둘이 같은 색이다): 섞은 색으로 대신한다. */
const COMMENT_MIN_GAP = 0.05;

// ---- 신호와 무관한 부분 (한 번 계산해 신호 후보마다 재사용한다) ----------------------

interface Status {
  readonly color: string;
  readonly soft: string;
}

interface Base {
  readonly mode: Mode;
  readonly seed: ThemeSeed;
  readonly chrome: string;
  readonly pane: string;
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly sheet: string;
  /** 글자·아이콘이 설 수 있는 면 전부(표면·시트·판·바닥). */
  readonly hosts: readonly string[];
  /**
   * 글자·아이콘·테두리가 설 수 있는 면 전부: 위의 면에 **가리킨 행·눌린 행·칩 그릇**을 더한 것. 칩 그릇(`muted-soft`)이 띠의
   * 가장 바깥이고 톤·신호·에이전트의 옅은 채움은 그 띠 안에 있으므로(`makeFills`), 이 목록 위에서 지키면 어느 채움 위에서도
   * 지킨다. 첫 파티는 눌린 행·칩 그릇을 톤 글자의 호스트에서 뺐지만(손으로 맞춘 값이 못 미친다) 기계는 뺄 이유가 없다.
   */
  readonly bandHosts: readonly string[];
  /** 칩 그릇(`muted-soft`): 신호를 풀 때 바닥 정지점 한 칸에 실어 신호가 띠의 끝에서도 읽히게 한다. */
  readonly mutedSoft: string;
  /** 톤·에이전트의 칩 그릇을 만드는 함수(휘도는 띠 끝, 색상각은 그 색의 것, 채도는 중립 그릇과 갈릴 만큼). */
  readonly softFor: SoftFor;
  /** 신호의 옅은 채움(선택 행)을 띠 안에 앉힌다(`resolveSignal`은 이 띠를 모른다). */
  readonly placeSelected: (soft: string) => string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly icon: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly onPrimary: string;
  readonly danger: Status;
  readonly ok: Status;
  readonly warn: Status;
  readonly notes: readonly DeriveNote[];
}

function noteOf(role: string, from: string, to: string, extra: Partial<DeriveNote> = {}): DeriveNote[] {
  const start = normalizeHex(from);
  return start === to ? [] : [{ role, from: start, to, delta: oklabDistance(start, to), ...extra }];
}

const baseCache = new WeakMap<ThemeSeed, Base>();

function deriveBase(seed: ThemeSeed, fit: Fitter = fitOrThrow): Base {
  const cacheable = fit === fitOrThrow;
  const cached = cacheable ? baseCache.get(seed) : undefined;
  if (cached) return cached;
  const mode = seedMode(seed);
  const { chrome, primary: pane } = chromeColors(seed.bg);
  const elevate = (amount: number) => adjust(pane, (mode === "dark" ? 1 : -1) * amount);
  const surface = mode === "light" ? pane : elevate(0.04);
  const surfaceMuted = mode === "light" ? elevate(0.04) : elevate(0.08);
  const sheet = chrome;
  const hosts = [surface, surfaceMuted, sheet, pane, chrome];
  // 글자는 가리킨 행·눌린 행·칩 그릇 위에도 선다. 이 셋은 `surface`·`sheet`에만 달려서 미리 안다. 칩 그릇(`muted-soft`)이
  // 띠의 가장 바깥이고, 톤·에이전트의 그릇은 그 띠 끝의 평면에 서고 선택 행 채움은 띠 안에 앉는다(`makeFills`): 띠의 끝에서
  // 지키면 안쪽은 따라온다.
  const states = deriveStateSurfaces(surface, sheet, mode);
  const bandHosts = [...hosts, states.hover, states.pressed, states.mutedSoft];
  const adjusting = cacheable;
  const { softFor, placeSelected } = makeFills(surface, states, mode, adjusting);
  const notes: DeriveNote[] = [];

  // 상태색을 먼저 맞춘다: 그 채도가 중립 글자의 채도 상한을 정한다(위험 순서 danger > warn > ink-muted).
  // warn은 자기 씨앗대로, danger는 warn보다 선명하도록 채도를 **올려서** 맞춘다. danger가 색역에 막혀 못 올라가면
  // (명도를 옮긴 자리의 한계) 그때 warn을 누른다.
  const fallback = defaults(mode).color;
  const dangerSeed = semanticSeed([seed.deleted, seed.ansiRed], HUE_WINDOWS.danger, fallback.danger).hex;
  const okSeed = semanticSeed([seed.added, seed.ansiGreen], HUE_WINDOWS.ok, fallback.ok).hex;
  const warnSeed = semanticSeed([seed.modified, seed.ansiYellow], HUE_WINDOWS.warn, fallback.warn).hex;
  const statusFit = (role: string, rawSeed: string, minChroma = 0) =>
    fitWithSoft(role, rawSeed, bandHosts, softFor, mode, fit, minChroma);
  let warnStart = warnSeed;
  let warn = statusFit("warn", warnStart);
  const dangerAsk = () => (adjusting ? Math.min(DANGER_CHROMA_MAX, chromaOf(warn.color) + DANGER_OVER_WARN) : 0);
  let danger = statusFit("danger", dangerSeed, dangerAsk());
  // 색역 때문에 못 올라갔으면 실제 색으로 다시 재서 warn을 누른다.
  for (let attempt = 0; adjusting && chromaOf(danger.color) < chromaOf(warn.color) + ORDER_MARGIN; attempt++) {
    if (attempt >= 12 || chromaOf(warn.color) <= MIN_SEMANTIC_CHROMA + 0.005) {
      throw new DeriveError("warn", "no chroma keeps warn under danger");
    }
    warnStart = withChroma(warnStart, Math.max(MIN_SEMANTIC_CHROMA, chromaOf(warn.color) - WARN_PRESS_STEP));
    warn = statusFit("warn", warnStart);
    danger = statusFit("danger", dangerSeed, dangerAsk());
  }
  const ok = statusFit("ok", okSeed);
  notes.push(...noteOf("danger", dangerSeed, danger.color));
  notes.push(...noteOf("ok", okSeed, ok.color));
  notes.push(...noteOf("warn", warnSeed, warn.color));

  const neutralCap = Math.max(0, Math.min(NEUTRAL_CHROMA_CAP, chromaOf(warn.color) - WARN_OVER_MUTED) - CHROMA_ROUNDING);
  const neutral = (hex: string) => (adjusting ? capChroma(hex, neutralCap) : normalizeHex(hex));
  const textOk = (on: readonly string[], min: number) => (hex: string) => holds(hex, on, min);

  // ink-muted를 먼저 맞추고(comment가 fg와 같은 색이면 섞은 색에서 출발한다), ink는 그보다 글자 쪽으로 INK_OVER_MUTED만큼
  // 더 나가도록 맞춘다. 닿을 수 없으면(씨앗 너머가 색 범위 끝) 위계 없이 대비만 지킨다.
  const commentUsable = seed.comment !== undefined && oklabDistance(seed.comment, seed.fg) >= COMMENT_MIN_GAP;
  const commentSeed = commentUsable ? seed.comment! : mixHex(seed.fg, pane, 0.4);
  const inkMuted = fit("ink-muted", neutral(commentSeed), mode, textOk(bandHosts, TEXT_MIN_CONTRAST));
  notes.push(...noteOf("ink-muted", commentSeed, inkMuted));
  const towardInk = mode === "dark" ? 1 : -1;
  const aboveMuted = (hex: string) => towardInk * (toOklch(hex).L - toOklch(inkMuted).L) >= INK_OVER_MUTED - 1e-9;
  const inkHolds = textOk(bandHosts, TEXT_MIN_CONTRAST);
  const ink = adjusting
    ? (fitLightness(seed.fg, mode, (hex) => inkHolds(hex) && aboveMuted(hex)) ?? fit("ink", seed.fg, mode, inkHolds))
    : fit("ink", seed.fg, mode, inkHolds);
  notes.push(...noteOf("ink", seed.fg, ink));

  const iconSeed = mixHex(inkMuted, pane, 0.25);
  const icon = fit("icon", neutral(iconSeed), mode, textOk(bandHosts, NON_TEXT_MIN_CONTRAST));
  notes.push(...noteOf("icon", iconSeed, icon));
  const lineStrongSeed = mixHex(seed.fg, pane, 0.5);
  const lineStrong = fit("line-strong", neutral(lineStrongSeed), mode, textOk(bandHosts, NON_TEXT_MIN_CONTRAST));
  notes.push(...noteOf("line-strong", lineStrongSeed, lineStrong));
  const line = mixHex(pane, seed.fg, mode === "dark" ? 0.15 : 0.12);
  const onPrimary = contrast(surface, ink) >= contrast(pane, ink) ? surface : pane;

  const base: Base = {
    mode,
    seed,
    chrome,
    pane,
    surface,
    surfaceMuted,
    sheet,
    hosts,
    bandHosts,
    mutedSoft: states.mutedSoft,
    softFor,
    placeSelected,
    ink,
    inkMuted,
    icon,
    line,
    lineStrong,
    onPrimary,
    danger,
    ok,
    warn,
    notes,
  };
  if (cacheable) baseCache.set(seed, base);
  return base;
}

// ---- 신호 ------------------------------------------------------------------------

/**
 * 신호를 풀 때 쓰는 토큰. 에이전트와 파생 칸은 자리표시다(`agentYields`가 에이전트 검사를 끄고,
 * `resolveSignal`은 파생 칸을 읽지 않는다). **본문 판과 칩 그릇(띠의 가장 바깥)을 바닥 정지점 두 칸에 실어** 신호가 판 위에서도,
 * 띠의 끝에서도 3:1, 글자 신호가 4.5:1을 지키게 한다(다크에서 판은 표면과 바닥 사이의 세 번째 면이다).
 */
function solveTokens(base: Base): ThemeModeTokens {
  const placeholder = base.ink;
  const color = {
    surface: base.surface,
    "surface-muted": base.surfaceMuted,
    sheet: base.sheet,
    ink: base.ink,
    "ink-muted": base.inkMuted,
    icon: base.icon,
    line: base.line,
    "line-strong": base.lineStrong,
    primary: base.ink,
    "on-primary": base.onPrimary,
    signal: placeholder,
    "on-signal": base.onPrimary,
    "signal-text": placeholder,
    "signal-soft": base.surfaceMuted,
    agent: placeholder,
    "agent-soft": base.surfaceMuted,
    ok: base.ok.color,
    "ok-soft": base.ok.soft,
    warn: base.warn.color,
    "warn-soft": base.warn.soft,
    danger: base.danger.color,
    "danger-soft": base.danger.soft,
  } satisfies Record<ColorRole, string>;
  const derived = Object.fromEntries(DERIVED_ROLES.map((role) => [role, base.surface])) as ThemeModeTokens["derived"];
  return {
    canvas: [base.chrome, base.pane, base.mutedSoft],
    band: null,
    color,
    glass: defaults(base.mode).glass,
    scrim: defaults(base.mode).scrim,
    derived,
  };
}

type SignalValues = Readonly<Record<"signal" | "on-signal" | "signal-text" | "signal-soft", string>>;

interface SolvedSignal {
  readonly values: SignalValues;
  readonly outcome: SignalOutcome;
}

function neutralSignal(base: Base): SignalValues {
  return {
    signal: base.ink,
    "on-signal": base.onPrimary,
    "signal-text": base.ink,
    "signal-soft": base.surfaceMuted,
  };
}

/**
 * 테마가 스스로 말하는 신호(씨앗·기본·프리셋)가 중립 역할과 이만큼은 달라야 한다(OKLab). 신호는 안 읽음·멘션·캐럿·
 * 포커스 링의 색이라, 테두리·아이콘·본문과 같은 색으로 접히면 색 채널을 잃는다(설계 리뷰 H2). 첫 파티는 0.12 이상이다.
 */
const SIGNAL_NEUTRAL_DISTANCE = 0.06;
/** 옅은 씨앗의 채도를 올려 볼 때의 간격과 상한. 첫 파티 프리셋의 채도(0.11~0.17)와 같은 자리까지만 올린다. */
const SIGNAL_BOOST_STEP = 0.02;
const SIGNAL_BOOST_MAX = 0.12;
/** 이보다 옅은 색은 색상각이 뜻이 없어(무채색) 채도를 올려도 그 테마의 색이 되지 않는다. */
const SIGNAL_BOOST_MIN_CHROMA = 0.02;

const apartFromNeutrals = (base: Base, values: SignalValues): boolean => {
  const far = (a: string, b: string) => oklabDistance(a, b) >= SIGNAL_NEUTRAL_DISTANCE;
  return (
    far(values.signal, base.lineStrong) &&
    far(values.signal, base.icon) &&
    far(values.signal, base.inkMuted) &&
    far(values["signal-text"], base.ink) &&
    far(values["signal-text"], base.inkMuted)
  );
};

/**
 * 신호는 씨앗 → 기본 → 네 프리셋 → 중립 순으로 처음 서는 것이다. 사람이 고른 신호가 있으면 그것이 먼저다.
 * 테마 자신의 후보(씨앗·기본·프리셋)는 중립 역할과도 갈라야 하고, 옅은 씨앗은 채도를 올려 본다. 사람이 고른
 * 신호에는 이 규칙을 걸지 않는다(고른 것이다).
 */
function solveSignal(base: Base, choice: SignalChoice, fit: Fitter): SolvedSignal {
  const tokens = solveTokens(base);
  const attempt = (input: string): SignalResult => resolveSignal(input, "dawnsky", base.mode, tokens, { agentYields: true });
  // 신호의 옅은 채움(선택된 행의 바탕)은 받아들여진 결과에만 한 번 앉힌다: 칩 그릇 띠 안에서 그릇이 그 위에서도 살아남는 자리다.
  // 채움은 원래보다 면 쪽으로만 옮겨 가므로 `signal-text`(그 채움 위 4.5로 풀린 값)의 대비는 오히려 는다.
  const seat = (values: SignalValues): SignalValues => ({ ...values, "signal-soft": base.placeSelected(values["signal-soft"]) });
  const separate = fit === fitOrThrow;
  type Own =
    | { readonly ok: true; readonly values: SignalValues; readonly boosted?: true }
    | { readonly ok: false; readonly reason: OwnSignalRejection };
  const own = (input: string, boost: boolean): Own => {
    const first = attempt(input);
    if (!first.ok) return { ok: false, reason: first.reason };
    if (!separate || apartFromNeutrals(base, first.values)) return first;
    const o = toOklch(normalizeHex(input));
    if (boost && o.C >= SIGNAL_BOOST_MIN_CHROMA) {
      for (let i = 1; o.C + i * SIGNAL_BOOST_STEP <= SIGNAL_BOOST_MAX + 1e-9; i++) {
        const boosted = attempt(withChroma(input, o.C + i * SIGNAL_BOOST_STEP));
        if (!boosted.ok) break;
        if (apartFromNeutrals(base, boosted.values)) return { ok: true, values: boosted.values, boosted: true };
      }
    }
    return { ok: false, reason: "near-neutral" };
  };

  let choiceRejection: SignalRejection | undefined;
  if (choice !== null) {
    const input = "preset" in choice ? SIGNAL_PRESETS[choice.preset][base.mode] : choice.custom;
    const result = attempt(input);
    if (result.ok) return { values: seat(result.values), outcome: { source: "choice" } };
    choiceRejection = result.reason;
  }
  const rejections: { choiceRejection?: SignalRejection; seedRejection?: OwnSignalRejection; defaultRejection?: OwnSignalRejection } = {
    ...(choiceRejection ? { choiceRejection } : {}),
  };
  if (base.seed.accent !== undefined) {
    const result = own(base.seed.accent, true);
    if (result.ok) {
      return { values: seat(result.values), outcome: { source: "seed", ...(result.boosted ? { boosted: true as const } : {}), ...rejections } };
    }
    rejections.seedRejection = result.reason;
  }
  const fallback = own(defaults(base.mode).color.signal, false);
  if (fallback.ok) return { values: seat(fallback.values), outcome: { source: "default", ...rejections } };
  rejections.defaultRejection = fallback.reason;
  for (const preset of SIGNAL_PRESET_IDS) {
    const result = own(SIGNAL_PRESETS[preset][base.mode], false);
    if (result.ok) return { values: seat(result.values), outcome: { source: "preset", preset, ...rejections } };
  }
  return { values: neutralSignal(base), outcome: { source: "neutral", ...rejections } };
}

/** 프리셋 하나를 이 씨앗의 모드에 올린 결과(갤러리·강조색이 읽는다). 거절은 이유와 한 줄을 든다. */
export type PresetOutcome =
  | { readonly ok: true; readonly signal: string; readonly onSignal: string }
  | { readonly ok: false; readonly reason: SignalRejection; readonly message: string };

export function presetOutcomes(seed: ThemeSeed): Readonly<Record<SignalPresetId, PresetOutcome>> {
  const base = deriveBase(seed);
  const tokens = solveTokens(base);
  const out = {} as Record<SignalPresetId, PresetOutcome>;
  for (const preset of SIGNAL_PRESET_IDS) {
    const result = resolveSignal(SIGNAL_PRESETS[preset][base.mode], "dawnsky", base.mode, tokens, {
      agentYields: true,
    });
    out[preset] = result.ok
      ? { ok: true, signal: result.values.signal, onSignal: result.values["on-signal"] }
      : { ok: false, reason: result.reason, message: result.message };
  }
  return out;
}

// ---- 에이전트와 마무리 --------------------------------------------------------------

const AGENT_ROTATION_STEP = 15;
const AGENT_ROTATION_MIN_CHROMA = 0.08;

function finish(base: Base, solved: SolvedSignal, fit: Fitter): DerivedMode {
  const { mode } = base;
  const signal = solved.values;
  const apart = (agent: string) =>
    [signal.signal, signal["signal-text"], base.danger.color].every(
      (other) => oklabDistance(agent, other) >= SIGNAL_MIN_DISTANCE
    );
  const agentSeed = base.seed.agent ?? defaults(mode).color.agent;
  const agentFit = (rawSeed: string) => fitWithSoft("agent", rawSeed, base.bandHosts, base.softFor, mode, fit);

  let agent = agentFit(agentSeed);
  let rotated = 0;
  if (fit === fitOrThrow && !apart(agent.color)) {
    // 작은 쪽으로 돌린다: 같은 크기면 +쪽이 먼저고, 한 바퀴의 반(180°)까지 본다. 멀리 돌릴수록 팔레트 밖의 색이 된다.
    const o = toOklch(normalizeHex(agentSeed));
    const chroma = Math.max(o.C, AGENT_ROTATION_MIN_CHROMA);
    search: for (let angle = AGENT_ROTATION_STEP; angle <= 180; angle += AGENT_ROTATION_STEP) {
      for (const direction of [1, -1]) {
        const candidate = agentFit(fromOklch({ L: o.L, C: chroma, h: (o.h + direction * angle + 360) % 360 }));
        if (apart(candidate.color)) {
          agent = candidate;
          rotated = angle;
          break search;
        }
      }
    }
    if (rotated === 0) throw new DeriveError("agent", "no hue keeps the agent apart from the signal and danger");
  }
  const agentNotes = noteOf("agent", agentSeed, agent.color, rotated > 0 ? { rotated } : {});

  const color: Record<ColorRole, string> = {
    surface: base.surface,
    "surface-muted": base.surfaceMuted,
    sheet: base.sheet,
    ink: base.ink,
    "ink-muted": base.inkMuted,
    icon: base.icon,
    line: base.line,
    "line-strong": base.lineStrong,
    primary: base.ink,
    "on-primary": base.onPrimary,
    signal: signal.signal,
    "on-signal": signal["on-signal"],
    "signal-text": signal["signal-text"],
    "signal-soft": signal["signal-soft"],
    agent: agent.color,
    "agent-soft": agent.soft,
    ok: base.ok.color,
    "ok-soft": base.ok.soft,
    warn: base.warn.color,
    "warn-soft": base.warn.soft,
    danger: base.danger.color,
    "danger-soft": base.danger.soft,
  };
  const source: ThemeModeSource = {
    canvas: [base.chrome, base.chrome, base.chrome],
    band: null,
    color,
    glass: glassOf(base.surface, mode),
    scrim: defaults(mode).scrim,
  };
  const tokens: ThemeModeTokens = { ...source, derived: deriveRoles(source, mode) };
  return {
    mode,
    tokens,
    pane: base.pane,
    notes: [...base.notes, ...agentNotes],
    signal: solved.outcome,
  };
}

/**
 * 첫 파티의 유리 값(`themes.ts`의 `rgba(r,g,b,.74)`·`.72`)에서 채널만 이 표면의 것으로 바꾼다. 알파와 표기는
 * 첫 파티 표가 정한다(여기서 색 함수를 글자로 다시 적지 않는다).
 */
function glassOf(surface: string, mode: Mode): string {
  const [r, g, b] = channelsOf(surface);
  return defaults(mode).glass.replace(/\(\s*\d+\s*,\s*\d+\s*,\s*\d+/, `(${r},${g},${b}`);
}

/** 씨앗 한 모드를 토큰 한 벌로. 같은 입력은 같은 출력이다. */
export function deriveThemeMode(seed: ThemeSeed, options: DeriveOptions = {}): DerivedMode {
  const fit = options.adjust === false ? keepAsIs : fitOrThrow;
  const base = deriveBase(seed, fit);
  return finish(base, solveSignal(base, options.signal ?? null, fit), fit);
}

// ---- CSS 변수 ---------------------------------------------------------------------

/** 파생 테마가 루트에 꽂는 변수 이름 전부(띠 제외). 생성 팔레트 CSS의 이름 집합 + `--pane`과 같다. */
export const DERIVED_VAR_NAMES: readonly string[] = [
  ...CANVAS_STOPS,
  ...COLOR_ROLES,
  ...DERIVED_ROLES,
  "glass",
  "scrim",
  "pane",
].map((name) => `--${name}`);

function valuesOf(derived: DerivedMode): Record<string, string> {
  const { tokens } = derived;
  const out: Record<string, string> = {};
  CANVAS_STOPS.forEach((stop, i) => (out[`--${stop}`] = tokens.canvas[i]));
  if (tokens.band) for (const role of BAND_ROLES) out[`--${role}`] = tokens.band[role];
  for (const role of COLOR_ROLES) out[`--${role}`] = tokens.color[role];
  for (const role of DERIVED_ROLES) out[`--${role}`] = tokens.derived[role];
  out["--glass"] = tokens.glass;
  out["--scrim"] = tokens.scrim;
  out["--pane"] = derived.pane;
  return out;
}

/**
 * 루트에 꽂을 `{ "--이름": 값 }`. 두 모드가 다 있으면 `light-dark(라이트, 다크)` 한 줄이라 OS 스킴이 바뀌어도
 * 다시 계산하지 않고, 한 모드뿐이면 그 색 하나다(`data-theme`를 그 모드로 못 박는다). 값은 색 하나 또는
 * `light-dark(색, 색)`뿐이고 `var()`·중첩이 없다(부트 캐시 문법, `themeCache.ts`).
 */
export function deriveCssVars(parts: { light?: DerivedMode; dark?: DerivedMode }): Record<string, string> {
  const light = parts.light ? valuesOf(parts.light) : undefined;
  const dark = parts.dark ? valuesOf(parts.dark) : undefined;
  const out: Record<string, string> = {};
  for (const name of Object.keys((light ?? dark)!)) {
    out[name] = light && dark ? `light-dark(${light[name]}, ${dark[name]})` : (light ?? dark)![name];
  }
  return out;
}

// ---- 미리보기 타일 ----------------------------------------------------------------

/** 미리보기 타일이 읽는 변수. 타일은 이 열셋만 꽂는다(요소마다 `ref.style.setProperty`). */
export const TILE_VAR_NAMES = [
  "--canvas-top",
  "--canvas-mid",
  "--canvas-bottom",
  "--pane",
  "--surface",
  "--ink",
  "--ink-muted",
  "--icon",
  "--line",
  "--line-strong",
  "--signal",
  "--on-signal",
  "--agent",
] as const;

/**
 * 한 테마·모드의 토큰에서 타일 변수 열셋을 낸다. 본문 판 색은 파생 테마는 `pane`, 첫 파티는 웹 셸의 규칙
 * (라이트는 `surface`, 다크는 `canvas-mid`)이다.
 */
export function tileVars(tokens: ThemeModeTokens, mode: Mode, pane?: string): Record<(typeof TILE_VAR_NAMES)[number], string> {
  const c = tokens.color;
  return {
    "--canvas-top": tokens.canvas[0],
    "--canvas-mid": tokens.canvas[1],
    "--canvas-bottom": tokens.canvas[2],
    "--pane": pane ?? (mode === "light" ? c.surface : tokens.canvas[1]),
    "--surface": c.surface,
    "--ink": c.ink,
    "--ink-muted": c["ink-muted"],
    "--icon": c.icon,
    "--line": c.line,
    "--line-strong": c["line-strong"],
    "--signal": c.signal,
    "--on-signal": c["on-signal"],
    "--agent": c.agent,
  };
}
