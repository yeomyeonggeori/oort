// =============================================================================
// 테마 변수 부트 캐시의 **계약** (AP-1a #4186, 청사진 §5.2-i · Buzz `applyCachedVars`의 개념).
//
// 런타임에 파생한 테마(카탈로그·사용자 테마, AP-1b·AP-5)는 정적 CSS가 없어서 앱 JS가 36개
// 토큰을 인라인 변수로 꽂아야 비로소 제 색이 선다. 그 전의 첫 프레임이 기본 테마로 보이는
// 것을 막으려고, 마지막으로 꽂은 변수를 `momo.web.theme.cache.v1`에 두었다가 첫 렌더 전에
// 고전 스크립트(`public/theme-boot.js`)가 되꽂는다.
//
//   momo.web.theme.cache.v1 = { key, vars, mode? }
//
// 이 이슈(AP-1a)는 **계약과 읽는 쪽**만 세운다. 쓰는 쪽(파생 엔진)은 AP-1b다. 캐시가 없으면
// 부트 스크립트는 아무것도 하지 않고, 앱은 기본 테마로 선다(깨지지 않는다).
//
// **캐시는 파생 테마의 것이다.** 저장된 테마가 첫 파티 id(정적 CSS가 색을 준다)이면 부트는 캐시가
// 있어도 무시하고, 앱이 올라오면 낡은 항목을 걷는다(`theme.ts`). 그러지 않으면 첫 프레임에 캐시
// 색이 섰다가 걷히는 번쩍임이 생기고, 두 모드를 다 가진 첫 파티 테마에 `mode`가 남아 부트와
// 런타임이 `data-theme`를 다르게 찍는다(design-review M-1).
//
// ## key
// `<엔진 판>|<테마 참조>|<신호 키>` 한 줄이다. 엔진 판은 쓴 쪽의 문자열이고 부트 스크립트는
// 읽지 않는다. **뒤 두 칸이 지금 레코드의 테마·신호와 같을 때만** 부트가 적용한다: 다른 테마의
// 캐시를 첫 페인트에 얹어 잘못된 색이 번쩍이는 일은 없다. 칸을 더 붙일 수 있다(AP-5가
// 덮어쓰기 해시를 넷째 칸으로). 레코드가 바뀌어 `lookKeyOf`가 달라지면 저장소가 캐시를 즉시
// 비운다(`theme.ts`의 commit).
//
// ## vars
// 인라인으로 꽂을 `{ "--이름": 값 }`. **전부 통과해야 하나도 안 꽂는다**: 이름은 `--[a-z0-9-]`
// 뿐이고 값은 색 하나 또는 `light-dark(색, 색)`뿐이다. `url(`·`var(`·세미콜론·따옴표·중괄호는
// 문법에 없으므로 어느 값에도 못 든다. 캐시는 사람이 고친 적 없는 우리 기록이지만, 저장소는
// 같은 출처의 다른 코드도 쓸 수 있으므로 읽을 때 다시 의심한다.
//
// ## mode
// 단일 모드 테마(다크 단독 등)면 그 모드. 부트가 `data-theme`를 그 모드로 못 박아 첫 프레임의
// `color-scheme`이 어긋나지 않게 한다(`themeResolve.effectiveScheme`와 같은 규칙).
// =============================================================================

import type { SignalChoice } from "./appearance";
import type { Mode } from "./themes";
import type { ThemeRef } from "./themeResolve";

export const WEB_THEME_CACHE_ENTRY = "momo.web.theme.cache.v1";

export const THEME_CACHE_MAX_BYTES = 12_288;
export const THEME_CACHE_MAX_VARS = 64;
export const THEME_CACHE_MAX_KEY = 160;

export const THEME_CACHE_NAME_PATTERN = "^--[a-z][a-z0-9-]{0,47}$";

const COLOR =
  "(?:#[0-9a-fA-F]{3,8}|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*(?:0|1|0?\\.\\d{1,3}|1\\.0{1,3})\\s*)?\\))";

