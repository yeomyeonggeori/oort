import { useSyncExternalStore } from "react";
import {
  DEFAULT_APPEARANCE,
  ROOT_ATTRIBUTES,
  WEB_APPEARANCE_ENTRY,
  WEB_APPEARANCE_ENTRY_V1,
  WEB_LEGACY_SCHEME_ENTRY,
  normalizeAppearance,
  readWebAppearance,
  serializeAppearance,
  type SchemeChoice,
  type WebAppearance,
} from "@momo/core/design/appearance";
import { normalizeFontName } from "@momo/core/design/fontName";
import {
  STAMPED_ATTRIBUTES,
  accentOfSignal,
  rootStamp,
  signalOfAccent,
} from "@momo/core/design/rootStamp";
import { lookKeyOf } from "@momo/core/design/themeCache";
import {
  DERIVED_PALETTE,
  modesOf,
  normalizeThemeRef,
  paletteOf,
  type ModesLookup,
  type ThemeRef,
} from "@momo/core/design/themeResolve";
import { isDesktop, onSystemThemeChanged } from "@/lib/tauri";
import {
  ACCENT_ATTRIBUTE,
  normalizeAccentId,
  type AccentId,
} from "./themes";
import { createSystemScheme, type MediaLike } from "./systemScheme";
import { dropThemeCache, retireThemeCache, type CacheStorage } from "./themeCache";
import { applyUserFonts, type FontDocument } from "./userFont";

export type { AccentId } from "./themes";
export {
  ACCENT_ATTRIBUTE,
  ACCENT_THEMES,
  DEFAULT_ACCENT_ID,
  isAccentId,
  normalizeAccentId,
} from "./themes";

// =============================================================================
// 외양 저장소 (U2 + ADR-0174 + ADR-0189 증보 3, AP-1a #4186).
//
// 발단: tokens.css는 처음부터 두 스킴을 갖고 있었지만(`color-scheme: light dark`
// + `light-dark()`), 그것을 고르는 자리가 앱 안에 없었다. 라이트로 보고 싶은
// 사람은 OS 설정을 바꾸는 수밖에 없었고, 그것은 이 앱 하나 때문에 모든 앱의
// 밝기를 바꾸라는 말이다. BZ-5a가 그 자리 위에 액센트 바인딩을 얹었고, AP-1a가 저장을
// **v2 레코드**(core `appearance.ts`)로 옮긴다: 테마·신호·밀도·글자 크기·스레드 배치·
// 배경화면 참조까지 한 레코드가 들고, 이 파일은 그 레코드를 읽고 쓰고 `<html>`에 찍는다.
//
// **스킴 스탬프 문법은 새로 만들지 않았다.** tokens.css에 이미 있던 두 규칙이
// 정본이고, 지금까지는 캡처 하네스만 그것을 알고 있었다:
//
//     :root[data-theme="light"] { color-scheme: light; }
//     :root[data-theme="dark"]  { color-scheme: dark; }
//
// `light-dark()`는 그 요소에 적용된 `color-scheme`으로 갈리므로, 루트에 한 글자를
// 스탬프하는 것만으로 팔레트 전체가 한쪽으로 고정된다. 팔레트를 두 벌 갖지 않는다
// 는 tokens.css의 계약이 그대로 유지되고, 이 파일이 아는 색은 **하나도 없다**.
//
// 어느 속성에 무엇을 찍는지는 core `rootStamp.ts`의 표 한 곳이 정한다. 이 파일은 그 표를
// `<html>`에 옮기기만 한다(스킴만 `theme-color` 줄과 함께 `applyTheme`가 맡는다).
//
// 저장은 localStorage `momo.web.appearance.v2`(ADR-0174 D3, 이 기기). 읽는 순서는 v2 →
// `momo.web.appearance.v1` → `momo.web.theme.v1`이고, **쓰는 것은 v2 하나**다. v1·옛 키는
// 지우지 않는다(롤백 허용).
//
// 첫 페인트는 이 모듈이 책임지지 않는다 — 못 한다. 번들은 defer이므로 여기가
// 실행될 때는 이미 한 프레임이 그려졌을 수 있고, 그 프레임이 반대 스킴이면 그것이
// 곧 FOUC다. 그 자리는 public/theme-boot.js(파서를 세우는 고전 스크립트)가 맡고,
// 이 모듈은 그것의 정본이자 **두 번째 방어선**이다: 그 파일이 오지 못한 경우
// (오프라인 콜드 스타트, 캐시 실패)에도 `initTheme()`이 같은 스탬프를 붙인다.
// =============================================================================

