// =============================================================================
// 데스크탑 유리 배경의 산수 — ADR-0189 증보 1 D4 · 증보 3 D6 (AP-3 #4190).
//
// 유리는 창 뒤 데스크탑이 사이드바·창 가장자리에 블러로 비치는 면이다. 그 면은 **바닥색 한 겹**
// (바닥 그라데이션의 세 정지점, 띠가 있으면 그 위에 띠 한 겹)을 불투명도 α로 칠한 반투명 색조이고,
// 그 뒤의 데스크탑은 우리가 못 보는 그림이다. 그래서 `scrim.ts`와 같은 문제이고 같은 산수(최악 합성:
// 순흑·순백 그림 위 두 끝)로 보장한다. 이 파일은 그 산수를 유리가 칠해지는 모양에 맞춘다.
//
// ## 하한 = 슬라이더의 아래 끝
//
// 슬라이더 범위는 [하한, 95%]다(`GLASS_OPACITY_MAX`). 하한은 테마·모드마다 **사이드바·타이틀바의
// 주 글자(`ink`, 띠가 있으면 `on-band`)가 최악 합성 두 끝에서 모두 7:1을 지키는, 그 값 이상의 모든
// 불투명도에서 지키는 최소 불투명도**(0.01 올림)다. 하한이 95%를 넘으면 그 테마·모드에서는 유리를
// 쓸 수 없다(`usable`). 95는 쓸 수 있고 96은 쓸 수 없다. 이 판정은 `glassRange` 하나이고 배경화면
// (AP-4)도 같은 불가 판정을 쓴다.
//
// ### 증보 3 D6 표(`scrimFloor`, 바닥의 가운데 정지점 한 색)와 같은 곳, 다른 곳
//
// 평면 테마(흑연, 카탈로그)는 세 정지점이 같고 띠가 없어서 표와 **같은 값**이다(시험이 대조한다).
// 다른 곳은 둘이고 이유가 같다. 하한은 **칠해지는 면**에서 잰다(실측은 `glass.test.ts`가 다시 잰다).
//   1. 새벽하늘은 바닥이 세 정지점이 다른 그라데이션이고 유리 색조도 그 세 정지점을 그대로 칠한다.
//      표의 가운데 값에서는 잉크가 위·아래 정지점에서 7:1에 못 미친다: 다크 0.76의 위 정지점(`#231d1b`)
//      위 순백 그림 6.71, 라이트 0.69의 아래 정지점(`#e2e9f3`) 위 순흑 그림 6.89. `scrimFloor`의 머리
//      주석이 이미 「그라데이션 자체를 색조로 쓰는 면은 정지점마다 구해 큰 쪽을 쓴다」고 적었고, 이
//      파일이 그 말을 한다(라이트 0.70, 다크 0.78).
//   2. 띠가 있는 테마(노을띠, 그리고 AP-5가 열 사이드바 색)는 사이드바 글자가 바닥이 아니라 **띠
//      위**에 선다. 띠 층은 바닥 층 위에 겹쳐 칠해지므로 호스트는 「띠 α 위에 바닥 α 위에 그림」이고,
//      글자는 `on-band`다. 노을띠 라이트는 어두운 남색 띠 위의 밝은 글자라 최악이 순백 그림이고, 표의
//      0.69에서는 `on-band`가 5.14:1이다(0.79에서 7.10:1).
//
// ## 하한 위에서 글자·표식은 명도만 보정한다
//
// `ink`·`on-band`는 불투명도 자체가 7:1을 지키므로 건드리지 않는다. 그 아래 위계(보조 글자·아이콘·
// 신호·에이전트·상태 색)는 같은 호스트 위에서 4.5(글자)·3(표식)을 넘도록 `fitForeground`로 명도만
// 옮긴다(여유 `FIT_MARGIN`). 폰 `paletteFrom(onImage)`와 같은 역할 목록이고 같은 방식이다. 슬라이더
// 값이 바뀌면 보정도 다시 한다.
//
// 순수 함수만 둔다(UI·플랫폼 API·런타임 의존 없음 — `scripts/purity.mjs`).
// =============================================================================

import type { SignalChoice } from "./appearance";
import { contrast, fromOklch, luminance, normalizeHex, toOklch } from "./color";
import {
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  blend,
  fitForeground,
  holdsOnBoth,
  worstCaseBackdrops,
} from "./scrim";
import { resolvePreset, resolveSignal, type SignalValues } from "./signal";
import { MODES, THEMES, type BandRole, type ColorRole, type Mode, type ThemeId } from "./themes";

