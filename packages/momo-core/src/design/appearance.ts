// =============================================================================
// 외양 레코드 v2와 이행 (ADR-0189 D3 「ADR-0174 이행」, D4, 증보 1·3).
//
// 저장은 이 기기 로컬이다(ADR-0174 D3). 이 파일은 저장소를 만지지 않는다: 호스트가
// 키로 읽은 원문 문자열을 넘기면 v2 레코드를 돌려주고, 쓸 문자열을 만들어 준다.
// 웹은 `localStorage`, 폰은 MMKV가 그 원문을 들고 있다.
//
// | 호스트 | 새 키 | 읽기 순서 |
// |---|---|---|
// | 웹 | `momo.web.appearance.v2` | v2 → `momo.web.appearance.v1` → `momo.web.theme.v1` |
// | 폰 | `momo.mobile.appearance.v1` | 새 키 → `momo.mobile.theme.v1`(스킴만) |
//
// 폰 키가 v1에서 시작하는 것은 폰에 외양 레코드가 처음 생기기 때문이다. 레코드
// 안의 `v: 2`는 웹과 공유하는 스키마 버전이다. 두 번호는 서로 다른 것을 센다.
//
// 웹 v1 키는 **지우지도 쓰지도 않는다**. v2를 처음 쓴 뒤에도 v1은 그대로 남아, 예전
// 빌드로 되돌아가도 (그 시점까지의) 선택을 읽는다(롤백 허용, 청사진 §5.3-d).
//
// 모르는 값은 기본값으로 읽는다. 저장소에는 옛 버전이 쓴 값도 손으로 넣은 값도
// 들어올 수 있고, 어느 것도 화면을 잠글 이유가 되지 못한다.
//
// ## 선택 필드(웹이 읽고 쓰고, 폰은 아직 안 쓴다)
//
// 아래 필드는 모두 **기본값이면 직렬화에서 빠진다**. 그래서 폰의 저장 형태(다섯 키)는
// 이 필드가 생겨도 한 글자도 달라지지 않고, 필드를 쓰는 이슈가 이 파일을 다시 열지
// 않고도 값을 저장할 수 있다.
//   fontSize      AP-2a(#4189)   `data-font-size`
//   threadLayout  AP-2b(#4193)   `data-thread-layout`
//   prominentActive AP-2b        `data-prominent-active`
//   glass         AP-3(#4190)    `{on, opacity?}` (속성 `data-glass`는 AP-3가 찍는다)
//   wallpaper     AP-4(#4191)    참조만(`kind`가 `data-wallpaper`). 사진 바이트는 IndexedDB
//   fontSans·fontMono            글꼴 이름(#3774). v1에서 그대로 이어받는다
//   bubble        #4383(#4307)   말풍선 개인 덮어쓰기: 색·모서리·`layout: 'row'`(줄 보기)
// `overrides`(AP-5)는 그 이슈가 더한다.
// =============================================================================

import { parseHex } from "./color";
import { DEFAULT_DENSITY_ID, normalizeDensity, type DensityId } from "./density";
import { normalizeFontName } from "./fontName";
import { isSignalPresetId, type SignalPresetId } from "./signalIds";
import { normalizeThemeRef, type ThemeRef } from "./themeResolve";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "./themes";

/**
 * 저장소 항목 이름. 접미사가 `_KEY`가 아닌 것은 비밀 스캐너(gitleaks
 * generic-api-key)가 `…_KEY = "…"` 모양을 자격증명으로 읽기 때문이다.
 */
export const WEB_APPEARANCE_ENTRY = "momo.web.appearance.v2";
export const WEB_APPEARANCE_ENTRY_V1 = "momo.web.appearance.v1";
export const WEB_LEGACY_SCHEME_ENTRY = "momo.web.theme.v1";
export const MOBILE_APPEARANCE_ENTRY = "momo.mobile.appearance.v1";
export const MOBILE_LEGACY_SCHEME_ENTRY = "momo.mobile.theme.v1";