/** 색 하나 또는 `light-dark(색, 색)`. 부트 스크립트가 같은 식을 쓴다(웹 시험이 문자열로 맞춘다). */
export const THEME_CACHE_VALUE_PATTERN = `^(?:${COLOR}|light-dark\\(\\s*${COLOR}\\s*,\\s*${COLOR}\\s*\\))$`;

/** 키에 들 수 있는 글자: 참조(`catalog:nord`), 신호 키(`#RRGGBB`), 구분자 `|`. */
export const THEME_CACHE_KEY_PATTERN = "^[A-Za-z0-9.:#|_-]+$";

const NAME_RE = new RegExp(THEME_CACHE_NAME_PATTERN);
const VALUE_RE = new RegExp(THEME_CACHE_VALUE_PATTERN);
const KEY_RE = new RegExp(THEME_CACHE_KEY_PATTERN);

export interface ThemeCacheEntry {
  key: string;
  vars: Readonly<Record<string, string>>;
  mode?: Mode;
}

/** 신호 선택의 키 조각: 없음 `-`, 프리셋 id, 직접 고른 색은 `#RRGGBB`(대문자). */
export function signalKeyOf(signal: SignalChoice): string {
  if (signal === null) return "-";
  return "preset" in signal ? signal.preset : signal.custom;
}

/**
 * 「이 레코드의 어느 부분이 바뀌면 캐시가 낡는가」의 키. 테마 참조와 신호다(AP-5가 덮어쓰기를
 * 더한다). 밀도·글자 크기·스킴·글꼴은 파생 변수에 들지 않으므로 여기 없다(변수는
 * `light-dark()` 쌍이라 스킴이 바뀌어도 다시 계산하지 않는다).
 */
export function lookKeyOf(state: { theme: ThemeRef; signal: SignalChoice }): string {
  return `${state.theme}|${signalKeyOf(state.signal)}`;
}

/** 쓰는 쪽이 키를 만든다: `<엔진 판>|<테마>|<신호>`. */
export function themeCacheKey(engine: string, state: { theme: ThemeRef; signal: SignalChoice }): string {
  return `${engine}|${lookKeyOf(state)}`;
}

/** 캐시 키가 지금 레코드의 모양과 같은가(엔진 판 칸은 보지 않고, 뒤 칸이 더 붙어도 된다). */
export function cacheMatchesLook(
  key: string,
  state: { theme: ThemeRef; signal: SignalChoice }
): boolean {
  const first = key.indexOf("|");
  if (first <= 0) return false;
  const rest = key.slice(first + 1);
  const look = lookKeyOf(state);
  return rest === look || rest.startsWith(`${look}|`);
}

/**
 * 저장된 원문을 캐시로 읽는다. 하나라도 계약을 어기면 **통째로** `null`이다(일부만 꽂지 않는다).
 */
export function parseThemeCache(raw: string | null | undefined): ThemeCacheEntry | null {
  if (typeof raw !== "string" || raw === "" || raw.length > THEME_CACHE_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { key?: unknown; vars?: unknown; mode?: unknown };
  if (
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > THEME_CACHE_MAX_KEY ||
    !KEY_RE.test(record.key)
  ) {
    return null;
  }
  if (record.vars == null || typeof record.vars !== "object" || Array.isArray(record.vars)) return null;
  const names = Object.keys(record.vars);
  if (names.length === 0 || names.length > THEME_CACHE_MAX_VARS) return null;
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = (record.vars as Record<string, unknown>)[name];
    if (!NAME_RE.test(name) || typeof value !== "string" || !VALUE_RE.test(value)) return null;
    vars[name] = value;
  }
  if (record.mode !== undefined && record.mode !== "light" && record.mode !== "dark") return null;
  const entry: ThemeCacheEntry = { key: record.key, vars };
  if (record.mode !== undefined) entry.mode = record.mode;
  return entry;
}

export function serializeThemeCache(entry: ThemeCacheEntry): string {
  return JSON.stringify({ key: entry.key, vars: entry.vars, mode: entry.mode });
}
