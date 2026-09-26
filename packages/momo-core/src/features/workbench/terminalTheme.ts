// =============================================================================
// 로컬 터미널 칸의 색 테마 선택 (#2849).
//
// 칸의 기본은 어두운 터미널이다. 앱이 라이트여도 칸은 어둡다. 셸 프롬프트
// (powerline 계열)와 TUI 대부분이 어두운 바탕을 전제로 색을 고르기 때문이다
// (VS Code·Warp·Claude 데스크탑과 같은 관례). 칸 테두리와 머리 줄은 앱 테마를
// 따른다. 설정 › 터미널에서 「어둡게(기본) / 앱 테마 따르기 / 밝게」를 고른다.
//
// 선택은 이 기기에 둔다(ADR-0174 「외양=이 기기」). `dockStore.ts`와 같은
// 모양이다. 저장소는 만지지 않고, 원문을 읽고 쓸 문자열을 만든다. 모르는 값은
// `null`로 읽고 호스트는 기본값(어둡게)을 쓴다.
// =============================================================================

/** 저장소 항목 이름. 접미사가 `_KEY`가 아닌 이유는 layoutStore.ts와 같다. */
export const TERMINAL_THEME_ENTRY = "momo.web.workbench.terminal-theme.v1";

export const TERMINAL_THEME_CHOICES = ["dark", "app", "light"] as const;

export type TerminalThemeChoice = (typeof TERMINAL_THEME_CHOICES)[number];

export const DEFAULT_TERMINAL_THEME: TerminalThemeChoice = "dark";

export function isTerminalThemeChoice(value: unknown): value is TerminalThemeChoice {
  return typeof value === "string" && (TERMINAL_THEME_CHOICES as readonly string[]).includes(value);
}

export interface TerminalThemePrefs {
  v: 1;
  theme: TerminalThemeChoice;
}

export function serializeTerminalThemePrefs(prefs: TerminalThemePrefs): string {
  return JSON.stringify(prefs);
}

export function parseTerminalThemePrefs(raw: string | null | undefined): TerminalThemePrefs | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !isTerminalThemeChoice(record.theme)) return null;
  return { v: 1, theme: record.theme };
}