/** 슬라이더 최대(퍼센트). 하한이 이 값을 넘는 테마·모드는 유리를 쓸 수 없다. */
export const GLASS_OPACITY_MAX = 95;

/** 키보드 한 걸음(화살표)과 큰 걸음(PageUp·PageDown), 퍼센트. */
export const GLASS_STEP = 1;
export const GLASS_PAGE_STEP = 10;

/**
 * 저장된 값이 없을 때 하한 위로 얹는 퍼센트포인트(청사진 §5.4-b 「기본값 = 하한 + 10%p 정도」, 캡처로 확인).
 * 하한에서는 위계가 가장 많이 눌린다: 글자·표식을 순흑·순백 그림 위에서 4.5·3:1로 보정하는데 실제 맥 `Sidebar`
 * 재질은 그 두 끝을 만들지 못해서(라이트 (198,198,197)~(222,222,222), 다크 (34,34,35)~(78,78,78), 실측)
 * 보조 글자가 필요한 것의 두 배쯤 진해진다. 새벽하늘 라이트의 잉크 대 보조 대비가 끔 2.69, 하한 70% 1.46,
 * 80% 1.90이고, 새벽하늘 다크는 끔 2.13, 하한 78% 1.48, 88% 2.13(끔과 같고 위험 > 경고 채도 순서도 돌아온다)이다.
 * 하한에서 열면 켠 직후 사이드바의 구획 라벨·아이콘이 항목 글자에 붙는다(design-review H1). 하한 아래로 내려
 * 더 비치게 하는 길은 하한 산수(ADR 증보 3 D6 결정 4 (c))를 다시 정할 때만 열린다.
 */
export const GLASS_DEFAULT_OVER_FLOOR = 10;

/** 하한 위에서 명도를 보정하는 글자 역할(4.5:1 + 여유). 폰 `onImage` 글자 목록과 같다. */
export const GLASS_TEXT_ROLES = [
  "ink-muted",
  "signal-text",
  "agent",
  "ok",
  "warn",
  "danger",
] as const satisfies readonly ColorRole[];
/** 하한 위에서 명도를 보정하는 표식 역할(3:1 + 여유). */
export const GLASS_NON_TEXT_ROLES = ["icon", "signal"] as const satisfies readonly ColorRole[];

export type GlassRole = (typeof GLASS_TEXT_ROLES)[number] | (typeof GLASS_NON_TEXT_ROLES)[number];

/** 루트에 꽂는 역할 변수 전부: 보정된 아홉 + `on-signal`(보정된 `signal` 위에서 다시 고른다). */
export const GLASS_VAR_ROLES = [...GLASS_TEXT_ROLES, ...GLASS_NON_TEXT_ROLES, "on-signal"] as const;
export type GlassVarRole = (typeof GLASS_VAR_ROLES)[number];

/** 이 파일이 읽는 색 역할: 보정 대상 + 잉크 + `on-signal` 후보. `ThemeModeSource.color`가 그대로 만족한다. */
export type GlassSourceRole = GlassRole | "ink" | "on-primary" | "on-signal";

/** 유리 색조와 그 위 글자를 재는 데 필요한 한 테마 × 모드의 값. `ThemeModeSource`가 구조적으로 만족한다. */
export interface GlassSource {
  /** 위 → 가운데 → 아래. 평면 테마는 세 값이 같다. */
  canvas: readonly [string, string, string];
  /** 띠가 없으면 `null`. */
  band: Readonly<Record<BandRole, string>> | null;
  color: Readonly<Record<GlassSourceRole, string>>;
}

/** 테마가 가진 모드별 값. 단일 모드 테마는 한쪽만 든다. */
export type GlassSources = Partial<Record<Mode, GlassSource>>;

// ---- 첫 파티의 값 ------------------------------------------------------------

/**
 * 고른 강조색(신호)이 한 테마 × 모드에서 실제로 그리는 네 값. 프리셋·직접 고른 색이 보정되면 그 값이고,
 * 거절되면 **테마 기본 신호**다(거절돼도 사람의 선택은 지우지 않고 그 자리만 기본으로 그린다, 증보 1 D3).
 * 사이드바의 신호색을 이 값으로 보정해야 강조색이 유리 위에서 사라지지 않는다.
 */
