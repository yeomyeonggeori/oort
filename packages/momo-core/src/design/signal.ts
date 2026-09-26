// =============================================================================
// 신호 강조색 — 프리셋과 커스텀 보정 (ADR-0189 D3, 확정 항목 1·3).
//
// 커스텀은 `signal` 네 값(`signal`·`on-signal`·`signal-text`·`signal-soft`)만
// 바꾼다. `primary`(잉크)는 바꾸지 않는다.
//
// ## 보정 규칙
//
// 엔진은 입력 색의 OKLCH **명도만** 옮긴다. 색상각과 채도는 그대로 두고, 명도를
// 옮긴 값이 sRGB 밖이면 채도만 양보한다(`fromOklch`).
//
// 1. `signal`: 입력 명도에서 가장 가까운 명도 가운데 다음을 모두 채우는 값.
//    - 비텍스트 3:1: 표면, `surface-muted`, 시트, 바닥 정지점 전부, 띠(있으면).
//    - `on-signal` 후보(그 모드의 `ink`와 `on-primary`) 가운데 하나가 4.5:1.
//    명도에 대해 단조가 아니다(노을띠 라이트는 밝은 표면과 어두운 띠를 함께
//    넘어야 한다). 그래서 이분 탐색이 아니라 명도 전 구간을 훑고 입력에서 가장
//    가까운 값을 고른다.
// 2. `on-signal`: 두 후보 가운데 `signal` 위 대비가 큰 쪽.
// 3. `signal-soft`: 표면에서 `signal` 쪽으로 OKLab 14%(라이트)·20%(다크) 섞은
//    옅은 채움. 표면에서 두 자(1.05·0.02)를 못 넘으면 섞는 비율을 올린다.
// 4. `signal-text`: `signal`의 색상각·채도로 명도를 옮겨, 글자가 설 수 있는 면
//    (표면·`surface-muted`·시트·바닥 정지점)과 `signal-soft` 위에서 4.5:1을 넘는
//    `signal`에서 가장 가까운 값.
// 5. 거절: 입력이 `#RRGGBB`가 아니거나, 1·4를 채우는 명도가 없거나, 보정 뒤
//    `signal`이 `agent`나 `danger`와 OKLab 0.07 미만일 때.
//
// 명도는 [0.2, 0.97] 안에서만 고른다. 순백·순흑 입력이 그대로 나가지 않게 하는
// 자리다(디자인 시스템 §2.2 순백·순흑 금지).
//
// 입력이 이미 1·5를 채우면 `signal`은 입력 그대로이고 `adjusted`는 거짓이다.
// `signal-text`·`signal-soft`는 늘 계산값이다. 테마 기본 신호(`signal: null`)는
// 이 엔진을 거치지 않고 표의 값을 쓴다.
// =============================================================================

import { contrast, fromOklch, mixOklab, normalizeHex, oklabDistance, parseHex, toOklch } from "./color";
import {
  MODES,
  NON_TEXT_MIN_CONTRAST,
  SIGNAL_MIN_DISTANCE,
  TEXT_MIN_CONTRAST,
  THEME_IDS,
  THEMES,
  VESSEL_MIN_CONTRAST,
  VESSEL_MIN_DISTANCE,
  type Mode,
  type ThemeId,
  type ThemeModeTokens,
} from "./themes";

export const SIGNAL_ROLES = ["signal", "on-signal", "signal-text", "signal-soft"] as const;
export type SignalRole = (typeof SIGNAL_ROLES)[number];
export type SignalValues = Readonly<Record<SignalRole, string>>;

/** ADR-0174 액센트에서 옮긴 네 프리셋(표 §4). `dawn`은 옮기지 않는다. */
export const SIGNAL_PRESET_IDS = ["seongun", "hongyeom", "hyeseong", "gamram"] as const;
export type SignalPresetId = (typeof SIGNAL_PRESET_IDS)[number];

export const SIGNAL_PRESETS: Readonly<
  Record<SignalPresetId, { label: string; light: string; dark: string }>
> = {
  seongun: { label: "성운", light: "#9C447C", dark: "#F890BC" },
  hongyeom: { label: "홍염", light: "#66002C", dark: "#FE5A94" },
  hyeseong: { label: "혜성", light: "#8B005A", dark: "#FF4BCC" },
  gamram: { label: "감람", light: "#005400", dark: "#8CB858" },
};

export function isSignalPresetId(value: unknown): value is SignalPresetId {
  return typeof value === "string" && (SIGNAL_PRESET_IDS as readonly string[]).includes(value);
}

export type SignalRejection = "invalid-hex" | "unreachable" | "near-agent" | "near-danger";

/** 미리보기에 한 줄로 보이는 거절 이유(ADR-0189 D3). */
export const SIGNAL_REJECTION_COPY: Readonly<Record<SignalRejection, string>> = {
  "invalid-hex": "색은 #RRGGBB 형식으로 입력해 주세요.",
  unreachable: "이 색은 밝기를 조정해도 이 테마에서 읽기 쉬운 대비를 만들 수 없어요.",
  "near-agent": "에이전트 표시 색과 너무 비슷해서 쓸 수 없어요.",
  "near-danger": "오류 표시 색과 너무 비슷해서 쓸 수 없어요.",
};