/**
 * 웹 루트 속성 열(ADR-0189 D3, 증보 3). `data-theme`은 스킴 전용으로 남는다.
 * `glass`는 **이름만 예약**한다: 켜는 것은 네이티브 vibrancy 적용이 성공한 뒤의 AP-3
 * 뿐이라 저장소는 이 속성을 찍지도 지우지도 않는다(`rootStamp.ts`).
 */
export const ROOT_ATTRIBUTES = {
  scheme: "data-theme",
  palette: "data-palette",
  themeRef: "data-theme-ref",
  signal: "data-signal",
  density: "data-density",
  fontSize: "data-font-size",
  glass: "data-glass",
  prominentActive: "data-prominent-active",
  threadLayout: "data-thread-layout",
  wallpaper: "data-wallpaper",
} as const;

export type SchemeChoice = "system" | "light" | "dark";

export type SignalChoice = null | { preset: SignalPresetId } | { custom: string };

export const FONT_SIZE_IDS = ["smaller", "default", "larger"] as const;
export type FontSizeId = (typeof FONT_SIZE_IDS)[number];
export const DEFAULT_FONT_SIZE_ID: FontSizeId = "default";

export const THREAD_LAYOUT_IDS = ["split", "focus"] as const;
export type ThreadLayoutId = (typeof THREAD_LAYOUT_IDS)[number];
export const DEFAULT_THREAD_LAYOUT_ID: ThreadLayoutId = "split";

/**
 * 말풍선 개인 덮어쓰기(#4383, 설정 화면·에이전트 명령 `appearance.bubble`은 #4307이 이 모양을 쓴다).
 * 폰 `bubble.ts` 의 `BubbleOverrides` 와 같은 모양이다 — 저장은 **값**(hex·숫자)이고, 「팔레트
 * 이름 → hex」 같은 설정층의 매핑은 #4307 몫이다. 빈 값은 「기본」이라 레코드에 두지 않는다.
 * 대비 판정(4.5:1)은 여기서 하지 않는다: 대비는 테마(바닥색)에 달려 있어 그리는 쪽
 * (`bubbleFor`)이 팔레트를 알 때만 판정할 수 있다. 여기는 **모양**만 지킨다.
 */
export interface BubbleSide {
  bg?: string;
  fg?: string;
}
export interface BubbleChoice {
  mine?: BubbleSide;
  other?: BubbleSide;
  /** 모서리 반경(0~28 정수). 기본값은 그리는 쪽이 안다. */
  radius?: number;
  /** `'row'`(줄 보기, 예전 평면 행)만 저장한다. 말풍선이 기본이라 `'bubble'` 은 키를 두지 않는다. */
  layout?: "row";
}

export const BUBBLE_RADIUS_MAX = 28;

/** 유리 배경(증보 1 D4). `opacity`는 0~100의 정수 퍼센트이고 하한 풀이는 AP-3가 한다. */
export interface GlassChoice {
  on: boolean;
  opacity?: number;
}

export const WALLPAPER_KINDS = ["solid", "preset", "image"] as const;
export type WallpaperKind = (typeof WALLPAPER_KINDS)[number];

/** 배경화면 **참조**. 「없음」은 필드가 없는 것이다. 사진 바이트는 레코드에 들지 않는다. */
export interface WallpaperRef {
  kind: WallpaperKind;
  /** `solid`·`preset`의 항목 id. */
  id?: string;
  width?: number;
  height?: number;
  /** 사진을 바꿀 때마다 올리는 번호(캐시 무효화·IndexedDB 참조 확인용). */
  rev?: number;
}

