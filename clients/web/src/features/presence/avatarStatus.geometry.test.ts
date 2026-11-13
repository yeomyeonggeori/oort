import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WEB_STATUS_BADGE_FACES, statusBadgeGeometry } from "@momo/core/features/presence/statusBadge";

// =============================================================================
// 아바타 상태 점의 크기 — CSS 값이 코어 한 함수와 같은가 (#5786).
//
// 비율은 코어 `statusBadgeGeometry` 하나가 정한다(폰은 그 함수를 그대로 부른다). 웹은 인라인 스타일을 쓰지 않아 값이
// `tokens.css` 의 `avatar-status` 규칙에 크기마다 적혀 있다. 이 시험이 두 곳을 잇는다: 한쪽만 바꾸면 붉다.
// 큰 얼굴의 바깥 그림자를 지키는 넓힘(`--status-bleed`)이 `avatar-hero` 의 rest 고도가 번지는 폭보다 넓은지도 잰다.
// =============================================================================

const css = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const block = (() => {
  const start = css.indexOf("@utility avatar-status {");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
})();

function faceRule(face: number): Record<string, string> {
  const at = block.indexOf(`&[data-status-face="${face}"] {`);
  expect(at, `${face} 규칙이 있다`).toBeGreaterThan(-1);
  const body = block.slice(at, block.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--status-([a-z]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const px = (value: string | undefined): number => {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value ?? "");
  expect(match, `${value} 는 px 값이다`).not.toBeNull();
  return Number(match![1]);
};

describe("CSS 크기 표 = 코어 statusBadgeGeometry", () => {
  it.each(WEB_STATUS_BADGE_FACES.map((face) => [face]))("아바타 %ipx", (face) => {
    const rule = faceRule(face);
    const geometry = statusBadgeGeometry(face);
    expect({ dot: px(rule.dot), gap: px(rule.gap) }).toEqual({ dot: geometry.dot, gap: geometry.gap });
  });

  it("CSS 에 코어 표 밖의 크기가 없다(크기를 더하면 코어 표에도 더한다)", () => {
    const faces = [...block.matchAll(/data-status-face="(\d+)"/g)].map((m) => Number(m[1]));
    expect(faces.sort((a, b) => a - b)).toEqual([...WEB_STATUS_BADGE_FACES]);
  });

  it("기본값(크기를 고르지 않은 칸)은 목록 줄 32 의 값이다", () => {
    const head = block.slice(0, block.indexOf("&["));
    const geometry = statusBadgeGeometry(32);
    expect(head).toContain(`--status-dot: ${geometry.dot}px;`);
    expect(head).toContain(`--status-gap: ${geometry.gap}px;`);
    expect(head).toContain("--status-bleed: 0px;");
  });

  it("큰 얼굴의 넓힘은 rest 그림자가 번지는 폭(밝게 0 8px 24px -10px · 어둡게 0 10px 28px -12px)보다 넓다", () => {
    const bleedVar = faceRule(112).bleed;
    expect(bleedVar).toBe("var(--spacing-8)");
    const spacing8 = /--spacing-8:\s*(\d+)px;/.exec(css);
    expect(spacing8).not.toBeNull();
    // 그림자의 아래쪽 끝 = y + blur + spread.
    const reach = Math.max(8 + 24 - 10, 10 + 28 - 12, 1 + 2);
    expect(Number(spacing8![1])).toBeGreaterThan(reach);
  });

  it("도려낸 원과 점은 같은 변수에서 중심을 얻는다(점 상자 = 아바타 오른쪽 아래, 구멍 중심 = 100% - 점 반지름)", () => {
    expect(block).toContain("--status-at: calc(100% - var(--status-bleed) - var(--status-dot) / 2);");
    expect(block).toContain("--status-hole: calc(var(--status-dot) / 2 + var(--status-gap));");
    expect(block).toMatch(/circle at var\(--status-at\) var\(--status-at\),\s*transparent var\(--status-hole\),/);
    const dot = block.slice(block.indexOf("& > [data-avatar-status-dot] {"));
    expect(dot).toMatch(/right: 0;\s*bottom: 0;\s*inline-size: var\(--status-dot\);\s*block-size: var\(--status-dot\);/);
  });
});
