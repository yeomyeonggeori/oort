import type { SignalChoice } from "@momo/core/design/appearance";
import type { GlassSources } from "@momo/core/design/glass";
import { DERIVE_ENGINE_VERSION, DeriveError, TILE_VAR_NAMES, tileVars, type PresetOutcome } from "@momo/core/design/derive";
import {
  catalogPresetOutcomes,
  deriveCatalogMode,
  deriveCatalogVars,
  type CatalogVars,
} from "@momo/core/design/deriveCatalog";
import {
  SIGNAL_PRESET_IDS,
  resolvePreset,
  resolveSignal,
  type SignalPresetId,
} from "@momo/core/design/signal";
import { splitThemeRef, type ThemeRef } from "@momo/core/design/themeResolve";
import { THEMES, isThemeId, type Mode, type ThemeId, type ThemeModeTokens } from "@momo/core/design/themes";

// =============================================================================
// 파생 엔진의 웹 쪽 입구 (ADR-0189 증보 3 D2, AP-1b #4188).
//
// 이 모듈 하나가 카탈로그 씨앗 표와 파생 산수(core `derive`·`deriveCatalog`)를 끌고 온다(gzip 약 9KB). 그래서 메인
// 번들은 이것을 **정적으로 가져오지 않는다**: 메인의 얇은 문(`applyDerived.ts`)이 적용기(`derivedApplier.ts`)를 동적
// `import()`로 싣고 그 적용기가 이것을 가져오며, 갤러리(`ThemeGallery`, 이것도 지연 청크)도 정적으로 가져온다.
// 한 청크에 같이 실린다.
//
// 세 가지를 한다.
//   · `derivedVarsFor`: 파생 테마를 루트에 꽂을 변수 한 벌로(`applyDerived.ts`가 쓴다).
//   · `paintFor`: 미리보기 타일 한 장이 읽을 변수(요소마다 CSSOM으로 꽂는다). 첫 파티도 같은 길이다.
//   · `presetsFor`·`defaultSignalFor`: 강조색 칩이 이 테마·모드에서 어떤 색이고 쓸 수 있는지.
//   · `glassSourcesFor`: 데스크탑 유리(AP-3 `desktopEffects`)가 카탈로그 테마의 색을 읽는 조회(적용기가 한 번 꽂는다).
//
// 첫 파티의 신호 판정(`resolvePreset`·`resolveSignal`)도 여기 있다. 그 산수가 메인 번들에 들어가면 gzip이 1.3KB
// 가까이 늘어서(번들 예산 메인 +2KB), 칩과 타일을 칠하는 일은 전부 이 지연 청크 안에서 한다.
// =============================================================================

export { DERIVE_ENGINE_VERSION, TILE_VAR_NAMES };
export type { PresetOutcome, CatalogVars };
export type TileVarName = (typeof TILE_VAR_NAMES)[number];
export type TilePaint = Readonly<Record<TileVarName, string>>;

/** 첫 파티 토큰에 사람이 고른 신호를 올린다. 거절되면(직접 입력만 거절될 수 있다) 기본 신호다. */
function firstPartyTokens(id: ThemeId, mode: Mode, signal: SignalChoice): ThemeModeTokens {
  const base = THEMES[id][mode];
  if (signal === null) return base;
  const result = "preset" in signal ? resolvePreset(signal.preset, id, mode) : resolveSignal(signal.custom, id, mode);
  return result.ok ? { ...base, color: { ...base.color, ...result.values } } : base;
}

/** 네 프리셋이 첫 파티의 한 모드에서 서는가. 생성기가 첫 파티 전 조합의 통과를 보장하므로 전부 선다. */
function firstPartyPresets(id: ThemeId, mode: Mode): Readonly<Record<SignalPresetId, PresetOutcome>> {
  const out = {} as Record<SignalPresetId, PresetOutcome>;
  for (const preset of SIGNAL_PRESET_IDS) {
    const result = resolvePreset(preset, id, mode);
    out[preset] = result.ok
      ? { ok: true, signal: result.values.signal, onSignal: result.values["on-signal"] }
      : { ok: false, reason: result.reason, message: result.message };
  }
  return out;
}