export interface AppearanceV2<T extends string = ThemeId> {
  v: 2;
  scheme: SchemeChoice;
  theme: T;
  signal: SignalChoice;
  density: DensityId;
  fontSize?: FontSizeId;
  threadLayout?: ThreadLayoutId;
  prominentActive?: boolean;
  glass?: GlassChoice;
  wallpaper?: WallpaperRef;
  fontSans?: string;
  fontMono?: string;
  bubble?: BubbleChoice;
}

/** 웹의 레코드: 테마가 첫 파티 id뿐 아니라 `catalog:`·`user:` 참조도 될 수 있다. */
export type WebAppearance = AppearanceV2<ThemeRef>;

export const DEFAULT_APPEARANCE: AppearanceV2 = {
  v: 2,
  scheme: "system",
  theme: DEFAULT_THEME_ID,
  signal: null,
  density: DEFAULT_DENSITY_ID,
};

export function normalizeScheme(raw: unknown): SchemeChoice {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** 커스텀 hex는 `#RRGGBB` 대문자로 저장한다. 형식이 틀리면 `null`(테마 기본 신호). */
export function normalizeSignal(raw: unknown): SignalChoice {
  if (raw == null || typeof raw !== "object") return null;
  const record = raw as { preset?: unknown; custom?: unknown };
  if (isSignalPresetId(record.preset)) return { preset: record.preset };
  if (typeof record.custom === "string" && parseHex(record.custom)) {
    return { custom: record.custom.trim().toUpperCase() };
  }
  return null;
}

export function normalizeFontSize(raw: unknown): FontSizeId {
  return raw === "smaller" || raw === "larger" ? raw : DEFAULT_FONT_SIZE_ID;
}

export function normalizeThreadLayout(raw: unknown): ThreadLayoutId {
  return raw === "focus" ? "focus" : DEFAULT_THREAD_LAYOUT_ID;
}

/** 유리: 꺼져 있고 불투명도도 없으면 레코드에 두지 않는다(`undefined`). */
export function normalizeGlass(raw: unknown): GlassChoice | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as { on?: unknown; opacity?: unknown };
  const on = record.on === true;
  const opacity =
    typeof record.opacity === "number" && Number.isFinite(record.opacity)
      ? Math.min(100, Math.max(0, Math.round(record.opacity)))
      : undefined;
  if (!on && opacity === undefined) return undefined;
  return opacity === undefined ? { on } : { on, opacity };
}

function normalizeBubbleSide(raw: unknown): BubbleSide | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as { bg?: unknown; fg?: unknown };
  const side: BubbleSide = {};
  // `signal.custom` 과 같은 규칙: 읽히는 `#RRGGBB` 만, 대문자로.
  if (typeof record.bg === "string" && parseHex(record.bg)) side.bg = record.bg.trim().toUpperCase();
  if (typeof record.fg === "string" && parseHex(record.fg)) side.fg = record.fg.trim().toUpperCase();
  return side.bg === undefined && side.fg === undefined ? undefined : side;
}

/** 말풍선 덮어쓰기. 모르는 값은 그 필드만 버린다. 남은 것이 없으면 `undefined`(레코드에 키를 두지 않는다). */
export function normalizeBubble(raw: unknown): BubbleChoice | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: BubbleChoice = {};
  const mine = normalizeBubbleSide(record.mine);
  if (mine) out.mine = mine;
  const other = normalizeBubbleSide(record.other);
  if (other) out.other = other;
  if (
    typeof record.radius === "number" &&
    Number.isInteger(record.radius) &&
    record.radius >= 0 &&
    record.radius <= BUBBLE_RADIUS_MAX
  ) {
    out.radius = record.radius;
  }
  if (record.layout === "row") out.layout = "row";
  return Object.keys(out).length === 0 ? undefined : out;
}

const WALLPAPER_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WALLPAPER_ID_MAX = 32;
const WALLPAPER_SIDE_MAX = 100_000;

function positiveInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : undefined;
}

