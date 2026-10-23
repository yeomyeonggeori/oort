/* eslint-disable no-restricted-syntax -- 색 문법을 가르는 파서의 시험이라 색 리터럴이 본문이다(각 줄에 design-preflight-allow). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODES, THEME_IDS, THEMES } from "@momo/core/design/themes";
import { wallpaperTokensOf } from "@momo/core/design/wallpaper";
import { parseColorPair, readDomTokens } from "./domTokens";

// =============================================================================
// 화면에 칠해진 색을 읽는다 (AP-4 #4191). 산수의 입력은 표가 아니라 **루트에 칠해진 변수**다. 그 읽기가 첫 파티 세
// 테마의 실제 CSS(생성 팔레트·`tokens.css`의 `:root`)와 core 표 양쪽에서 같은 값을 읽는지를 노드에서 잰다.
// 진짜 브라우저에서 `getComputedStyle`이 같은 문자열을 돌려주는지는 캡처 스크립트의 단정(`capture-4191.mjs`)이 잰다.
// =============================================================================

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DESIGN = `${HERE}../`;

describe("parseColorPair", () => {
  it("색 하나는 두 모드에 같은 값이다", () => {
    expect(parseColorPair("#a1b2c3")).toEqual(["#a1b2c3", "#a1b2c3"]); // design-preflight-allow
    expect(parseColorPair("  #A1B2C3\n")).toEqual(["#A1B2C3", "#A1B2C3"]); // design-preflight-allow
  });

  it("light-dark(색, 색)는 [라이트, 다크]다 (공백 변형을 받는다)", () => {
    expect(parseColorPair("light-dark(#f5f1e8, #161a25)")).toEqual(["#f5f1e8", "#161a25"]); // design-preflight-allow
    expect(parseColorPair("light-dark(#f5f1e8,#161a25)")).toEqual(["#f5f1e8", "#161a25"]); // design-preflight-allow
    expect(parseColorPair("light-dark( #f5f1e8 ,\n #161a25 )")).toEqual(["#f5f1e8", "#161a25"]); // design-preflight-allow
  });

  it("읽을 수 없는 모양은 null이다: 이름 색, 함수형 색, 짧은 hex, 빈 값, 덧붙은 값", () => {
    for (const bad of ["", "red", "rgb(1,2,3)", "#fff", "#12345", "light-dark(red, blue)", "light-dark(#fff, #000)", "#112233 #445566", "var(--x)", "light-dark(#112233, #445566, #778899)"]) { // design-preflight-allow
      expect([bad, parseColorPair(bad)]).toEqual([bad, null]);
    }
  });
});

/** CSS 원문에서 한 규칙 블록의 `--이름: 값;` 선언을 읽어 `getPropertyValue`처럼 답하는 함수. */
function readerOf(css: string, selector: string): (name: string) => string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const table = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) table.set(match[1], match[2].trim());
  return (name) => table.get(name) ?? "";
}

describe("실제 CSS에서 읽은 값이 core 표와 같다 (여섯 조합)", () => {
  const sources = {
    dawnsky: { css: readFileSync(`${DESIGN}tokens.css`, "utf8"), selector: ":root {" },
    graphite: { css: readFileSync(`${DESIGN}themes/palettes/graphite.css`, "utf8"), selector: ':root[data-palette="graphite"]' },
    noeul: { css: readFileSync(`${DESIGN}themes/palettes/noeul.css`, "utf8"), selector: ':root[data-palette="noeul"]' },
  } as const;

  it.each(THEME_IDS)("%s: 산수의 입력이 core 표의 것과 한 칸씩 같다 (소문자 hex)", (theme) => {
    const { css, selector } = sources[theme];
    const tokens = readDomTokens(readerOf(css, selector));
    expect(tokens, `${theme}: 읽지 못한 변수가 있다`).not.toBeNull();
    for (const mode of MODES) {
      const want = wallpaperTokensOf(THEMES[theme][mode]);
      const got = tokens!.byMode[mode];
      const lower = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v.toLowerCase()]));
      expect([theme, mode, got.canvas.toLowerCase(), got.ink.toLowerCase(), got.onPrimary.toLowerCase(), got.onSignal.toLowerCase()]).toEqual([
        theme, mode, want.canvas.toLowerCase(), want.ink.toLowerCase(), want.onPrimary.toLowerCase(), want.onSignal.toLowerCase(),
      ]);
      expect([theme, mode, lower(got.roles)]).toEqual([theme, mode, lower(want.roles)]);
    }
  });

  it("띠가 있는 테마(노을띠)만 hasBand가 참이다", () => {
    for (const theme of THEME_IDS) {
      const { css, selector } = sources[theme];
      expect([theme, readDomTokens(readerOf(css, selector))!.hasBand]).toEqual([theme, theme === "noeul"]);
    }
  });
});

describe("읽지 못한 변수는 배경화면을 쓰지 않는 쪽으로 닫는다", () => {
  const { css, selector } = { css: readFileSync(`${DESIGN}tokens.css`, "utf8"), selector: ":root {" };
  const full = readerOf(css, selector);

  it("필수 변수 하나가 비어도 null이다 (산수가 틀린 색으로 보장하는 척하지 않는다)", () => {
    for (const name of ["--canvas-mid", "--ink", "--on-primary", "--on-signal", "--ink-muted", "--signal-text", "--agent", "--ok", "--warn", "--danger", "--icon", "--signal"]) {
      expect([name, readDomTokens((n) => (n === name ? "" : full(n)))]).toEqual([name, null]);
    }
  });

  it("읽을 수 없는 모양(함수형 색)이 하나라도 있으면 null이다", () => {
    expect(readDomTokens((n) => (n === "--agent" ? "rgb(10, 20, 30)" : full(n)))).toBeNull(); // design-preflight-allow
  });
});