export type ThemeChoice = SchemeChoice;

/** 웹이 들고 있는 레코드: core v2에 테마가 `catalog:`·`user:` 참조일 수 있는 판이다. */
export type AppearanceState = WebAppearance;

/**
 * 정본 저장 위치 (ADR-0174 D3 → v2). 동결층이므로 접두는 `momo.`로 남는다. 값은 core 상수를
 * 그대로 가리킨다(이름 접미사 설명은 core `appearance.ts`).
 */
export const APPEARANCE_STORAGE_KEY = WEB_APPEARANCE_ENTRY;

/** v1 레코드 `{scheme, accent, fontSans, fontMono}`. 읽기 이관 전용, 지우지도 쓰지도 않는다. */
export const APPEARANCE_STORAGE_KEY_V1 = WEB_APPEARANCE_ENTRY_V1;

/** 스킴만 저장하던 시절의 키. 읽기 이관 전용, 새 쓰기는 하지 않는다. */
export const THEME_STORAGE_KEY = WEB_LEGACY_SCHEME_ENTRY;

/** 루트에 찍는 이름. tokens.css의 `:root[data-theme=...]`가 읽는 그 이름이다. */
export const THEME_ATTRIBUTE = ROOT_ATTRIBUTES.scheme;

/** 고정을 풀 때 되돌릴, 시스템을 따르던 때의 브라우저 크롬 색. */
export const SYSTEM_COLOR_ATTRIBUTE = "data-theme-color-system";

/** 테마 팔레트를 고르는 루트 속성 (ADR-0189 D3). 스킴(`data-theme`)과 따로 간다. */
export const PALETTE_ATTRIBUTE = ROOT_ATTRIBUTES.palette;

/**
 * 저장된 문자열을 선택으로 읽는다. 모르는 값은 전부 "system"이다: 저장소에는
 * 옛 버전이 쓴 값도, 사람이 손으로 넣은 값도 들어올 수 있고, 그중 어느 것도
 * 화면을 잠글 이유가 되지 못한다.
 */