function effectiveSignal(theme: ThemeId, mode: Mode, choice: SignalChoice): SignalValues | null {
  if (choice === null) return null;
  const result =
    "preset" in choice
      ? resolvePreset(choice.preset, theme, mode)
      : resolveSignal(choice.custom, theme, mode);
  return result.ok ? result.values : null;
}

/** 첫 파티 한 테마의 두 모드. 고른 강조색이 있으면 그 신호가 들어간 값이다. */
export function firstPartyGlassSources(theme: ThemeId, signal: SignalChoice = null): GlassSources {
  const out: GlassSources = {};
  for (const mode of MODES) {
    const tokens = THEMES[theme][mode];
    const values = effectiveSignal(theme, mode, signal);
    out[mode] = values
      ? { canvas: tokens.canvas, band: tokens.band, color: { ...tokens.color, ...values } }
      : tokens;
  }
  return out;
}

// ---- 합성 -------------------------------------------------------------------

/** 띠 한 겹 위에 바닥 한 겹이 있는 자리의 최악 합성 두 끝(띠 α 위에 바닥 α 위에 순흑·순백 그림). */
function bandHosts(band: string, canvas: string, alpha: number): readonly [string, string] {
  const [overBlack, overWhite] = worstCaseBackdrops(canvas, alpha);
  return [blend(band, overBlack, alpha), blend(band, overWhite, alpha)];
}

/**
 * `holds(α)`가 그 값 **이상의 모든** 0.01 단위 α에서 참인 가장 작은 α. 어느 α에서도 못 지키면(1.00
 * 에서도 거짓) 1을 돌려준다: 없는 답을 만들지 않고 가장 두꺼운 값으로 닫는다. 위에서부터 내려오며
 * 처음 거짓인 자리를 찾으므로 합성이 α에 단조가 아닌 입력에서도 「하한 위는 모두 지킨다」가 거짓이
 * 되지 않는다.
 */
function floorOf(holds: (alpha: number) => boolean): number {
  for (let step = 100; step >= 0; step -= 1) {
    if (!holds(step / 100)) return Math.min(1, (step + 1) / 100);
  }
  return 0;
}

// ---- 하한·범위 ---------------------------------------------------------------

/**
 * 한 테마 × 모드의 하한(0~1, 0.01 단위): 바닥의 세 정지점마다 `ink`가, 띠가 있으면 띠 위에서 `on-band`가
 * 최악 합성 두 끝에서 7:1을 지키는 최소 불투명도 가운데 가장 큰 값이다.
 */
export function glassFloor(source: GlassSource): number {
  const ink = source.color.ink;
  const canvasFloor = Math.max(
    ...source.canvas.map((stop) =>
      floorOf((alpha) => holdsOnBoth(ink, worstCaseBackdrops(stop, alpha), INK_MIN_ON_BACKDROP))
    )
  );
  const band = source.band;
  if (!band) return canvasFloor;
  const bandFloor = Math.max(
    ...source.canvas.map((stop) =>
      floorOf((alpha) => holdsOnBoth(band["on-band"], bandHosts(band.band, stop, alpha), INK_MIN_ON_BACKDROP))
    )
  );
  return Math.max(canvasFloor, bandFloor);
}

export interface GlassRange {
  /** 하한이 슬라이더 최대 이하인가. 아니면 이 테마·모드에서는 유리를 쓸 수 없다. */
  usable: boolean;
  /** 슬라이더 아래 끝(정수 퍼센트). `usable`이 아니면 `max`보다 크다. */
  min: number;
  /** 슬라이더 위 끝(정수 퍼센트). */
  max: number;
  /** 저장된 값이 없을 때의 값(정수 퍼센트). */
  defaultPercent: number;
}

export function glassRange(source: GlassSource): GlassRange {
  const min = Math.round(glassFloor(source) * 100);
  return {
    usable: min <= GLASS_OPACITY_MAX,
    min,
    max: GLASS_OPACITY_MAX,
    // 저장된 값이 없을 때의 값은 하한 + 10%p다(`GLASS_DEFAULT_OVER_FLOOR`). 하한에서 열면 글자·표식 위계가 가장
    // 눌린다. 사람은 슬라이더를 왼쪽으로 하한까지 옮겨 더 비치게 하거나 오른쪽으로 옮겨 더 진하게 한다.
    defaultPercent: Math.min(GLASS_OPACITY_MAX, min + GLASS_DEFAULT_OVER_FLOOR),
  };
}

