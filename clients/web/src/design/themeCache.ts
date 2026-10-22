// =============================================================================
// 테마 변수 부트 캐시 — 웹 쪽 저장·정리 (AP-1a #4186).
//
// 계약(키 형식·변수 문법·상한)은 core `themeCache.ts`가 든다. 이 파일은 그 계약을 localStorage
// 와 `<html>`에 잇는 얇은 층이다:
//   · 읽기: 부트 스크립트(`public/theme-boot.js`)가 첫 렌더 전에 한다. 여기 `readThemeCache`는
//     앱이 올라온 뒤 같은 항목을 같은 문법으로 읽는 자리다.
//   · 쓰기: 파생 엔진(AP-1b)이 변수를 꽂은 직후 `writeThemeCache`로 남긴다.
//   · 정리: 레코드가 첫 파티 팔레트(정적 CSS)에 있거나 테마·신호가 바뀌면 낡은 캐시를 지운다.
//     (부트는 첫 파티 레코드의 캐시를 애초에 적용하지 않지만, 파생 테마에서 첫 파티로 돌아온 같은
//     세션에는 엔진이 꽂은 인라인 변수가 문서에 남아 있다. 그 변수와 항목을 걷는다.)
//     낡은 캐시를 두면 다음 부팅의 첫 프레임에 **지난 테마의 색**이 번쩍인다.
//
// 저장소가 막힌 환경(프라이빗 모드 등)은 전부 조용히 넘어간다. 캐시는 첫 프레임을 위한
// 최적화이고 없어도 앱은 기본 테마로 선다.
// =============================================================================

import {
  WEB_THEME_CACHE_ENTRY,
  parseThemeCache,
  serializeThemeCache,
  type ThemeCacheEntry,
} from "@momo/core/design/themeCache";

export const THEME_CACHE_STORAGE_KEY = WEB_THEME_CACHE_ENTRY;

/** 우리가 쓰는 저장소의 부분. 진짜 `localStorage`가 구조적으로 만족한다. */
export interface CacheStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/** 캐시가 꽂아 둔 인라인 변수를 걷을 수 있는 루트. */
export interface CacheRoot {
  style?: { removeProperty(name: string): unknown };
}

function defaultStorage(): CacheStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readThemeCache(storage: CacheStorage | null = defaultStorage()): ThemeCacheEntry | null {
  try {
    return storage ? parseThemeCache(storage.getItem(THEME_CACHE_STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

/** 파생 엔진이 변수를 꽂은 직후 부른다(AP-1b). 계약을 어기는 항목은 쓰지 않는다. */
export function writeThemeCache(
  entry: ThemeCacheEntry,
  storage: CacheStorage | null = defaultStorage()
): boolean {
  const raw = serializeThemeCache(entry);
  if (parseThemeCache(raw) === null) return false;
  try {
    storage?.setItem(THEME_CACHE_STORAGE_KEY, raw);
    return storage !== null;
  } catch {
    return false;
  }
}

/** 항목만 지운다(이미 꽂힌 인라인 변수는 건드리지 않는다). 레코드가 바뀐 즉시 부른다. */
export function dropThemeCache(storage: CacheStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(THEME_CACHE_STORAGE_KEY);
  } catch {
    // 저장소가 막혀 있으면 지울 것도 없다.
  }
}

/**
 * 캐시가 이름 붙인 인라인 변수를 `<html>`에서 걷고 항목도 지운다. 첫 파티 팔레트는 정적 CSS가
 * 색을 주므로, 파생 테마였을 때 꽂힌 변수가 남아 있으면 그 변수가 스타일시트를 가린다.
 */
export function retireThemeCache(
  root: CacheRoot,
  storage: CacheStorage | null = defaultStorage()
): void {
  const entry = readThemeCache(storage);
  if (entry) {
    for (const name of Object.keys(entry.vars)) root.style?.removeProperty(name);
  }
  dropThemeCache(storage);
}