export function normalizeThemeChoice(raw: string | null | undefined): ThemeChoice {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

// ---- DOM: 이 모듈이 만지는 최소한만 이름으로 적는다 --------------------------
// `Document`를 통째로 요구하지 않는 이유는 테스트다. 이 레포의 vitest는 node
// 환경이고(jsdom 의존성이 없다), 아래 세 개의 구조적 타입이면 가짜 문서로
// 스탬프 규칙 전체를 잴 수 있다. 진짜 `document`는 구조적으로 이것을 만족한다.

interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface ThemeMeta {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
}

interface ThemeDocument {
  documentElement: ThemeRoot;
  querySelectorAll(selector: string): Iterable<ThemeMeta>;
}

/** 외양 한 벌을 통째로 적용할 때 필요한 문서: 스탬프 + 글꼴 변수(`style`)까지. */
export type AppearanceDocument = ThemeDocument & FontDocument;

const THEME_COLOR_SELECTOR = "meta[name='theme-color'][media]";

/**
 * 스킴을 문서에 적용한다. 두 가지를 같이 한다.
 *
 *   1. 루트 스탬프. 고정이면 `data-theme`, 시스템이면 그 속성의 제거.
 *   2. 브라우저 크롬(주소창·상태바) 색. index.html의 theme-color 두 줄은
 *      prefers-color-scheme으로 갈리므로, 앱만 고정하면 다크 앱 위에 라이트
 *      주소창이 남는다. 색을 다시 적지 않고 **고른 쪽 줄의 값을 두 줄에 복사**
 *      하고, 원래 값은 각 줄이 자기 속성에 들고 있다가 고정이 풀리면 되돌린다.
 *      그래서 팔레트는 계속 index.html 한 곳에만 있다.
 *
 * public/theme-boot.js가 첫 페인트 전에 하는 일과 같다. 두 벌인 것은 순서 때문
 * 이지 선택이 아니고, 둘이 어긋나지 않는지는 theme.test.ts가 그 파일을 **실행해서**
 * 확인한다.
 */
export function applyTheme(choice: ThemeChoice, doc?: ThemeDocument): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;

  if (choice === "system") target.documentElement.removeAttribute(THEME_ATTRIBUTE);
  else target.documentElement.setAttribute(THEME_ATTRIBUTE, choice);

  const metas = [...target.querySelectorAll(THEME_COLOR_SELECTOR)];
  if (metas.length === 0) return;

  for (const meta of metas) {
    if (!meta.hasAttribute(SYSTEM_COLOR_ATTRIBUTE)) {
      const own = meta.getAttribute("content");
      if (own !== null) meta.setAttribute(SYSTEM_COLOR_ATTRIBUTE, own);
    }
  }

  if (choice === "system") {
    for (const meta of metas) {
      const own = meta.getAttribute(SYSTEM_COLOR_ATTRIBUTE);
      if (own !== null) meta.setAttribute("content", own);
    }
    return;
  }

  const pinned = metas.find((meta) =>
    (meta.getAttribute("media") ?? "").includes(choice)
  );
  const color = pinned?.getAttribute(SYSTEM_COLOR_ATTRIBUTE) ?? null;
  if (color === null) return;
  for (const meta of metas) meta.setAttribute("content", color);
}

/** ADR-0174 이행 동안 `themes/<id>.css`가 읽는 옛 `data-accent`만 찍는다(시험·캡처가 쓴다). */
export function applyAccent(accent: AccentId, doc?: ThemeDocument): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;
  target.documentElement.setAttribute(ACCENT_ATTRIBUTE, accent);
}

// 카탈로그(AP-1b)가 `catalog:`·`user:` 참조의 모드를 알려 주기 전까지 스토어는 그 참조를
// 모른다(둘 다로 본다). 단일 모드 규칙을 가짜 참조로 재는 시험이 이 조회를 갈아 끼운다.
let modesLookup: ModesLookup | undefined;

/** 시험 전용: 가짜 단일 모드 참조로 스토어의 `data-theme` 판정을 잰다. */
export function setThemeModesLookupForTest(lookup: ModesLookup | undefined): void {
  modesLookup = lookup;
}

export interface ApplyAppearanceOptions {
  doc?: AppearanceDocument;
  lookup?: ModesLookup;
  /** 낡은 부트 캐시를 걷을 저장소. 기본은 `localStorage`. */
  storage?: CacheStorage | null;
}

/**
 * 외양 한 벌을 문서에 적용한다. 무엇을 찍는지는 core `rootStamp`의 표가 정하고 여기는 옮기기만
 * 한다. `data-glass`는 표에 없으므로 **건드리지 않는다**(켜는 것은 AP-3, 네이티브 효과가 선
 * 뒤에). 첫 파티 팔레트에서는 부트가 되꽂았던 캐시 변수가 정적 CSS를 가리지 않게 걷는다.
 */
