// =============================================================================
// 사용자 글꼴 (#3774 단계 2, 설정 > 모양 > 글꼴).
//
// 기본은 시스템 서체다. 앱은 글꼴을 번들하지 않고, 사람이 자기 기기에 설치한 글꼴의
// **이름**만 적는다(VS Code의 font family 설정과 같은 모양). 본문과 코드, 두 칸까지다.
//
// 안전 규칙은 두 개다.
//   1. 이름은 허용 목록으로만 받는다. 글자·숫자·공백·`. _ + & -` 밖의 것(`; { } ( ) ' " \ / < >`,
//      쉼표, 개행)은 값으로 들어가지 못한다. CSS에 닿는 문자열이므로 걸러 쓰는 것이 아니라
//      **거절**한다: 조용히 깎아 낸 이름은 사람이 적지 않은 글꼴을 가리킨다.
//   2. 적용되는 font-family는 언제나 `"이름", var(--font-sans)`(코드는 `--font-mono`)다.
//      이름이 없거나 깨져도 CSS만으로 시스템 서체로 돌아간다.
//
// 적용은 CSSOM(`style.setProperty`)이다. 이 코드베이스는 인라인 style 속성을 쓰지 않는다
// (SKILL §1). setProperty는 CSP 위반이 아니고 프리플라이트 `inline_style`(`style=`)에도
// 걸리지 않는다. 변수를 읽는 규칙은 tokens.css 끝의 `:root[data-font-*]` 두 곳이다.
// public/theme-boot.js가 첫 페인트 전에 같은 일을 하고, theme.test.ts가 둘을 맞춰 본다.
// =============================================================================

import {
  FONT_NAME_MAX,
  FONT_NAME_PATTERN,
  normalizeFontName,
  parseFontName,
  type FontNameResult,
} from "@momo/core/design/fontName";

// 이름 규칙(허용 목록·길이 상한·거절 이유)은 core `fontName.ts`로 옮겼다(AP-1a #4186): 외양
// 레코드 v2가 글꼴을 같이 들고 가야 해서 레코드를 읽는 core가 같은 규칙으로 값을 거른다.
// 이 파일은 그것을 다시 내보내고 **적용**(CSSOM 변수 + 속성)만 맡는다.
export { FONT_NAME_MAX, FONT_NAME_PATTERN, normalizeFontName, parseFontName };
export type { FontNameResult };

export const FONT_SANS_VARIABLE = "--font-user-sans";
export const FONT_MONO_VARIABLE = "--font-user-mono";
export const FONT_SANS_ATTRIBUTE = "data-font-sans";
export const FONT_MONO_ATTRIBUTE = "data-font-mono";

/** `"이름", var(--font-sans)`. 이름은 허용 목록을 통과한 값이라 따옴표를 닫을 문자가 없다. */
export function fontStack(name: string, fallbackVariable: "--font-sans" | "--font-mono"): string {
  return `"${name}", var(${fallbackVariable})`;
}

interface FontRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
}

export interface FontDocument {
  documentElement: FontRoot;
}

export type FontChoice = { fontSans?: string; fontMono?: string };

function applyOne(
  root: FontRoot,
  name: string | undefined,
  variable: string,
  attribute: string,
  fallback: "--font-sans" | "--font-mono"
): void {
  const safe = normalizeFontName(name);
  if (safe === undefined) {
    root.style.removeProperty(variable);
    root.removeAttribute(attribute);
    return;
  }
  // design-preflight-allow: 값은 허용 목록을 통과한 이름과 var() 폴백뿐이고, 인라인 style
  // 속성이 아니라 CSSOM 변수 한 개다(상단 주석, tokens.css 끝의 data-font-* 규칙이 읽는다).
  root.style.setProperty(variable, fontStack(safe, fallback));
  root.setAttribute(attribute, "");
}

/** 고른 글꼴을 문서에 적용한다. 값이 없으면 변수와 속성을 지워 시스템 서체로 돌린다. */
export function applyUserFonts(choice: FontChoice, doc?: FontDocument): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  if (!target) return;
  applyOne(target.documentElement, choice.fontSans, FONT_SANS_VARIABLE, FONT_SANS_ATTRIBUTE, "--font-sans");
  applyOne(target.documentElement, choice.fontMono, FONT_MONO_VARIABLE, FONT_MONO_ATTRIBUTE, "--font-mono");
}

// ---- 설치된 글꼴 목록 (Local Font Access) ------------------------------------
// Chromium 계열의 `window.queryLocalFonts`는 보안 컨텍스트, 사용자 제스처, 권한이 필요하다.
// WKWebView(Tauri macOS)에는 없다. 없는 곳에서는 목록을 약속하지 않고 입력만 남긴다.

export type InstalledFontsResult =
  | { status: "ok"; families: string[] }
  | { status: "unsupported" }
  | { status: "denied" }
  | { status: "error" };

interface LocalFontData {
  family?: unknown;
}

interface LocalFontHost {
  queryLocalFonts?: () => Promise<readonly LocalFontData[]>;
}

export function canQueryLocalFonts(host: LocalFontHost | undefined = globalThis as LocalFontHost): boolean {
  return typeof host?.queryLocalFonts === "function";
}

/** 사용자 제스처(버튼 클릭) 안에서 부른다. 이름은 허용 목록을 통과한 것만, 중복 없이, 가나다순. */
export async function loadInstalledFontFamilies(
  host: LocalFontHost | undefined = globalThis as LocalFontHost
): Promise<InstalledFontsResult> {
  const query = host?.queryLocalFonts;
  if (typeof query !== "function") return { status: "unsupported" };
  try {
    const fonts = await query.call(host);
    const seen = new Set<string>();
    for (const font of fonts) {
      const name = normalizeFontName(font.family);
      if (name !== undefined) seen.add(name);
    }
    return { status: "ok", families: [...seen].sort((a, b) => a.localeCompare(b)) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "NotAllowedError" || name === "SecurityError"
      ? { status: "denied" }
      : { status: "error" };
  }
}
