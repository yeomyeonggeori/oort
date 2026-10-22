import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 테마 갤러리 CSS 조각의 계약 (AP-1b #4188, 청사진 §5.3-c). 실제 렌더는 캡처(`capture-4188.mjs`가 타일·썸네일의 제목
// `display`를 기록한다)가 보고, 이 시험은 규칙이 조용히 사라지는 것을 막는다.
// =============================================================================

const css = readFileSync(new URL("./theme-gallery.css", import.meta.url), "utf8");
const preview = readFileSync(new URL("../../features/settings/shell/ThemePreviewCard.tsx", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

/** `selector { ... }` 본문. 중첩 블록이 없는 단순 규칙만 읽는다. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} 규칙이 없다`).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf("}", at));
}

describe("미니 앱 제목: 말줄임이 아니라 뺀다", () => {
  it("타일 틀과 접힌 행 썸네일 틀이 컨테이너다 (큰 미리보기 카드는 아니다)", () => {
    const at = css.indexOf(".theme-tile-frame,\n.theme-style-thumb {");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf("}", at))).toContain("container-type: inline-size");
  });

  it("11rem 미만이면 제목 글자를 뺀다", () => {
    const at = css.indexOf("@container (width < 11rem) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toContain(".theme-preview-title");
    expect(block).toContain("display: none");
  });

  it("미리보기 층의 제목 글자가 그 클래스를 달고 있다", () => {
    expect(preview).toMatch(/className="theme-preview-title [^"]*"/);
  });

  it("기준 폭: 갤러리 타일(약 140~160)은 아래, 접힌 행 썸네일(200)은 위에 놓인다", () => {
    const tileMin = Number(/--spacing-theme-tile-min:\s*(\d+)px/.exec(tokens)![1]);
    const gridMin = tileMin * Number(/minmax\(calc\(var\(--spacing-theme-tile-min\) \* ([0-9.]+)\), 1fr\)/.exec(css)![1]);
    const thumb = tileMin * Number(/\.theme-style-thumb \{\s*inline-size: calc\(var\(--spacing-theme-tile-min\) \* ([0-9.]+)\)/.exec(css)![1]);
    const threshold = 11 * 16;
    // 격자 열은 최소 폭부터 늘어난다(1fr). 설정 본문(720)에서 네 열이면 160, 폰(390)에서 두 열이면 약 140이다.
    expect(gridMin).toBeLessThan(threshold);
    expect(thumb).toBeGreaterThanOrEqual(threshold);
    expect(Math.round(gridMin)).toBe(136);
    expect(thumb).toBe(200);
  });
});

describe("격자·스크롤·페이드", () => {
  it("격자는 열 최소 폭 기준 auto-fill이다 (폰 두 열 · 데스크탑 네 열)", () => {
    expect(ruleBody(css, ".theme-gallery-grid")).toContain("repeat(auto-fill, minmax(");
  });

  it("스크롤 상한은 타일 최소 폭의 세 배이고 안에서만 스크롤한다", () => {
    const body = ruleBody(css, ".theme-gallery-scroll");
    expect(body).toContain("max-block-size: calc(var(--spacing-theme-tile-min) * 3)");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("overscroll-behavior: contain");
  });

  it("위아래 페이드는 mask-image다: 색 리터럴 없이 알파만 쓴다(currentcolor와 transparent)", () => {
    const body = ruleBody(css, ".theme-gallery-scroll");
    expect(body).toContain("mask-image: linear-gradient(");
    expect(body).toContain("currentcolor");
    expect(body).toContain("transparent");
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 주석은 무엇이든 말할 수 있다
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("고른 타일은 색만이 아니라 링과 굵은 이름으로 말한다", () => {
    expect(ruleBody(css, ".theme-tile[data-selected] .theme-tile-frame")).toContain("var(--ink)");
    expect(ruleBody(css, ".theme-tile[data-selected] .theme-tile-name")).toContain("font-weight: 600");
  });

  it("키보드 초점은 타일 틀 바깥 링이다 (:has(:focus-visible))", () => {
    expect(ruleBody(css, ".theme-tile:has(:focus-visible) .theme-tile-frame")).toContain("outline: 2px solid");
  });

  it("비어 있는 알림 자리는 간격을 먹지 않는다 (읽어 주는 영역은 늘 DOM에 있다)", () => {
    expect(css).toContain(".theme-gallery-notice:not(:empty)");
    expect(ruleBody(css, ".theme-gallery-region")).not.toContain("gap:");
  });
});
