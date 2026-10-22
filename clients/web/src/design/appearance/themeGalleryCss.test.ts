import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 테마 갤러리 CSS 조각의 계약 (AP-1b #4188, 청사진 §5.3-c). 실제 렌더는 캡처(`capture-4188.mjs`가 타일·썸네일의 제목
// `display`를 기록한다)가 보고, 이 시험은 규칙이 조용히 사라지는 것을 막는다.
// =============================================================================

const css = readFileSync(new URL("./theme-gallery.css", import.meta.url), "utf8");
const preview = readFileSync(new URL("../../features/settings/shell/ThemePreviewCard.tsx", import.meta.url), "utf8");
const tile = readFileSync(new URL("../../features/settings/appearance/ThemeTile.tsx", import.meta.url), "utf8");
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
    // 세 크기는 이름 있는 지역 변수다(`--theme-grid-column-min`·`--theme-thumb-width`·`--theme-grid-max-height`).
    const named = (name: string) => tileMin * Number(new RegExp(`${name}:\\s*calc\\(var\\(--spacing-theme-tile-min\\) \\* ([0-9.]+)\\)`).exec(css)![1]);
    const gridMin = named("--theme-grid-column-min");
    const thumb = named("--theme-thumb-width");
    // 격자와 썸네일이 이 이름을 실제로 읽는다(이름만 있고 쓰이지 않는 값이 아니다).
    expect(ruleBody(css, ".theme-gallery-grid")).toContain("minmax(var(--theme-grid-column-min), 1fr)");
    const thumbRule = css.slice(css.lastIndexOf(".theme-style-thumb {"));
    expect(thumbRule.slice(0, thumbRule.indexOf("}"))).toContain("inline-size: var(--theme-thumb-width)");
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
    const tileMin = Number(/--spacing-theme-tile-min:\s*(\d+)px/.exec(tokens)![1]);
    const body = ruleBody(css, ".theme-gallery-scroll");
    expect(body).toContain("max-block-size: var(--theme-grid-max-height)");
    expect(tileMin * Number(/--theme-grid-max-height:\s*calc\(var\(--spacing-theme-tile-min\) \* ([0-9.]+)\)/.exec(css)![1])).toBe(480);
    expect(body).toContain("overflow-y: auto");
    // 키보드로 옮긴 초점 타일이 위아래 페이드 구간(12)에 놓이지 않는다.
    expect(body).toContain("scroll-padding-block: var(--spacing-3)");
  });

  it("격자 안쪽 스크롤은 체이닝을 막지 않는다: `contain`이 아니다 (폰 폭의 스크롤 트랩 방지, 설계 리뷰 M4·2차 Medium 1)", () => {
    const body = ruleBody(css, ".theme-gallery-scroll");
    expect(body).toContain("overscroll-behavior: auto");
    expect(body).not.toContain("overscroll-behavior: contain");
    // 폰 폭에서 안쪽 스크롤을 없애면 열린 갤러리가 1,390~2,999px가 되어(칩·미리보기가 1.5~2.9화면 아래로 밀린다) 대신 상한을 둔다.
    expect(css).not.toContain("@media (width < 40rem)");
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

  it("키보드 초점은 집 규칙의 인셋 링이다: 틀 안쪽 2, 라디오가 peer라서 전역 포인터 규칙이 마우스에서 걷는다 (설계 리뷰 M5)", () => {
    const body = ruleBody(css, ".theme-tile > input:focus-visible ~ .theme-tile-frame");
    expect(body).toContain("outline: 2px solid var(--focus-ring-ink, var(--accent))");
    expect(body).toContain("outline-offset: -2px"); // tokens.css `focus-ring` 유틸과 같은 값(바깥 오프셋 링은 걷은 모양이다)
    expect(css).not.toContain(".theme-tile:has(:focus-visible)");
    // 전역 규칙이 걷으려면 라디오가 `.peer`여야 한다: 링을 그리는 틀이 그 뒤의 형제(`.peer:focus-visible ~ *`)다.
    expect(tile).toMatch(/className="peer sr-only"/);
    expect(tokens).toContain(".peer:focus-visible ~ *");
  });

  it("가리킨 윤곽은 호버가 되는 입력에서만 선다 (터치 잔상 방지)", () => {
    const at = css.indexOf("@media (hover: hover) {");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf("\n}\n", at))).toContain(".theme-tile:hover .theme-tile-frame");
    // 호버 규칙이 그 밖에 따로 있지 않다.
    expect(css.split(".theme-tile:hover").length - 1).toBe(1);
  });

  it("비활성 강조색 칩은 앱의 비활성 표준과 같다: 흐림 0.5, 기본 커서 (형제 프리미티브와 어긋나지 않는다)", () => {
    expect(ruleBody(css, '.accent-swatch[aria-disabled="true"] .accent-swatch-chip')).toContain("opacity: 0.5");
    expect(ruleBody(css, '.accent-swatch[aria-disabled="true"]')).toContain("cursor: default");
  });

  it("비어 있는 알림 자리는 간격을 먹지 않는다 (읽어 주는 영역은 늘 DOM에 있다)", () => {
    expect(css).toContain(".theme-gallery-notice:not(:empty)");
    expect(ruleBody(css, ".theme-gallery-region")).not.toContain("gap:");
  });
});