/**
 * 배경화면 참조. 종류가 목록 밖이거나 `solid`·`preset`에 id가 없으면 「없음」(`undefined`)이다.
 * 덤으로 든 필드가 틀리면 그 필드만 버리고 `kind`는 지킨다(속성 `data-wallpaper`가 `kind`다).
 */
export function normalizeWallpaper(raw: unknown): WallpaperRef | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = (WALLPAPER_KINDS as readonly unknown[]).includes(record.kind)
    ? (record.kind as WallpaperKind)
    : null;
  if (kind === null) return undefined;
  const out: WallpaperRef = { kind };
  if (kind === "image") {
    const width = positiveInt(record.width, WALLPAPER_SIDE_MAX);
    const height = positiveInt(record.height, WALLPAPER_SIDE_MAX);
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (
      typeof record.rev === "number" &&
      Number.isInteger(record.rev) &&
      record.rev >= 0 &&
      record.rev <= Number.MAX_SAFE_INTEGER
    ) {
      out.rev = record.rev;
    }
    return out;
  }
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > WALLPAPER_ID_MAX ||
    !WALLPAPER_ID_RE.test(record.id)
  ) {
    return undefined;
  }
  out.id = record.id;
  return out;
}

/**
 * 레코드를 **정규 형태**로 만든다: 기본값인 선택 필드는 키를 두지 않고, 알 수 없는 값은 읽을 때와
 * 같은 규칙으로 정리한다. 직렬화와 읽기가 같은 함수를 지나므로 `읽기(직렬화(x))`가 제자리다.
 */