/** 보정한 값을 알리는 미리보기 문구(ADR-0189 D3). */
export const SIGNAL_ADJUSTED_COPY = "대비를 위해 조정됨";

export type SignalResult =
  | { ok: true; values: SignalValues; adjusted: boolean }
  | { ok: false; reason: SignalRejection; message: string };

const L_MIN = 0.2;
const L_MAX = 0.97;
const L_STEP = 0.0025;
const SOFT_MIX: Readonly<Record<Mode, number>> = { light: 0.14, dark: 0.2 };

function reject(reason: SignalRejection): SignalResult {
  return { ok: false, reason, message: SIGNAL_REJECTION_COPY[reason] };
}

/** 명도 후보 전부를 입력 명도에서 가까운 순으로. 같은 거리면 어두운 쪽이 먼저다. */
function lightnessCandidates(from: number): number[] {
  const out: number[] = [];
  for (let L = L_MIN; L <= L_MAX + 1e-9; L += L_STEP) out.push(Math.round(L * 1e4) / 1e4);
  return out.sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b);
}

function nearestFeasible(seed: string, ok: (hex: string) => boolean): string | null {
  const { L, C, h } = toOklch(seed);
  for (const candidate of lightnessCandidates(L)) {
    const hex = fromOklch({ L: candidate, C, h });
    if (ok(hex)) return hex;
  }
  return null;
}

function withinLightness(hex: string): boolean {
  const { L } = toOklch(hex);
  return L >= L_MIN - 1e-9 && L <= L_MAX + 1e-9;
}

/**
 * 입력 hex를 한 테마 × 모드의 신호 네 값으로 보정하거나 거절한다.
 * `tokens`를 받는 것은 시험이 원천 밖 값으로 엔진을 잴 수 있게 하려는 것이다.
 */
export function resolveSignal(
  input: string,
  theme: ThemeId,
  mode: Mode,
  tokens: ThemeModeTokens = THEMES[theme][mode]
): SignalResult {
  if (!parseHex(input)) return reject("invalid-hex");
  const c = tokens.color;
  const nonTextHosts = [
    c.surface,
    c["surface-muted"],
    c.sheet,
    ...tokens.canvas,
    ...(tokens.band ? [tokens.band.band] : []),
  ];
  const textHosts = [c.surface, c["surface-muted"], c.sheet, ...tokens.canvas];
  const inks = [c.ink, c["on-primary"]];
  const onSignalFor = (fill: string) =>
    inks.reduce((best, ink) => (contrast(ink, fill) > contrast(best, fill) ? ink : best));
  const signalOk = (hex: string) =>
    nonTextHosts.every((h) => contrast(hex, h) >= NON_TEXT_MIN_CONTRAST) &&
    contrast(onSignalFor(hex), hex) >= TEXT_MIN_CONTRAST;

  const normalized = normalizeHex(input);
  const asGiven = withinLightness(normalized) && signalOk(normalized);
  const signal = asGiven ? normalized : nearestFeasible(normalized, signalOk);
  if (!signal) return reject("unreachable");

  if (oklabDistance(signal, c.danger) < SIGNAL_MIN_DISTANCE) return reject("near-danger");
  if (oklabDistance(signal, c.agent) < SIGNAL_MIN_DISTANCE) return reject("near-agent");

  let soft = mixOklab(c.surface, signal, SOFT_MIX[mode]);
  for (let t = SOFT_MIX[mode]; t < 0.6; t += 0.01) {
    soft = mixOklab(c.surface, signal, t);
    if (contrast(soft, c.surface) >= VESSEL_MIN_CONTRAST && oklabDistance(soft, c.surface) >= VESSEL_MIN_DISTANCE) break;
  }

  const textOk = (hex: string) =>
    [...textHosts, soft].every((h) => contrast(hex, h) >= TEXT_MIN_CONTRAST);
  const text = textOk(signal) ? signal : nearestFeasible(signal, textOk);
  if (!text) return reject("unreachable");

  return {
    ok: true,
    adjusted: !asGiven,
    values: { signal, "on-signal": onSignalFor(signal), "signal-text": text, "signal-soft": soft },
  };
}

/** 프리셋 하나를 한 테마 × 모드에 올린 결과. 프리셋 값은 모드마다 다르다. */
export function resolvePreset(preset: SignalPresetId, theme: ThemeId, mode: Mode): SignalResult {
  return resolveSignal(SIGNAL_PRESETS[preset][mode], theme, mode);
}

/** 네 프리셋 × 여섯 조합. 생성기와 표 §4가 읽는다. */
export function presetMatrix(): {
  preset: SignalPresetId;
  theme: ThemeId;
  mode: Mode;
  input: string;
  result: SignalResult;
}[] {
  const rows = [];
  for (const preset of SIGNAL_PRESET_IDS) {
    for (const theme of THEME_IDS) {
      for (const mode of MODES) {
        const input = SIGNAL_PRESETS[preset][mode];
        rows.push({ preset, theme, mode, input, result: resolveSignal(input, theme, mode) });
      }
    }
  }
  return rows;
}