/**
 * 저장된 값(없거나 숫자가 아닐 수 있다)을 [하한, 최대]에 맞춘 **유효** 불투명도(정수 퍼센트).
 * 하한 아래로 저장돼 있어도(다른 테마·모드에서 고른 값) 저장값을 지우지 않고 그리는 값만 올린다.
 */
export function glassOpacity(range: GlassRange, stored: number | undefined): number {
  const raw =
    typeof stored === "number" && Number.isFinite(stored) ? Math.round(stored) : range.defaultPercent;
  return Math.min(range.max, Math.max(range.min, raw));
}

/** 슬라이더 한 걸음. 범위 밖으로 나가지 않는다. */
export function stepGlassOpacity(range: GlassRange, current: number, delta: number): number {
  return glassOpacity(range, current + delta);
}

// ---- 보정된 글자·표식 ----------------------------------------------------------

/**
 * 글자·표식이 호스트보다 밝으면 더 밝게(`"dark"` 방향), 어두우면 더 어둡게(`"light"` 방향) 보정한다.
 * `fitForeground`의 모드 인자는 보정 방향이다: 라이트는 어둡게, 다크는 밝게.
 */
function fitDirection(fg: string, host: string): Mode {
  return luminance(fg) > luminance(host) ? "dark" : "light";
}

/** 한 면 위에서 쓸 글자·표식 색 열 개. 키는 `GlassVarRole`이고 값은 소문자 `#rrggbb`다. */
export type GlassPalette = Readonly<Record<GlassVarRole, string>>;

export interface GlassChrome {
  /** 바닥(그라데이션 정지점) 위에 직접 서는 글자·표식: 띠 없는 사이드바, 접힌 타이틀바. */
  canvas: GlassPalette;
  /**
   * 띠 위에 서는 글자·표식: 띠가 있는 테마의 사이드바·펼친 타이틀바·설정 목록. tokens.css 띠 규칙이 역할을
   * 묶는 대로다(`ink-muted`·`icon`·`warn`은 `on-band-muted`, `agent`·`danger`는 `on-band`, `signal`은 띠 위
   * 3:1). `ok`·`signal-text`는 띠 위에 서지 않는 역할이라 바닥 값 그대로다. 띠가 없으면 `canvas`와 같다.
   */
  band: GlassPalette;
}

/** `signal` 채움 위에 올릴 수 있는 글자 후보: 원래 `on-signal`이 먼저고, 그다음 `on-primary`·`ink`다. */
function onSignalCandidates(source: GlassSource): readonly string[] {
  return [source.color["on-signal"], source.color["on-primary"], source.color.ink];
}

/** `signal` 채움 위 글자. 원래 `on-signal`이 4.5를 넘으면 그대로이고, 아니면 후보 가운데 대비가 가장 큰 쪽이다. */
function onSignalFor(source: GlassSource, fill: string): string {
  const [keep, ...others] = onSignalCandidates(source);
  if (contrast(keep, fill) >= TEXT_MIN_ON_BACKDROP) return keep;
  return others.reduce((best, ink) => (contrast(ink, fill) > contrast(best, fill) ? ink : best));
}

// `scrim.ts` `fitForeground`와 같은 명도 격자(채움은 호스트 대비와 글자 대비를 함께 지켜야 해서 따로 돈다).
const L_FLOOR = 0.12;
const L_CEIL = 0.97;
const L_STEP = 0.0025;

/**
 * `signal` 채움을 명도만 옮겨 (1) 호스트 두 끝 위 `min`:1을 넘고 (2) 그 위에 올릴 글자 후보 가운데 하나가
 * 4.5:1을 넘는 가장 가까운 값으로 맞춘다. 호스트만 보는 `fitForeground`로는 부족하다: 노을띠 라이트처럼
 * 어두운 `on-signal`을 쓰는 테마에서 채움을 어둡게 옮기면 호스트 대비는 서도 채움 위 글자가 4.5를 잃는다.
 * `resolveSignal`이 채움을 고르는 두 조건과 같다. 끝까지 못 찾으면 끝값을 돌려준다(시험이 모든 조합에서 잡는다).
 */
