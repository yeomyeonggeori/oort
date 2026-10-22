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
//     (라이트는 더 어둡게, 다크는 더 밝게만). 상태색은 의미 색상각 창 밖이면 oort 기본값으로 바꾼다.
//     신호가 먼저 정해지고 에이전트 색이 색상각을 돌려 비킨다(OKLab ≥ 0.07). 주 버튼은 Buzz처럼
//     액센트가 아니라 잉크다(`primary = ink`).
//
// 순수 함수만 둔다. 같은 씨앗은 언제나 같은 토큰을 낸다(난수·시계 없음). 이 파일은 카탈로그를 모른다:
// 씨앗은 호출자가 넘기고, 카탈로그 위의 조회는 `deriveCatalog.ts`가 한다. 그래서 가져온 테마·사용자
// 테마(AP-5)도 같은 함수를 쓴다.
//
// 거절은 구문 오류뿐이다. 씨앗이 어떻게 생겼든 명도만으로 도달할 수 있는 역할(글자·선·상태색·에이전트)은
// 항상 도달하고, 도달할 수 없는 신호는 기본 신호 → 잉크(중립) 순으로 물러난다. 정말로 어떤 역할도 세울 수 없는
// 씨앗(바탕이 중간 휘도라 어느 방향으로도 4.5:1에 못 닿는 경우)은 `DeriveError`를 던진다.
// =============================================================================

import { contrast, fromOklch, luminance, mixOklab, normalizeHex, oklabDistance, parseHex, toOklch } from "./color";
import type { SignalChoice } from "./appearance";
import { SIGNAL_PRESETS, SIGNAL_PRESET_IDS, resolveSignal, type SignalPresetId, type SignalRejection } from "./signal";
import { seedMode, type ThemeSeed } from "./themeSeed";
import {
  BAND_ROLES,
  CANVAS_STOPS,
  COLOR_ROLES,
  DERIVED_ROLES,
  SIGNAL_MIN_DISTANCE,
  TEXT_MIN_CONTRAST,
  THEMES,
  NON_TEXT_MIN_CONTRAST,
  deriveRoles,
  type ColorRole,
  type Mode,
  type ThemeModeSource,
  type ThemeModeTokens,
} from "./themes";

/** 알고리즘이 바뀌면 올린다. 부트 캐시 키에 들어가서 낡은 캐시를 한꺼번에 무효로 한다. */
export const DERIVE_ENGINE_VERSION = "1";

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

export type SignalSource = "choice" | "seed" | "default" | "neutral";