/**
 * 파생이 던지는 `DeriveError`(바탕이 중간 휘도라 어느 방향으로도 4.5에 못 닿는 씨앗)는 그 테마 하나의 문제다. 번들 57종은
 * 시험이 막지만 같은 함수를 쓰는 사용자 테마(AP-5)에는 열려 있어서, 한 테마가 설정 화면 전체를 무너뜨리지 않게 `null`로
 * 받는다(타일은 비워 두고 층이 루트를 물려받는다, 적용기는 아무것도 꽂지 않아 기본 테마로 선다). 다른 오류는 그대로 던진다.
 */
function safely<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch (error) {
    if (error instanceof DeriveError) return null;
    throw error;
  }
}

/** 파생 테마(`catalog:`)의 루트 변수. 첫 파티는 정적 CSS가 색을 주므로 `null`이다. `user:`는 AP-5가 연다. */
export function derivedVarsFor(ref: ThemeRef, signal: SignalChoice): CatalogVars | null {
  const parts = splitThemeRef(ref);
  return parts?.namespace === "catalog" ? safely(() => deriveCatalogVars(parts.id, signal)) : null;
}

/** 타일 한 장(한 테마 × 한 모드)이 읽는 변수. 모르는 참조는 `null`. */
export function paintFor(ref: ThemeRef, mode: Mode, signal: SignalChoice): TilePaint | null {
  if (isThemeId(ref)) return tileVars(firstPartyTokens(ref, mode, signal), mode);
  const parts = splitThemeRef(ref);
  if (parts?.namespace !== "catalog") return null;
  const derived = safely(() => deriveCatalogMode(parts.id, mode, signal));
  return derived ? tileVars(derived.tokens, mode, derived.pane) : null;
}

/** 네 프리셋이 이 테마·모드에서 서는가. 첫 파티는 전부 서고, 카탈로그는 거절된 조합이 이유와 한 줄을 든다. */
export function presetsFor(ref: ThemeRef, mode: Mode): Readonly<Record<SignalPresetId, PresetOutcome>> | null {
  if (isThemeId(ref)) return firstPartyPresets(ref, mode);
  const parts = splitThemeRef(ref);
  return parts?.namespace === "catalog" ? safely(() => catalogPresetOutcomes(parts.id, mode)) : null;
}

/** 이 테마·모드의 기본 신호(사람이 고르지 않았을 때 쓰는 색). 「기본」 칩이 이 색을 보인다. */
export function defaultSignalFor(ref: ThemeRef, mode: Mode): { signal: string; onSignal: string } | null {
  if (isThemeId(ref)) {
    const color = THEMES[ref][mode].color;
    return { signal: color.signal, onSignal: color["on-signal"] };
  }
  const parts = splitThemeRef(ref);
  const derived = parts?.namespace === "catalog" ? safely(() => deriveCatalogMode(parts.id, mode, null)) : null;
  return derived ? { signal: derived.tokens.color.signal, onSignal: derived.tokens.color["on-signal"] } : null;
}

/**
 * 카탈로그 테마의 두 모드(없는 모드는 빼고)를 데스크탑 유리가 읽는 모양으로 낸다. 파생 토큰(`canvas`·`band`·`color`)이
 * `GlassSource`를 그대로 만족한다. 고른 강조색(`signal`)이 들어간 값이다(사이드바의 신호색이 유리 위에서 사라지지 않게). 첫 파티는
 * 유리 쪽이 스스로 알고(`firstPartyGlassSources`), `user:`는 AP-5가 연다. 모르는 항목이나 파생이 던지는 테마는 `null`이다(유리가
 * 「색을 아직 못 읽음」으로 그 테마만 걷는다).
 */
export function glassSourcesFor(ref: ThemeRef, signal: SignalChoice): GlassSources | null {
  const parts = splitThemeRef(ref);
  if (parts?.namespace !== "catalog") return null;
  return safely(() => {
    const light = deriveCatalogMode(parts.id, "light", signal)?.tokens;
    const dark = deriveCatalogMode(parts.id, "dark", signal)?.tokens;
    return light || dark ? { ...(light && { light }), ...(dark && { dark }) } : null;
  });
}