function fitFill(
  fill: string,
  hosts: readonly string[],
  min: number,
  inks: readonly string[],
  direction: Mode
): string {
  const ok = (hex: string) =>
    holdsOnBoth(hex, hosts, min) && inks.some((ink) => contrast(ink, hex) >= TEXT_MIN_ON_BACKDROP);
  const start = normalizeHex(fill);
  if (ok(start)) return start;
  const { L, C, h } = toOklch(start);
  const sign = direction === "light" ? -1 : 1;
  let candidate = start;
  for (let next = L + sign * L_STEP; next >= L_FLOOR && next <= L_CEIL; next += sign * L_STEP) {
    candidate = fromOklch({ L: next, C, h });
    if (ok(candidate)) return candidate;
  }
  return candidate;
}

/**
 * 채도의 자(README §3.1 규칙 1, `clients/web/src/design/tokens.contrast.test.ts`의 「ranks danger louder than warn,
 * and warn louder than muted」와 같은 값): 위험 ÷ 경고 ≥ 1.15, 경고 ÷ 보조 글자 ≥ 2. 비로 잰다: 맨 `>`로는 동률이
 * 통과한다. 16진수 반올림이 자 밑으로 내리지 않도록 목표에는 여유(`ORDER_CUSHION`)를 얹는다.
 */
const DANGER_OVER_WARN_RATIO = 1.15;
const WARN_OVER_MUTED_RATIO = 2;
const ORDER_CUSHION = 1.02;

/**
 * 채도 순서 `danger > warn > ink-muted`(design-system README §2.2·§3.1 규칙 1: 위험 순서의 자는 대비가 아니라
 * 채도다)를 보정 뒤에도 정본의 자 그대로 지킨다. 다크에서 위험(붉은색)을 밝히면 sRGB 경계 때문에 채도가 먼저 깎여
 * (0.182 → 0.088) 경고(호박색, 0.141)와 비슷하거나 덜 진해지는 불투명도 구간이 생긴다(자를 못 채우는 칸: 새벽하늘 다크
 * 78~90%, 흑연 다크 73~82%, 노을띠 다크 78~88%). 위험은 명도·색상각이 보정으로 정해져 더 진하게 만들 수 없다(그 명도의 붉은색은
 * 경계에서 이미 가장 진하다). 그래서 **경고의 채도만** 같은 색상각·명도에서 위험 ÷ 1.15 밑으로 덜어 내고 대비를
 * 다시 맞춘다. 순서가 이미 자를 넘는 칸(라이트 전 구간, 다크 상단)의 경고는 손대지 않는다.
 *
 * ADR-0189 증보 2 D3의 「채도는 그대로」(보정은 명도만 옮긴다)는 **보정 대상 색이 자기 채도를 지킨다**는 약속인데,
 * 지금 경고는 위험이 깎인 만큼의 상대 순서를 지키기 위해서만 내려간다. 이 조정이 정본의 의도(위계)를 따르고
 * 글자 자체의 읽힘은 같은 대비 보장 아래에 남는다(`glass.test.ts` 「채도 순서」). 판단은 PR 본문에 적었다.
 */
function keepWarnBelowDanger(
  roles: Record<GlassRole, string>,
  hosts: readonly string[],
  min: number,
  mode: Mode
): void {
  const ceiling = toOklch(roles.danger).C / (DANGER_OVER_WARN_RATIO * ORDER_CUSHION);
  const warn = toOklch(roles.warn);
  if (warn.C <= ceiling) return;
  // 경고는 보조 글자보다 계속 두 배 넘게 진해야 한다. 위험이 너무 옅어 두 자가 겹치면 보조 글자 쪽 자를 지킨다.
  const C = Math.max(ceiling, toOklch(roles["ink-muted"]).C * WARN_OVER_MUTED_RATIO * ORDER_CUSHION);
  roles.warn = fitForeground(fromOklch({ L: warn.L, C, h: warn.h }), hosts, min, mode);
}

/** 소문자 `#rrggbb`로 맞춘다: 테마 표의 대문자 값이 그대로 나가면 같은 색이 두 철자로 흩어진다(CSS 값 문법도 한 철자만 받는다). */
function lowercased(palette: Record<GlassVarRole, string>): GlassPalette {
  const out = {} as Record<GlassVarRole, string>;
  for (const role of GLASS_VAR_ROLES) out[role] = normalizeHex(palette[role]);
  return out;
}

/**
 * 불투명도 `percent`(정수 퍼센트)에서 사이드바·타이틀바·설정 목록 위의 글자·표식 색. 두 면 위의 값을 함께
 * 낸다(`GlassChrome`): 접힌 사이드바의 타이틀바처럼 같은 테마에서도 바닥 위와 띠 위에 서는 글자가 있다.
 */
