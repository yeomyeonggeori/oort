import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLASS_VARS, GLASS_VAR_ROLES, firstPartyGlassSources, glassVariables } from "@momo/core/design/glass";

// AP-3(#4190): `glass.css`의 문자열 계약. 렌더가 맞는지는 `glass.browser.test.ts`가 엔진으로 재고, 이 파일은
// 브라우저 없이도 도는 절반이다: 식이 `tokens.css`와 어긋나지 않는지, CSS가 읽는 변수 이름이 core가 꽂는 이름과 같은지,
// 색 리터럴·외부 주소가 없는지, 접근성 갈래가 서 있는지.

const HERE = dirname(fileURLToPath(import.meta.url));
const GLASS = readFileSync(join(HERE, "glass.css"), "utf8");
const TOKENS = readFileSync(join(HERE, "..", "tokens.css"), "utf8");

/** 주석을 걷은 규칙 본문. */
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const GLASS_CODE = code(GLASS);

/** 공백을 한 칸으로 접는다(줄바꿈이 다른 같은 식을 같은 문자열로 읽으려고). */
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("glass.css 문자열 계약", () => {
  it("바닥 그라데이션 식은 tokens.css `app-shell`과 같다(160°, 정지점 0·42·100%). 색만 반투명이다", () => {
    const base = squash(TOKENS).match(
      /--shell-layer-canvas: linear-gradient\( 160deg, var\(--canvas-top\) 0%, var\(--canvas-mid\) 42%, var\(--canvas-bottom\) 100% \);/
    );
    expect(base, "tokens.css 층 변수의 식이 바뀌었다. glass.css도 같은 식으로 옮긴다").not.toBeNull();
    const glass = squash(GLASS_CODE).match(
      /--shell-layer-canvas: linear-gradient\( 160deg, var\(--glass-canvas-top\) 0%, var\(--glass-canvas-mid\) 42%, var\(--glass-canvas-bottom\) 100% \);/
    );
    expect(glass, "glass.css의 바닥 식이 tokens.css와 어긋났다").not.toBeNull();
    // 세 정지점이 모두 같은 α 변수로 낮춰진다.
    for (const stop of ["top", "mid", "bottom"]) {
      expect(squash(GLASS_CODE)).toContain(
        `--glass-canvas-${stop}: color-mix(in srgb, var(--canvas-${stop}) var(--glass-tint, 100%), transparent);`
      );
    }
  });

  it("tokens.css를 고치지 않고 AP-1a가 쪼갠 층 변수만 바꾼다: 층 변수 둘과 바닥 색만 선언한다", () => {
    const shell = GLASS_CODE.match(/:root\[data-glass\] \.app-shell \{([\s\S]*?)\n {2}\}/);
    expect(shell).not.toBeNull();
    const props = [...(shell?.[1] ?? "").matchAll(/^\s*(--[\w-]+|[a-z-]+):/gm)].map((m) => m[1]);
    expect(props.filter((p) => !p.startsWith("--glass-"))).toEqual([
      "--shell-layer-canvas",
      "--shell-layer-band",
      "background-color",
    ]);
    // 배경화면 층(AP-4의 것)은 건드리지 않는다.
    expect(GLASS_CODE).not.toContain("--shell-layer-wallpaper");
  });

  it("CSS가 읽는 `--glass-*` 변수는 core가 꽂는 이름이거나 이 조각이 스스로 정의한 이름이다(이름 어긋남 0)", () => {
    const emitted = new Set(Object.keys(glassVariables(firstPartyGlassSources("dawnsky"), undefined)));
    const defined = new Set([...GLASS_CODE.matchAll(/^\s*(--glass-[\w-]+):/gm)].map((m) => m[1]));
    const used = new Set([...GLASS_CODE.matchAll(/var\((--glass-[\w-]+)/g)].map((m) => m[1]));
    for (const name of used) {
      expect(emitted.has(name) || defined.has(name), `${name}은 core도 CSS도 정의하지 않는다`).toBe(true);
    }
  });

  it("core가 꽂는 역할 변수 열여덟 개는 전부 어느 규칙이 읽는다(죽은 변수 0)", () => {
    for (const role of GLASS_VAR_ROLES) {
      for (const name of [GLASS_VARS.role(role), GLASS_VARS.bandRole(role)]) {
        expect(GLASS_CODE, `${name}을 읽는 규칙이 없다`).toContain(`var(${name})`);
      }
    }
    expect(GLASS_CODE).toContain(`var(${GLASS_VARS.tintLight}`);
    expect(GLASS_CODE).toContain(`var(${GLASS_VARS.tintDark}`);
  });

  it("역할 변수는 사이드바·타이틀바·설정 목록에만 묶는다(본문 판의 글자는 보정하지 않는다)", () => {
    const scopes = [...GLASS_CODE.matchAll(/(:root\[data-glass\][^{}]*)\{[^{}]*--ink-muted:/g)].map((m) => squash(m[1]));
    expect(scopes.join(" ")).toContain(".sidebar-drawer");
    expect(scopes.join(" ")).toContain(".settings-nav");
    expect(scopes.join(" ")).toContain(".app-titlebar");
    expect(scopes.join(" ")).not.toMatch(/\.app-pane|main|\.settings-pane|body/);
  });

  it("셸이 있을 때만 body를 비운다(`:has(.app-shell)`): 로그인 전 화면은 body가 --pane을 그대로 칠한다", () => {
    expect(GLASS_CODE).toMatch(/:root\[data-glass\] body:has\(\.app-shell\) \{\s*background: transparent;\s*\}/);
    expect(GLASS_CODE).not.toMatch(/:root\[data-glass\] body \{/);
    expect(GLASS_CODE).not.toMatch(/:root\[data-glass\] \{[^}]*background/);
  });

  it("내 작업 탭의 본문은 유리 아래에서 `--pane` 면을 깐다", () => {
    expect(squash(GLASS_CODE)).toContain(
      ":root[data-glass] .app-shell[data-work-rail] > main { background-color: var(--pane); }"
    );
  });

  it("접근성 갈래: 투명도 줄이기·대비 높이기에서 revert-layer로 불투명 바닥으로 돌아간다(식을 복사하지 않는다)", () => {
    const block = squash(GLASS_CODE).match(
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{(.*)\}$/
    );
    expect(block, "접근성 블록이 없다").not.toBeNull();
    const body = block?.[1] ?? "";
    for (const property of ["--shell-layer-canvas", "--shell-layer-band", "background-color", "background"]) {
      expect(body, property).toContain(`${property}: revert-layer;`);
    }
    // 쉼표 목록이다: 한쪽 질의를 모르는 엔진(WKWebView는 앞의 질의를 구현하지 않는다)도 나머지는 읽는다.
    expect(GLASS_CODE).not.toMatch(/not \(prefers-reduced-transparency/);
  });

  it("데스크탑 폭(600px 이상)에서만 셸을 칠한다(폰 폭 셸은 판이 창 자체다)", () => {
    expect(squash(GLASS_CODE)).toContain("@media (width >= 600px) { :root[data-glass] .app-shell {");
  });

  it("스킴별 색조 불투명도: pane과 같은 속성·질의 짝으로 고른다(`light-dark()`는 색만 받는다)", () => {
    const flat = squash(GLASS_CODE);
    expect(flat).toContain(":root[data-glass] { --glass-tint: var(--glass-tint-light, 100%); }");
    expect(flat).toContain(':root[data-glass][data-theme="dark"] { --glass-tint: var(--glass-tint-dark, 100%); }');
    expect(flat).toContain(
      '@media (prefers-color-scheme: dark) { :root[data-glass]:not([data-theme="light"]) { --glass-tint: var(--glass-tint-dark, 100%); } }'
    );
    // 변수가 아직 없으면 불투명(100%)이다: 속성이 변수보다 먼저 서는 일이 있어도 투명 바닥이 되지 않는다.
    expect(GLASS_CODE).not.toMatch(/var\(--glass-tint\)/);
  });

  it("색 리터럴·외부 주소·인라인 투명 규칙이 없다(인라인 투명은 JS가 CSSOM으로 꽂는다)", () => {
    expect(GLASS_CODE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(GLASS_CODE).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(GLASS_CODE).not.toMatch(/url\(/);
    expect(GLASS_CODE).not.toMatch(/@import/);
  });

  it("tokens.css가 이 조각을 가져온다(AP-1a가 깔아 둔 import 한 줄, 이 이슈는 tokens.css를 고치지 않는다)", () => {
    expect(TOKENS).toContain('@import "./appearance/glass.css";');
  });
});
