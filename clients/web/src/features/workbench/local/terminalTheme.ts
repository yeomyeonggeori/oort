import { useSyncExternalStore } from "react";
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEME_ENTRY,
  parseTerminalThemePrefs,
  serializeTerminalThemePrefs,
  type TerminalThemeChoice,
} from "@momo/core/features/workbench/terminalTheme";

// =============================================================================
// 로컬 터미널 칸의 색 테마 (#2849). 설정 › 터미널이 고르고, 열려 있는 칸이
// 바로 따라 바뀐다. 둘이 같은 값을 보도록 모듈 저장소 하나에 둔다(dockState.ts와
// 같은 이유).
//
// 이 파일이 아는 색은 없다. 칸은 `data-term-scheme`을 찍고, tokens.css의
// `--term-*` 쌍(`light-dark()`)이 그 스킴으로 갈린다. 「앱 테마 따르기」는 아무것도
// 찍지 않아 루트의 스킴을 물려받는다.
// =============================================================================

export type { TerminalThemeChoice } from "@momo/core/features/workbench/terminalTheme";

export interface TerminalThemeState {
  theme: TerminalThemeChoice;
  /** 고른 값을 이 기기에 저장하지 못했다. */
  storageFailed: boolean;
}

function readTheme(): TerminalThemeState {
  try {
    const prefs = parseTerminalThemePrefs(window.localStorage.getItem(TERMINAL_THEME_ENTRY));
    return { theme: prefs?.theme ?? DEFAULT_TERMINAL_THEME, storageFailed: false };
  } catch {
    return { theme: DEFAULT_TERMINAL_THEME, storageFailed: true };
  }
}

let state: TerminalThemeState = readTheme();
const listeners = new Set<() => void>();

export function subscribeTerminalTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function terminalThemeSnapshot(): TerminalThemeState {
  return state;
}

export function useTerminalTheme(): TerminalThemeState {
  return useSyncExternalStore(subscribeTerminalTheme, terminalThemeSnapshot, terminalThemeSnapshot);
}

export function setTerminalTheme(theme: TerminalThemeChoice) {
  let storageFailed = false;
  try {
    window.localStorage.setItem(TERMINAL_THEME_ENTRY, serializeTerminalThemePrefs({ v: 1, theme }));
  } catch {
    storageFailed = true;
  }
  if (theme === state.theme && storageFailed === state.storageFailed) return;
  state = { theme, storageFailed };
  listeners.forEach((l) => l());
}

/**
 * 칸 틀에 찍을 스킴. 「앱 테마 따르기」는 찍지 않는다(루트의 `color-scheme`을
 * 물려받는다). tokens.css `[data-term-scheme]` 규칙이 읽는 이름이다.
 */
export function terminalSchemeAttribute(theme: TerminalThemeChoice): "dark" | "light" | undefined {
  return theme === "app" ? undefined : theme;
}

/** 시험용. 저장소를 다시 읽는다. */
export function resetTerminalThemeForTest() {
  state = readTheme();
  listeners.forEach((l) => l());
}