export function applyAppearance(state: AppearanceState, options: ApplyAppearanceOptions = {}): void {
  const target = options.doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;
  const stamp = rootStamp(state, modesOf(state.theme, options.lookup ?? modesLookup));
  const root = target.documentElement;
  for (const name of STAMPED_ATTRIBUTES) {
    if (name === THEME_ATTRIBUTE) continue; // 스킴은 theme-color 줄과 함께 아래에서.
    const value = stamp[name];
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  applyTheme(stamp[THEME_ATTRIBUTE] ?? "system", target);
  // 걷는 일이 먼저, 글꼴이 나중이다: 캐시 이름이 글꼴 변수와 겹치는 일은 없어야 하지만, 겹치더라도
  // 사람이 고른 글꼴이 이긴다.
  if (paletteOf(state.theme) !== DERIVED_PALETTE) {
    retireThemeCache(root, options.storage);
  }
  applyUserFonts(state, target);
}

// ---- 저장된 선택 -------------------------------------------------------------

function readStorage(): AppearanceState {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_APPEARANCE;
    return readWebAppearance({
      v2: localStorage.getItem(APPEARANCE_STORAGE_KEY),
      v1: localStorage.getItem(APPEARANCE_STORAGE_KEY_V1),
      legacyScheme: localStorage.getItem(THEME_STORAGE_KEY),
    });
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeStorage(state: AppearanceState): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearance(state));
  } catch {
    // 저장이 막힌 브라우저(프라이빗 모드, 임베디드 웹뷰 정책): 고른 것은 이 탭이
    // 살아 있는 동안 유지되고 새로고침하면 기본값으로 돌아간다. 그 외에는 아무것도
    // 나빠지지 않으므로 사람에게 알릴 실패가 아니다.
  }
}

let appearance: AppearanceState = readStorage();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 모든 쓰기의 길. 정규 형태로 맞추고, 달라진 것이 없으면 아무것도 하지 않고, 저장 → 적용 → 구독자
 * 순서로 간다. 테마·신호가 바뀌면 부트 캐시를 즉시 비운다(다음 부팅 첫 프레임에 지난 테마의
 * 색이 번쩍이지 않게; 파생 엔진은 새 변수를 꽂은 뒤 다시 쓴다).
 */