export function glassChrome(source: GlassSource, mode: Mode, percent: number): GlassChrome {
  const alpha = percent / 100;
  const hosts = source.canvas.flatMap((stop) => worstCaseBackdrops(stop, alpha));
  const text = TEXT_MIN_ON_BACKDROP + FIT_MARGIN;
  const mark = NON_TEXT_MIN_ON_BACKDROP + FIT_MARGIN;
  const onCanvas = {} as Record<GlassRole, string>;
  for (const role of GLASS_TEXT_ROLES) onCanvas[role] = fitForeground(source.color[role], hosts, text, mode);
  for (const role of GLASS_NON_TEXT_ROLES) onCanvas[role] = fitForeground(source.color[role], hosts, mark, mode);
  onCanvas.signal = fitFill(source.color.signal, hosts, mark, onSignalCandidates(source), mode);
  keepWarnBelowDanger(onCanvas, hosts, text, mode);
  const canvas = lowercased({ ...onCanvas, "on-signal": onSignalFor(source, onCanvas.signal) });

  const bandSource = source.band;
  if (!bandSource) return { canvas, band: canvas };
  const bandHostList = source.canvas.flatMap((stop) => bandHosts(bandSource.band, stop, alpha));
  const onBand = bandSource["on-band"];
  const muted = fitForeground(
    bandSource["on-band-muted"],
    bandHostList,
    text,
    fitDirection(bandSource["on-band-muted"], bandSource.band)
  );
  const signal = fitFill(
    source.color.signal,
    bandHostList,
    mark,
    onSignalCandidates(source),
    fitDirection(source.color.signal, bandSource.band)
  );
  const onBandRoles: Record<GlassRole, string> = {
    ...onCanvas,
    "ink-muted": muted,
    icon: muted,
    warn: muted,
    agent: onBand,
    danger: onBand,
    signal,
  };
  return { canvas, band: lowercased({ ...onBandRoles, "on-signal": onSignalFor(source, signal) }) };
}

// ---- CSS 변수 -----------------------------------------------------------------

/**
 * 웹이 루트에 꽂는 변수 이름(`design/appearance/glass.css`가 읽는다). 색조 불투명도는 모드마다 따로
 * 적고 CSS가 스킴에 맞는 쪽을 고른다(`light-dark()`는 색만 받는다). 글자·표식은 `light-dark(라이트, 다크)`
 * 한 값이다: OS가 스킴을 바꾸는 순간에 변수를 다시 쓰는 사건에 기대지 않는다. 역할 변수는 두 가족이다:
 * `--glass-<역할>`은 바닥 위, `--glass-band-<역할>`은 띠 위(띠가 없는 테마에서는 같은 값).
 */
export const GLASS_VARS = {
  tintLight: "--glass-tint-light",
  tintDark: "--glass-tint-dark",
  role: (role: GlassVarRole): string => `--glass-${role}`,
  bandRole: (role: GlassVarRole): string => `--glass-band-${role}`,
} as const;

const lightDark = (light: string, dark: string): string => `light-dark(${light}, ${dark})`;

/**
 * 한 테마의 유리 변수 한 벌. 모드마다 하한이 다르므로 모드별 유효 불투명도(`glassOpacity`)와 보정 색을
 * 각각 구해 둘을 한 값으로 묶는다. 단일 모드 테마는 있는 모드의 값을 두 칸에 쓴다.
 *
 * 한 모드라도 쓸 수 없으면(`usable` 거짓) 그 모드 칸은 최대(95)와 그 불투명도의 보정 색으로 닫는다.
 * 소비자는 그 모드에서 유리를 켜지 않으므로 값은 닿지 않고, 스킴이 바뀌는 사이의 한두 프레임을
 * 위해서만 있다.
 */
