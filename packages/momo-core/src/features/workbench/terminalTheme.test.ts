import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_THEME_CHOICES,
  parseTerminalThemePrefs,
  serializeTerminalThemePrefs,
} from "./terminalTheme";

describe("로컬 터미널 색 테마 선택 (#2849)", () => {
  it("기본은 어두운 터미널이다(앱이 라이트여도)", () => {
    expect(DEFAULT_TERMINAL_THEME).toBe("dark");
    expect(TERMINAL_THEME_CHOICES[0]).toBe("dark");
  });

  it("고른 값을 왕복한다", () => {
    for (const theme of TERMINAL_THEME_CHOICES) {
      expect(parseTerminalThemePrefs(serializeTerminalThemePrefs({ v: 1, theme }))).toEqual({ v: 1, theme });
    }
  });

  it("모르는 값·깨진 원문·옛 판은 null로 읽는다(호스트가 기본값을 쓴다)", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "dark",
      "{",
      "[]",
      JSON.stringify({ v: 2, theme: "dark" }),
      JSON.stringify({ v: 1, theme: "solarized" }),
      JSON.stringify({ v: 1 }),
    ]) {
      expect(parseTerminalThemePrefs(raw), String(raw)).toBeNull();
    }
  });
});
