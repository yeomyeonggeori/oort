import { useSyncExternalStore } from "react";

// =============================================================================
// 테마 선택 (U2 · 웹 모드 전환).
//
// 발단: tokens.css는 처음부터 두 스킴을 갖고 있었지만(`color-scheme: light dark`
// + `light-dark()`), 그것을 고르는 자리가 앱 안에 없었다. 라이트로 보고 싶은
// 사람은 OS 설정을 바꾸는 수밖에 없었고, 그것은 이 앱 하나 때문에 모든 앱의
// 밝기를 바꾸라는 말이다.
//
// **스탬프 문법은 새로 만들지 않았다.** tokens.css에 이미 있던 두 규칙이 정본이고,
// 지금까지는 캡처 하네스만 그것을 알고 있었다:
//
//     :root[data-theme="light"] { color-scheme: light; }
//     :root[data-theme="dark"]  { color-scheme: dark; }
//
// `light-dark()`는 그 요소에 적용된 `color-scheme`으로 갈리므로, 루트에 한 글자를
// 스탬프하는 것만으로 팔레트 전체가 한쪽으로 고정된다. 팔레트를 두 벌 갖지 않는다
// 는 tokens.css의 계약이 그대로 유지되고, 이 파일이 아는 색은 **하나도 없다**.
//
// 저장은 localStorage이고 키는 `momo.web.*` 관례를 따른다(serverBase·session·pwa와
// 같은 접두). 값은 세 개뿐이며 기본값은 언제나 "system"이다: 아무것도 고르지 않은
// 사람은 OS를 따르던 지금까지의 행동을 그대로 받는다.
//
// 첫 페인트는 이 모듈이 책임지지 않는다 — 못 한다. 번들은 defer이므로 여기가
// 실행될 때는 이미 한 프레임이 그려졌을 수 있고, 그 프레임이 반대 스킴이면 그것이
// 곧 FOUC다. 그 자리는 public/theme-boot.js(파서를 세우는 고전 스크립트)가 맡고,
// 이 모듈은 그것의 정본이자 **두 번째 방어선**이다: 그 파일이 오지 못한 경우
// (오프라인 콜드 스타트, 캐시 실패)에도 `initTheme()`이 같은 스탬프를 붙인다.
// =============================================================================

export type ThemeChoice = "system" | "light" | "dark";

/** 저장 위치. 동결층이므로 접두는 `momo.`로 남는다(oort 리브랜딩과 무관). */
export const THEME_STORAGE_KEY = "momo.web.theme.v1";

/** 루트에 찍는 이름. tokens.css의 `:root[data-theme=...]`가 읽는 그 이름이다. */
export const THEME_ATTRIBUTE = "data-theme";

/** 고정을 풀 때 되돌릴, 시스템을 따르던 때의 브라우저 크롬 색. */
export const SYSTEM_COLOR_ATTRIBUTE = "data-theme-color-system";

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

const THEME_COLOR_SELECTOR = "meta[name='theme-color'][media]";

/**
 * 선택을 문서에 적용한다. 두 가지를 같이 한다.
 *
 *   1. 루트 스탬프. 고정이면 `data-theme`, 시스템이면 그 속성의 제거.
 *   2. 브라우저 크롬(주소창·상태바) 색. index.html의 theme-color 두 줄은
 *      prefers-color-scheme으로 갈리므로, 앱만 고정하면 다크 앱 위에 라이트
 *      주소창이 남는다. 색을 다시 적지 않고 **고른 쪽 줄의 값을 두 줄에 복사**
 *      하고, 원래 값은 각 줄이 자기 속성에 들고 있다가 고정이 풀리면 되돌린다.
 *      그래서 팔레트는 계속 index.html 한 곳에만 있다.
 *
 * public/theme-boot.js가 첫 페인트 전에 하는 일과 같다. 두 벌인 것은 순서 때문
 * 이지 선택이 아니고, 둘이 어긋나지 않는지는 theme.test.ts가 그 파일을 읽어서
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

// ---- 저장된 선택 -------------------------------------------------------------

function readStorage(): ThemeChoice {
  try {
    if (typeof localStorage === "undefined") return "system";
    return normalizeThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function writeStorage(choice: ThemeChoice): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // 저장이 막힌 브라우저(프라이빗 모드, 임베디드 웹뷰 정책): 고른 것은 이 탭이
    // 살아 있는 동안 유지되고 새로고침하면 시스템으로 돌아간다. 그 외에는 아무것도
    // 나빠지지 않으므로 사람에게 알릴 실패가 아니다.
  }
}

let choice: ThemeChoice = readStorage();
const listeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTheme(): ThemeChoice {
  return choice;
}

/** 고른 것을 저장하고 화면에 바로 적용한다. 저장 버튼이 없는 설정이다. */
export function setTheme(next: ThemeChoice): void {
  if (next === choice) return;
  choice = next;
  writeStorage(next);
  applyTheme(next);
  for (const listener of listeners) listener();
}

/**
 * 첫 렌더보다 먼저 (main.tsx). 평소에는 theme-boot.js가 이미 붙여 둔 스탬프를
 * 그대로 다시 쓰는 무해한 반복이고, 그 스크립트가 오지 못했을 때는 이것이 유일한
 * 적용이다.
 */
export function initTheme(): void {
  applyTheme(choice);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

// ---- 지금 이 기기의 시스템은 어느 쪽인가 -------------------------------------
// "시스템 설정 따르기"를 고른 사람에게 그 문장이 지금 무엇을 뜻하는지 말해 주기
// 위한 값이다. 구독하는 이유는 그 답이 앱이 떠 있는 동안 바뀔 수 있기 때문이다
// (macOS의 일몰 자동 전환).

const DARK_QUERY = "(prefers-color-scheme: dark)";

function darkMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia(DARK_QUERY);
}

export function systemScheme(): "light" | "dark" {
  return darkMedia()?.matches ? "dark" : "light";
}

function subscribeSystemScheme(listener: () => void): () => void {
  const media = darkMedia();
  if (!media) return () => {};
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useSystemScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeSystemScheme, systemScheme, systemScheme);
}
