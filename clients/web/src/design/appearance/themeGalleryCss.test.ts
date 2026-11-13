import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 테마 갤러리 CSS 조각의 계약 (AP-1b #4188, 청사진 §5.3-c · #5783 늘 펴진 격자). 실제 렌더는 캡처(`capture-4188.mjs`의
// `qa8` 장면이 넘침·칩 한 줄·자리 이동을 잰다)가 보고, 이 시험은 규칙이 조용히 사라지는 것을 막는다.
// =============================================================================

const css = readFileSync(new URL("./theme-gallery.css", import.meta.url), "utf8");
const tile = readFileSync(new URL("../../features/settings/appearance/ThemeTile.tsx", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

/** `selector { ... }` 본문. 중첩 블록이 없는 단순 규칙만 읽는다. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} 규칙이 없다`).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf("}", at));
}

describe("늘 펴진 격자와 글자 없는 타일 (#5783)", () => {
  const row = readFileSync(new URL("../../features/settings/appearance/ThemeStyleRow.tsx", import.meta.url), "utf8");
  const swatches = readFileSync(new URL("../themes/swatches.css", import.meta.url), "utf8");

  it("접힌 행의 규칙(트리거·썸네일·글자 숨김 폭)은 걷혔다: 타일에는 숨길 글자가 없고 큰 미리보기 카드는 늘 글자가 있다", () => {
    for (const gone of [".theme-style-trigger", ".theme-style-thumb", "--theme-thumb-width", "@container (width < 11rem)", "@container (width < 8.75rem)", "@container (width < 28rem)"]) {
      expect(css, gone).not.toContain(gone);
    }
    // 타일 틀은 이제 컨테이너가 아니다(그 안에서 재던 글자가 없다). 22rem 질의는 설정 카드가 컨테이너다.
    expect(css).not.toContain("container-type");
  });

  it("타일 최소 폭에서 나오는 두 크기: 열 최소 폭 136(네 열·두 열) · 스크롤 상한 480", () => {
    const tileMin = Number(/--spacing-theme-tile-min:\s*(\d+)px/.exec(tokens)![1]);
    const named = (name: string) => tileMin * Number(new RegExp(`${name}:\\s*calc\\(var\\(--spacing-theme-tile-min\\) \\* ([0-9.]+)\\)`).exec(css)![1]);
    expect(ruleBody(css, ".theme-gallery-grid")).toContain("minmax(var(--theme-grid-column-min), 1fr)");
    expect(Math.round(named("--theme-grid-column-min"))).toBe(136);
    expect(named("--theme-grid-max-height")).toBe(480);
  });

  it("갤러리 덩이는 설정 행의 컨트롤 자리(가로 flex)에서 폭을 다 쓴다: 따로 여백을 두지 않는다(행의 좌우 16이 곧 여백)", () => {
    const body = ruleBody(css, ".theme-gallery-region");
    expect(body).toContain("flex: 1 1 auto");
    expect(body).toContain("min-inline-size: 0");
    expect(body).not.toContain("padding");
  });

  it("청크를 받는 동안의 자리는 펴진 격자와 같은 높이다: 안내 한 줄 + 간격 + 스크롤 상한 (아래 행이 밀리지 않는다)", () => {
    expect(ruleBody(css, ".theme-gallery-skeleton")).toContain("block-size: var(--theme-grid-max-height)");
    const hint = ruleBody(css, ".theme-gallery-skeleton-hint");
    expect(hint).toContain("block-size: var(--text-meta--line-height)");
    // 펴진 쪽 안내 줄의 아래 간격과 같은 값이다.
    expect(hint).toContain("margin-block-end: var(--spacing-2)");
    expect(ruleBody(css, ".theme-gallery-hint,\n.theme-gallery-notice:not(:empty)")).toContain("margin-block-end: var(--spacing-2)");
    expect(row).toContain("theme-gallery-skeleton-hint");
    expect(row).toContain('className="theme-gallery-skeleton"');
  });

  it("강조색 칩은 32 원 · 44 누르는 자리이고 줄에 따로 간격이 없다 (원 사이 12는 누르는 자리의 여백)", () => {
    const tap = Number(/--tap-target:\s*(\d+)px/.exec(tokens)![1]);
    const control = Number(/--spacing-control:\s*(\d+)px/.exec(tokens)![1]);
    expect(ruleBody(swatches, ".accent-swatch")).toContain("min-inline-size: var(--tap-target)");
    expect(ruleBody(swatches, ".accent-swatch-chip")).toContain("inline-size: var(--spacing-control)");
    expect(tap - control).toBe(12);
    // 칩 줄(지연 청크·정적 칩 둘 다)은 간격 클래스가 없는 한 줄 flex다.
    for (const file of ["AccentGroup.tsx", "ThemeCard.tsx"]) {
      const source = readFileSync(new URL(`../../features/settings/appearance/${file}`, import.meta.url), "utf8");
      expect(source, file).toContain('<div className="flex flex-wrap" data-testid="accent-chip-row">');
    }
    // 다섯 칸이 한 줄에 드는 최소 폭(220)은 지원 폭 360의 설정 행 안쪽(약 278)보다 작다.
    expect(5 * tap).toBeLessThanOrEqual(278);
  });
});

describe("폰 폭의 열린 갤러리: 두 열을 지킨다 (설계 리뷰 3차 M-2)", () => {
  it("카드 22rem 미만에서 열 최소 폭이 줄고, 글자 크기를 키워 이름이 타일보다 길어지면 말줄임 대신 공백에서 접힌다 (4차 B-1)", () => {
    const at = css.indexOf("@container (width < 22rem) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toContain("--theme-grid-column-min: calc(var(--spacing-theme-tile-min) * 0.75)");
    expect(block).toContain(".theme-tile-name");
    expect(block).toContain("white-space: normal");
    expect(block).toContain("text-wrap: balance");
  });

  it("고른 타일은 이름의 굵기를 바꾸지 않는다: 굵게 하면 폭이 늘어서 두 열 타일에서 고른 순간에만 이름이 잘렸다 (4차 B-1)", () => {
    const selected = ruleBody(css, ".theme-tile[data-selected] .theme-tile-name");
    expect(selected).not.toContain("font-weight");
    expect(selected).toContain("color: var(--ink)");
    // 고름은 링이 말한다: 틀 바깥 4의 잉크 링.
    expect(ruleBody(css, ".theme-tile[data-selected] .theme-tile-frame")).toContain("var(--ink)");
    // 기본 이름은 굵기를 정하지 않는다(굵기는 어디서도 바뀌지 않는다).
    expect(ruleBody(css, ".theme-tile-name")).not.toContain("font-weight");
  });

  it("지원 폭 360에서도 두 열이 선다: 열 최소 폭(120) × 2 + 간격 ≤ 360 폭 카드의 격자 안쪽 폭", () => {
    const tileMin = Number(/--spacing-theme-tile-min:\s*(\d+)px/.exec(tokens)![1]);
    const narrowMin = tileMin * 0.75;
    const spacing = (n: number) => Number(new RegExp(`--spacing-${n}:\\s*(\\d+)px`).exec(tokens)![1]);
    // 360 폭 화면의 설정 카드는 약 310(측정: 한 열일 때 타일 폭 270 + 격자 좌우 여백 8 + 갤러리 좌우 여백 32). 안쪽은 갤러리 좌우 여백(16)과
    // 격자 좌우 여백(4)을 뺀 값이다.
    const cardAt360 = 310;
    const inner = cardAt360 - 2 * spacing(4) - 2 * spacing(1);
    expect(2 * narrowMin + spacing(4)).toBeLessThanOrEqual(inner);
    // 기본 열 최소 폭(136)으로는 같은 폭에서 한 열이다: 이 규칙이 일하는 자리다.
    expect(2 * tileMin * 0.85 + spacing(4)).toBeGreaterThan(inner - 0);
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

  it("고른 타일은 색만이 아니라 링(틀 바깥)으로도 말한다: 이름은 잉크색이고 굵기는 그대로다", () => {
    expect(ruleBody(css, ".theme-tile[data-selected] .theme-tile-frame")).toContain("0 0 0 4px var(--ink)");
    expect(ruleBody(css, ".theme-tile[data-selected] .theme-tile-name")).toContain("color: var(--ink)");
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