export function glassVariables(sources: GlassSources, stored: number | undefined): Record<string, string> {
  const available = MODES.filter((mode) => sources[mode] !== undefined);
  if (available.length === 0) return {};
  const resolved = MODES.map((mode) => {
    const from = sources[mode] ? mode : available[0];
    const source = sources[from] as GlassSource;
    const range = glassRange(source);
    const percent = range.usable ? glassOpacity(range, stored) : range.max;
    return { percent, chrome: glassChrome(source, from, percent) };
  });
  const [light, dark] = resolved;
  const vars: Record<string, string> = {
    [GLASS_VARS.tintLight]: `${light.percent}%`,
    [GLASS_VARS.tintDark]: `${dark.percent}%`,
  };
  for (const role of GLASS_VAR_ROLES) {
    vars[GLASS_VARS.role(role)] = lightDark(light.chrome.canvas[role], dark.chrome.canvas[role]);
    vars[GLASS_VARS.bandRole(role)] = lightDark(light.chrome.band[role], dark.chrome.band[role]);
  }
  return vars;
}

// ---- 판정: 지금 유리를 그려도 되는가 -----------------------------------------------

/** 유리를 그리지 않는 이유(행의 문장을 고른다). */
export type GlassBlock = "unsupported" | "unusable" | "wallpaper" | "failed" | "reduced-transparency";

export interface GlassInput {
  /** 사람이 켜 둔 값(저장된 `glass.on`). */
  on: boolean;
  /** macOS 데스크탑 앱인가(웹 브라우저·다른 OS·창 효과 API 없음이면 거짓). */
  supported: boolean;
  /** 지금 모드의 하한(정수 퍼센트, `glassRange().min`). 테마의 색을 아직 읽지 못했으면 `null`. */
  floorPercent: number | null;
  /** 배경화면이 켜져 있는가(`appearance.wallpaper`). 배경화면과 유리는 같은 바닥 층을 쓴다(결정 9). */
  wallpaper: boolean;
  /** 이번 실행에서 네이티브 켜기가 실패했는가. */
  failed: boolean;
  /** 시스템 「투명도 줄이기」·「대비 증가」가 켜져 있는가. */
  reducedTransparency: boolean;
}

export interface GlassDecision {
  /** 문장으로 말할 이유. 말할 것이 없으면 `null`. */
  reason: GlassBlock | null;
  /** 스위치를 잠글지. 켤 수 없는 이유(`unsupported`·`unusable`·`wallpaper`)일 때만 잠근다. */
  toggleDisabled: boolean;
  /** 스위치가 보여 줄 값. */
  checked: boolean;
  /** 창에 네이티브 블러 층이 있어야 하는가. */
  nativeWanted: boolean;
  /** 네이티브가 준비되면 루트에 `data-glass`를 찍어 반투명으로 그려도 되는가. */
  paintWanted: boolean;
}

/**
 * 순서가 곧 우선순위다: 미지원 > 불가 > 배경화면 > 켜기 실패 > 꺼짐 > (색을 못 읽음) > 투명도 줄이기 > 켬.
 * 앞의 세 이유는 저장된 값을 지우지 않지만 **유효 값은 꺼짐**이고 스위치는 잠긴다. 켜기 실패는 스위치를
 * 꺼진 채 열어 둔다(다시 눌러 볼 수 있다): 창 쪽 일이 실패하면 저장된 켬도 끄므로 `on`이 거짓이어도 문장은
 * 남아야 해서 꺼짐보다 앞이다. 투명도 줄이기는 스위치를 켠 채로 두되 그리지 않는다: 시스템이 끌 때까지
 * 사람이 이 규칙을 이길 수 없다(증보 1 D4 폴백 2). 테마의 색을 아직 못 읽은 동안(파생 엔진을 싣는 중)은
 * 켠 채로 두고 그리지도 네이티브를 켜지도 않는다.
 */
export function resolveGlass(input: GlassInput): GlassDecision {
  const off = (reason: GlassBlock | null, toggleDisabled: boolean): GlassDecision => ({
    reason,
    toggleDisabled,
    checked: false,
    nativeWanted: false,
    paintWanted: false,
  });
  if (!input.supported) return off("unsupported", true);
  if (input.floorPercent !== null && input.floorPercent > GLASS_OPACITY_MAX) return off("unusable", true);
  if (input.wallpaper) return off("wallpaper", true);
  if (input.failed) return off("failed", false);
  if (!input.on) return off(null, false);
  if (input.floorPercent === null) {
    return { reason: null, toggleDisabled: false, checked: true, nativeWanted: false, paintWanted: false };
  }
  if (input.reducedTransparency) {
    return {
      reason: "reduced-transparency",
      toggleDisabled: false,
      checked: true,
      nativeWanted: true,
      paintWanted: false,
    };
  }
  return { reason: null, toggleDisabled: false, checked: true, nativeWanted: true, paintWanted: true };
}
