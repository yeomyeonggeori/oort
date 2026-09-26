// =============================================================================
// 외양 레코드 v2와 이행 (ADR-0189 D3 「ADR-0174 이행」, D4).
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
// 모르는 값은 기본값으로 읽는다. 저장소에는 옛 버전이 쓴 값도 손으로 넣은 값도
// 들어올 수 있고, 어느 것도 화면을 잠글 이유가 되지 못한다.
// =============================================================================

import { parseHex } from "./color";
import { DEFAULT_DENSITY_ID, normalizeDensity, type DensityId } from "./density";
import { isSignalPresetId, type SignalPresetId } from "./signal";
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

/** 웹 루트 속성 넷(ADR-0189 D3). `data-theme`은 스킴 전용으로 남는다. */
export const ROOT_ATTRIBUTES = {
  scheme: "data-theme",
  palette: "data-palette",
  signal: "data-signal",
  density: "data-density",
} as const;

export type SchemeChoice = "system" | "light" | "dark";

export type SignalChoice = null | { preset: SignalPresetId } | { custom: string };

export interface AppearanceV2 {
  v: 2;
  scheme: SchemeChoice;
  theme: ThemeId;
  signal: SignalChoice;
  density: DensityId;
}

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

/** v2 원문을 읽는다. v2가 아니거나 JSON이 아니면 `null`(다음 키로 넘어간다). */
export function parseAppearanceV2(raw: string | null | undefined): AppearanceV2 | null {
  const record = parseJsonObject(raw);
  if (!record || record.v !== 2) return null;
  return {
    v: 2,
    scheme: normalizeScheme(record.scheme),
    theme: isThemeId(record.theme) ? record.theme : DEFAULT_THEME_ID,
    signal: normalizeSignal(record.signal),
    density: normalizeDensity(record.density),
  };
}

/**
 * ADR-0174의 v1 레코드 `{scheme, accent}`를 v2로 옮긴다(ADR-0189 D3 표).
 *
 * | v1 | v2 |
 * |---|---|
 * | `scheme` | 그대로 |
 * | `accent: "dawn"`·없음·모르는 값 | `theme: "dawnsky"`, `signal: null` |
 * | 네 프리셋 id | `theme: "dawnsky"`, `signal: {preset}` |
 * | 밀도 | `comfortable` (옛 이름은 `normalizeDensity`가 읽는다) |
 */
export function migrateAppearanceV1(raw: string | null | undefined): AppearanceV2 | null {
  const record = parseJsonObject(raw);
  if (!record) return null;
  return {
    v: 2,
    scheme: normalizeScheme(record.scheme),
    theme: DEFAULT_THEME_ID,
    signal: isSignalPresetId(record.accent) ? { preset: record.accent } : null,
    density: normalizeDensity(record.density),
  };
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
}): AppearanceV2 {
  return (
    parseAppearanceV2(stored.v2) ??
    migrateAppearanceV1(stored.v1) ??
    migrateLegacyScheme(stored.legacyScheme) ??
    DEFAULT_APPEARANCE
  );
}

/** 폰: 새 키 → 옛 스킴 키 순서로 읽는다. */
export function readMobileAppearance(stored: {
  current?: string | null;
  legacyScheme?: string | null;
}): AppearanceV2 {
  return (
    parseAppearanceV2(stored.current) ?? migrateLegacyScheme(stored.legacyScheme) ?? DEFAULT_APPEARANCE
  );
}

export function serializeAppearance(state: AppearanceV2): string {
  return JSON.stringify({
    v: 2,
    scheme: state.scheme,
    theme: state.theme,
    signal: state.signal,
    density: state.density,
  });
}