export function normalizeAppearance<T extends string>(state: AppearanceV2<T>): AppearanceV2<T> {
  const out: AppearanceV2<T> = {
    v: 2,
    scheme: normalizeScheme(state.scheme),
    theme: state.theme,
    signal: normalizeSignal(state.signal),
    density: normalizeDensity(state.density),
  };
  const fontSize = normalizeFontSize(state.fontSize);
  if (fontSize !== DEFAULT_FONT_SIZE_ID) out.fontSize = fontSize;
  const threadLayout = normalizeThreadLayout(state.threadLayout);
  if (threadLayout !== DEFAULT_THREAD_LAYOUT_ID) out.threadLayout = threadLayout;
  if (state.prominentActive === true) out.prominentActive = true;
  const glass = normalizeGlass(state.glass);
  if (glass) out.glass = glass;
  const wallpaper = normalizeWallpaper(state.wallpaper);
  if (wallpaper) out.wallpaper = wallpaper;
  const fontSans = normalizeFontName(state.fontSans);
  if (fontSans !== undefined) out.fontSans = fontSans;
  const fontMono = normalizeFontName(state.fontMono);
  if (fontMono !== undefined) out.fontMono = fontMono;
  const bubble = normalizeBubble(state.bubble);
  if (bubble) out.bubble = bubble;
  return out;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fromV2Record<T extends string>(
  record: Record<string, unknown>,
  theme: T
): AppearanceV2<T> {
  return normalizeAppearance<T>({
    v: 2,
    scheme: normalizeScheme(record.scheme),
    theme,
    signal: normalizeSignal(record.signal),
    density: normalizeDensity(record.density),
    fontSize: normalizeFontSize(record.fontSize),
    threadLayout: normalizeThreadLayout(record.threadLayout),
    prominentActive: record.prominentActive === true,
    glass: normalizeGlass(record.glass),
    wallpaper: normalizeWallpaper(record.wallpaper),
    fontSans: normalizeFontName(record.fontSans),
    fontMono: normalizeFontName(record.fontMono),
    bubble: normalizeBubble(record.bubble),
  });
}

/** 첫 파티 전용 v2 호환 파서. v2가 아니거나 JSON이 아니면 `null`(다음 키로 넘어간다). */
export function parseAppearanceV2(raw: string | null | undefined): AppearanceV2 | null {
  const record = parseJsonObject(raw);
  if (!record || record.v !== 2) return null;
  return fromV2Record(record, isThemeId(record.theme) ? record.theme : DEFAULT_THEME_ID);
}

/** v2 원문을 읽는다(웹: 테마가 `catalog:`·`user:` 참조일 수 있다). */
export function parseWebAppearanceV2(raw: string | null | undefined): WebAppearance | null {
  const record = parseJsonObject(raw);
  if (!record || record.v !== 2) return null;
  return fromV2Record<ThemeRef>(record, normalizeThemeRef(record.theme));
}

/**
 * ADR-0174의 v1 레코드 `{scheme, accent, fontSans?, fontMono?}`를 v2로 옮긴다(ADR-0189 D3 표).
 *
 * | v1 | v2 |
 * |---|---|
 * | `scheme` | 그대로 |
 * | `accent: "dawn"`·없음·모르는 값 | `theme: "dawnsky"`, `signal: null` |
 * | 네 프리셋 id | `theme: "dawnsky"`, `signal: {preset}` |
 * | `fontSans`·`fontMono`(#3774) | 그대로(허용 목록을 다시 통과한 것만) |
 * | 밀도 | `comfortable` (옛 이름은 `normalizeDensity`가 읽는다) |
 */
export function migrateAppearanceV1(raw: string | null | undefined): AppearanceV2 | null {
  const record = parseJsonObject(raw);
  if (!record) return null;
  return normalizeAppearance({
    v: 2,
    scheme: normalizeScheme(record.scheme),
    theme: DEFAULT_THEME_ID,
    signal: isSignalPresetId(record.accent) ? { preset: record.accent } : null,
    density: normalizeDensity(record.density),
    fontSans: normalizeFontName(record.fontSans),
    fontMono: normalizeFontName(record.fontMono),
  });
}

/** 스킴만 저장하던 옛 키(웹 `momo.web.theme.v1`, 폰 `momo.mobile.theme.v1`). */
export function migrateLegacyScheme(raw: string | null | undefined): AppearanceV2 | null {
  if (raw == null || raw === "") return null;
  return { ...DEFAULT_APPEARANCE, scheme: normalizeScheme(raw) };
}

/** 웹: v2 → v1 → 옛 스킴 키 순서로 읽는다. 셋 다 없으면 기본값. */
export function readWebAppearance(stored: {
  v2?: string | null;
  v1?: string | null;
  legacyScheme?: string | null;
}): WebAppearance {
  return (
    parseWebAppearanceV2(stored.v2) ??
    migrateAppearanceV1(stored.v1) ??
    migrateLegacyScheme(stored.legacyScheme) ??
    DEFAULT_APPEARANCE
  );
}

/** 폰: 새 키 → 옛 스킴 키. 카탈로그 참조를 읽고 사용자 테마(P2)는 기본으로 돌린다. */
export function readMobileAppearance(stored: {
  current?: string | null;
  legacyScheme?: string | null;
}): AppearanceV2<ThemeRef> {
  const current = parseWebAppearanceV2(stored.current);
  if (current) return current.theme.startsWith("user:") ? { ...current, theme: DEFAULT_THEME_ID } : current;
  return migrateLegacyScheme(stored.legacyScheme) ?? DEFAULT_APPEARANCE;
}

/** 쓸 문자열. 기본값인 선택 필드는 빠진다(정규 형태). 키 순서는 고정이다. */
export function serializeAppearance<T extends string>(state: AppearanceV2<T>): string {
  const s = normalizeAppearance(state);
  return JSON.stringify({
    v: 2,
    scheme: s.scheme,
    theme: s.theme,
    signal: s.signal,
    density: s.density,
    fontSize: s.fontSize,
    threadLayout: s.threadLayout,
    prominentActive: s.prominentActive,
    glass: s.glass,
    wallpaper: s.wallpaper,
    fontSans: s.fontSans,
    fontMono: s.fontMono,
    bubble: s.bubble,
  });
}