export interface SignalOutcome {
  readonly source: SignalSource;
  /** 사람이 고른 신호(프리셋·직접 입력)가 이 테마·모드에서 거절된 이유. 받아들여졌거나 고른 적이 없으면 없다. */
  readonly choiceRejection?: SignalRejection;
  /** 테마의 신호 씨앗이 거절된 이유. */
  readonly seedRejection?: SignalRejection;
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
 */
function fitLightness(start: string, mode: Mode, ok: (hex: string) => boolean): string | null {
  const first = normalizeHex(start);
  if (ok(first)) return first;
  const { L, C, h } = toOklch(first);
  const dir = mode === "light" ? -1 : 1;
  for (let i = 1; ; i++) {
    const n = L + dir * i * L_STEP;
    if (n < L_FLOOR - 1e-9 || n > L_CEIL + 1e-9) return null;
    const candidate = fromOklch({ L: n, C, h });
    if (ok(candidate)) return candidate;
  }
}

/** 역할 하나를 맞추는 함수. 기본은 명도 맞춤이고, 분석용(`adjust: false`)은 씨앗을 그대로 쓴다. */
type Fitter = (role: string, start: string, mode: Mode, ok: (hex: string) => boolean) => string;

const fitOrThrow: Fitter = (role, start, mode, ok) => {
  const fitted = fitLightness(start, mode, ok);
  if (fitted === null) throw new DeriveError(role, `no lightness reaches the contrast rule for ${role} (${start})`);
  return fitted;
};

const keepAsIs: Fitter = (_role, start) => normalizeHex(start);

const softOf = (surface: string, color: string, mode: Mode): string =>
  mixOklab(surface, color, mode === "light" ? 0.12 : 0.18);

/**
 * 글자로 서는 색과 그 색의 옅은 채움. 후보마다 **자기 채움을 새로 만들어** 두 조건(모든 면 위 4.5, 자기
 * 채움 위 4.5)을 한꺼번에 본다. 색을 옮기면 채움도 따라 변하므로 한 번 맞춘 채움에 대고 다시 맞출 필요가 없다.
 */
function fitWithSoft(
  role: string,
  rawSeed: string,
  hosts: readonly string[],
  surface: string,
  mode: Mode,
  fit: Fitter
): Status & { readonly start: string } {
  const start = normalizeHex(rawSeed);
  const ok = (hex: string) =>
    holds(hex, hosts, TEXT_MIN_CONTRAST) && contrast(hex, softOf(surface, hex, mode)) >= TEXT_MIN_CONTRAST;
  const color = fit(role, start, mode, ok);
  return { color, soft: softOf(surface, color, mode), start };
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
  const notes: DeriveNote[] = [];

  const textOk = (min: number) => (hex: string) => holds(hex, hosts, min);
  const ink = fit("ink", seed.fg, mode, textOk(TEXT_MIN_CONTRAST));
  notes.push(...noteOf("ink", seed.fg, ink));
  const commentSeed = seed.comment ?? mixHex(seed.fg, pane, 0.4);
  const inkMuted = fit("ink-muted", commentSeed, mode, textOk(TEXT_MIN_CONTRAST));
  notes.push(...noteOf("ink-muted", commentSeed, inkMuted));
  const iconSeed = mixHex(inkMuted, pane, 0.25);
  const icon = fit("icon", iconSeed, mode, textOk(NON_TEXT_MIN_CONTRAST));
  notes.push(...noteOf("icon", iconSeed, icon));
  const lineStrongSeed = mixHex(seed.fg, pane, 0.5);
  const lineStrong = fit("line-strong", lineStrongSeed, mode, textOk(NON_TEXT_MIN_CONTRAST));
  notes.push(...noteOf("line-strong", lineStrongSeed, lineStrong));
  const line = mixHex(pane, seed.fg, mode === "dark" ? 0.15 : 0.12);
  const onPrimary = contrast(surface, ink) >= contrast(pane, ink) ? surface : pane;

  const statusFit = (role: string, rawSeed: string): Status => {
    const fitted = fitWithSoft(role, rawSeed, hosts, surface, mode, fit);
    notes.push(...noteOf(role, fitted.start, fitted.color));
    return { color: fitted.color, soft: fitted.soft };
  };

  const fallback = defaults(mode).color;
  const danger = statusFit(
    "danger",
    semanticSeed([seed.deleted, seed.ansiRed], HUE_WINDOWS.danger, fallback.danger).hex
  );
  const ok = statusFit("ok", semanticSeed([seed.added, seed.ansiGreen], HUE_WINDOWS.ok, fallback.ok).hex);
  const warn = statusFit(
    "warn",
    semanticSeed([seed.modified, seed.ansiYellow], HUE_WINDOWS.warn, fallback.warn).hex
  );

  const base: Base = {
    mode,
    seed,
    chrome,
    pane,
    surface,
    surfaceMuted,
    sheet,
    hosts,
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
 * `resolveSignal`은 파생 칸을 읽지 않는다). **본문 판을 바닥 정지점 한 칸에 실어** 신호가 판 위에서도 3:1,
 * 글자 신호가 4.5:1을 지키게 한다(다크에서 판은 표면과 바닥 사이의 세 번째 면이다).
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
    canvas: [base.chrome, base.pane, base.chrome],
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

function solveSignal(base: Base, choice: SignalChoice): SolvedSignal {
  const tokens = solveTokens(base);
  const attempt = (input: string) => resolveSignal(input, "dawnsky", base.mode, tokens, { agentYields: true });
  let choiceRejection: SignalRejection | undefined;
  let seedRejection: SignalRejection | undefined;

  if (choice !== null) {
    const input = "preset" in choice ? SIGNAL_PRESETS[choice.preset][base.mode] : choice.custom;
    const result = attempt(input);
    if (result.ok) return { values: result.values, outcome: { source: "choice" } };
    choiceRejection = result.reason;
  }
  if (base.seed.accent !== undefined) {
    const result = attempt(base.seed.accent);
    if (result.ok) {
      return { values: result.values, outcome: { source: "seed", ...(choiceRejection ? { choiceRejection } : {}) } };
    }
    seedRejection = result.reason;
  }
  const fallback = attempt(defaults(base.mode).color.signal);
  const rejections = {
    ...(choiceRejection ? { choiceRejection } : {}),
    ...(seedRejection ? { seedRejection } : {}),
  };
  if (fallback.ok) return { values: fallback.values, outcome: { source: "default", ...rejections } };
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
  const agentFit = (rawSeed: string) => fitWithSoft("agent", rawSeed, base.hosts, base.surface, mode, fit);

  let agent = agentFit(agentSeed);
  let rotated = 0;
  while (fit === fitOrThrow && !apart(agent.color)) {
    rotated += AGENT_ROTATION_STEP;
    if (rotated >= 360) throw new DeriveError("agent", "no hue keeps the agent apart from the signal and danger");
    const o = toOklch(normalizeHex(agentSeed));
    agent = agentFit(fromOklch({ L: o.L, C: Math.max(o.C, AGENT_ROTATION_MIN_CHROMA), h: (o.h + rotated) % 360 }));
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
  return finish(base, solveSignal(base, options.signal ?? null), fit);
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