function commit(next: AppearanceState): void {
  const prev = appearance;
  const normalized = normalizeAppearance(next);
  if (serializeAppearance(normalized) === serializeAppearance(prev)) return;
  appearance = normalized;
  writeStorage(normalized);
  applyAppearance(normalized);
  if (lookKeyOf(prev) !== lookKeyOf(normalized)) dropThemeCache();
  notify();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTheme(): ThemeChoice {
  return appearance.scheme;
}

/** 옛 액센트 id(ADR-0174). 신호가 프리셋이면 그 id, 아니면 기본(새벽). */
export function getAccent(): AccentId {
  return accentOfSignal(appearance.signal);
}

export function getAppearance(): AppearanceState {
  return appearance;
}

export function getThemeRef(): ThemeRef {
  return appearance.theme;
}

export function getFontSans(): string | undefined {
  return appearance.fontSans;
}

export function getFontMono(): string | undefined {
  return appearance.fontMono;
}

/**
 * 레코드의 일부를 바꾼다. 이후 이슈(테마 갤러리·글자 크기·밀도·스레드 배치·유리·배경)가 이
 * 파일을 열지 않고 자기 필드를 저장하는 길이다. 정규화·비교·저장·적용·구독 알림은 `commit`이
 * 맡으므로 호출자는 값만 넘긴다. 달라진 것이 없으면 아무 일도 없다.
 */
export function updateAppearance(patch: Partial<Omit<AppearanceState, "v">>): void {
  commit({ ...appearance, ...patch });
}

/** 고른 스킴을 저장하고 화면에 바로 적용한다. 저장 버튼이 없는 설정이다. */
export function setTheme(next: ThemeChoice): void {
  updateAppearance({ scheme: normalizeThemeChoice(next) });
}

/** 고른 테마 참조를 저장하고 적용한다(갤러리는 AP-1b). 모르는 값은 새벽하늘이다. */
export function setThemeRef(next: ThemeRef): void {
  updateAppearance({ theme: normalizeThemeRef(next) });
}

/** 고른 액센트를 저장하고 화면에 바로 적용한다. 기본(새벽)으로 되돌리는 길도 여기. */
export function setAccent(next: AccentId): void {
  updateAppearance({ signal: signalOfAccent(normalizeAccentId(next)) });
}

/**
 * 글꼴 이름을 저장하고 바로 적용한다. 빈 값·허용 밖 값은 「기본」으로 읽는다(호출자가
 * 먼저 `parseFontName`으로 사람에게 거절 이유를 말한다). 한 칸만 바꿔도 다른 칸은 그대로다.
 */
export function setUserFonts(next: { fontSans?: string | null; fontMono?: string | null }): void {
  const patch: Partial<Omit<AppearanceState, "v">> = {};
  if ("fontSans" in next) patch.fontSans = normalizeFontName(next.fontSans);
  if ("fontMono" in next) patch.fontMono = normalizeFontName(next.fontMono);
  updateAppearance(patch);
}

/** 두 칸 모두 시스템 서체로. */
export function resetUserFonts(): void {
  setUserFonts({ fontSans: null, fontMono: null });
}

/**
 * 첫 렌더보다 먼저 (main.tsx). 평소에는 theme-boot.js가 이미 붙여 둔 스탬프를
 * 그대로 다시 쓰는 무해한 반복이고, 그 스크립트가 오지 못했을 때는 이것이 유일한
 * 적용이다.
 */
export function initTheme(): void {
  applyAppearance(appearance);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

export function useAccentId(): AccentId {
  return useSyncExternalStore(subscribeTheme, getAccent, getAccent);
}

export function useFontSans(): string | undefined {
  return useSyncExternalStore(subscribeTheme, getFontSans, getFontSans);
}

export function useFontMono(): string | undefined {
  return useSyncExternalStore(subscribeTheme, getFontMono, getFontMono);
}

/** 레코드 전체. `commit`이 바뀔 때만 새 객체가 되므로 스냅샷으로 안전하다. */
export function useAppearance(): AppearanceState {
  return useSyncExternalStore(subscribeTheme, getAppearance, getAppearance);
}

export function useThemeRef(): ThemeRef {
  return useSyncExternalStore(subscribeTheme, getThemeRef, getThemeRef);
}

/** 시험이 저장소와 모듈 상태를 같은 자리에서 다시 읽게 한다. */
export function reloadAppearanceForTest(): void {
  appearance = readStorage();
  applyAppearance(appearance);
  notify();
}

// ---- 지금 이 기기의 시스템은 어느 쪽인가 -------------------------------------
// "시스템 설정 따르기"를 고른 사람에게 그 문장이 지금 무엇을 뜻하는지 말해 주기
// 위한 값이다. 구독하는 이유는 그 답이 앱이 떠 있는 동안 바뀔 수 있기 때문이다
// (macOS의 일몰 자동 전환). 신호원은 브라우저 미디어 질의와, 데스크탑에서는 네이티브 창
// 이벤트다(`systemScheme.ts`). 미디어 질의 문자열은 이 파일에만 둔다.

const DARK_QUERY = "(prefers-color-scheme: dark)";

function darkMedia(): MediaLike | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia(DARK_QUERY);
}

// 네이티브 신호원은 데스크탑 셸에서만 건다. 브라우저 탭은 미디어 질의만 듣는다(AP-1a AC 7).
// 셸 판정과 신호원은 구독하는 순간에 읽는다(불러오는 순간이 아니라): 이 파일은 앱 거의 모든 곳이
// 가져가므로 모듈 로드 중에 `@/lib/tauri`를 건드리면 그것을 부분 모의한 시험이 로드 중에 터진다.
const system = createSystemScheme({
  media: darkMedia,
  native: (handler) => onSystemThemeChanged(handler),
  nativeEnabled: () => isDesktop(),
});

export function systemScheme(): "light" | "dark" {
  return system.get();
}

/** 구독만 필요한 곳(React 밖)과 시험이 쓴다. `useSystemScheme`가 같은 구독을 연다. */
export const subscribeSystemScheme = system.subscribe;

export function useSystemScheme(): "light" | "dark" {
  return useSyncExternalStore(system.subscribe, system.get, system.get);
}
