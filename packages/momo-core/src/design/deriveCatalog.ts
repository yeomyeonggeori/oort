// =============================================================================
// 카탈로그 위의 파생 조회 (ADR-0189 증보 3 D1·D2, AP-1b #4188).
//
// `derive.ts`는 씨앗 한 모드를 토큰으로 바꾸는 순수 함수이고 카탈로그를 모른다. 이 파일이 카탈로그 항목
// 이름(`catalog:<id>`의 id)으로 씨앗을 찾아 그 함수를 부르고, 같은 입력의 결과를 기억한다(테마 한 모드 파생은
// 약 0.7ms라 갤러리 타일 수십 개를 그려도 한 프레임 안이지만, 같은 타일을 다시 그릴 때 다시 계산하지 않는다).
//
// 이 파일은 전체 카탈로그(`themeCatalog.generated.ts`, 씨앗 표)를 읽는다. 그래서 **메인 번들에서 정적으로
// 부르지 않는다**: 웹은 `design/themes/derived.ts`가 동적 `import()`로 이 파일을 싣는다. 메인 번들이 읽는 것은
// id·모드·라벨만 든 `themeCatalogIndex.generated.ts`다(`themeResolve.ts`).
// =============================================================================

import type { SignalChoice } from "./appearance";
import {
  deriveCssVars,
  deriveThemeMode,
  presetOutcomes,
  type DerivedMode,
  type PresetOutcome,
} from "./derive";
import type { SignalPresetId } from "./signal";
import { THEME_CATALOG } from "./themeCatalog.generated";
import { signalKeyOf } from "./themeCache";
import type { CatalogEntry } from "./themeSeed";
import { MODES, type Mode } from "./themes";

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(THEME_CATALOG.map((entry) => [entry.id, entry]));

export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

export function catalogEntries(): readonly CatalogEntry[] {
  return THEME_CATALOG;
}

const modeCache = new Map<string, DerivedMode>();

/** 카탈로그 항목 한 모드를 파생한다. 항목이 없거나 그 모드가 없으면 `null`이다. 같은 입력은 같은 객체를 돌려준다. */
export function deriveCatalogMode(id: string, mode: Mode, signal: SignalChoice = null): DerivedMode | null {
  const seed = BY_ID.get(id)?.[mode];
  if (!seed) return null;
  const key = `${id}|${mode}|${signalKeyOf(signal)}`;
  const hit = modeCache.get(key);
  if (hit) return hit;
  const derived = deriveThemeMode(seed, { signal });
  modeCache.set(key, derived);
  return derived;
}

const presetCache = new Map<string, Readonly<Record<SignalPresetId, PresetOutcome>>>();

/** 네 프리셋을 이 항목의 한 모드에 올린 결과. 거절된 프리셋은 이유와 한 줄을 든다. */
export function catalogPresetOutcomes(
  id: string,
  mode: Mode
): Readonly<Record<SignalPresetId, PresetOutcome>> | null {
  const seed = BY_ID.get(id)?.[mode];
  if (!seed) return null;
  const key = `${id}|${mode}`;
  const hit = presetCache.get(key);
  if (hit) return hit;
  const outcomes = presetOutcomes(seed);
  presetCache.set(key, outcomes);
  return outcomes;
}

export interface CatalogVars {
  /** 루트에 꽂을 변수. */
  readonly vars: Readonly<Record<string, string>>;
  /** 모드가 하나뿐인 항목이면 그 모드(루트 `data-theme`를 못 박는다). */
  readonly pinned: Mode | null;
  /** 브라우저 크롬(`meta theme-color`)에 쓸 바닥색. 모드별. */
  readonly canvas: Readonly<Partial<Record<Mode, string>>>;
}

/** 항목의 모든 모드를 한 벌의 루트 변수로. 항목이 없으면 `null`이다. */
export function deriveCatalogVars(id: string, signal: SignalChoice = null): CatalogVars | null {
  const entry = BY_ID.get(id);
  if (!entry) return null;
  const parts: { light?: DerivedMode; dark?: DerivedMode } = {};
  const canvas: Partial<Record<Mode, string>> = {};
  for (const mode of MODES) {
    const derived = deriveCatalogMode(id, mode, signal);
    if (!derived) continue;
    parts[mode] = derived;
    canvas[mode] = derived.tokens.canvas[1];
  }
  const present = MODES.filter((mode) => parts[mode]);
  return { vars: deriveCssVars(parts), pinned: present.length === 1 ? present[0] : null, canvas };
}
