import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_SIZE_ID, FONT_SIZE_IDS, ROOT_ATTRIBUTES, type FontSizeId } from "@momo/core/design/appearance";

// =============================================================================
// 글자 크기 세 단계의 CSS 계약 (AP-2a #4189, ADR-0189 증보 1 D2 · 증보 3 D8, ADR-0179 D7).
//
// 이 파일은 CSS의 **문자열**을 잰다: 배율 변수가 어느 속성에서 어떤 값으로 서고, 여덟 역할이 모두 그
// 배율을 곱하며, 입력 칸 바닥과 틀(레이아웃 rem)은 배율에 닿지 않는다. 브라우저가 계산한 실제 크기는
// `typeScale.browser.test.ts`가 WebKit·Chromium에서 따로 잰다(두 시험은 서로를 대신하지 않는다).
// =============================================================================

const DOC = readFileSync(fileURLToPath(new URL("../../../../../docs/design-system/themes-2.0.md", import.meta.url)), "utf8");
const SCALE_CSS = readFileSync(fileURLToPath(new URL("./typography-scale.css", import.meta.url)), "utf8");
const TOKENS_CSS = readFileSync(fileURLToPath(new URL("../tokens.css", import.meta.url)), "utf8");

const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `typography-scale.css`의 단계별 배율. 「기본」은 `:root` 규칙이 말한다(`--type-scale: 1`). */
function stepScales(): Record<FontSizeId, number> {
  const css = code(SCALE_CSS);
  const out: Partial<Record<FontSizeId, number>> = {};
  const base = /:root\s*\{[^}]*--type-scale:\s*([\d.]+);/.exec(css);
  if (base) out[DEFAULT_FONT_SIZE_ID] = Number(base[1]);
  for (const found of css.matchAll(
    new RegExp(`:root\\[${ROOT_ATTRIBUTES.fontSize}="([a-z]+)"\\]\\s*\\{\\s*--type-scale:\\s*calc\\(\\s*(\\d+)\\s*/\\s*(\\d+)\\s*\\);`, "g")
  )) {
    out[found[1] as FontSizeId] = Number(found[2]) / Number(found[3]);
  }
  return out as Record<FontSizeId, number>;
}

/** 역할 → 「기본」 단계의 px(곱수 × 16)와 줄 높이 px. */
function roles(): Record<string, { px: number; line: number }> {
  const out: Record<string, { px: number; line: number }> = {};
  const css = code(TOKENS_CSS);
  for (const found of css.matchAll(/^\s*--text-([a-z]+):\s*calc\(var\(--type-rem\)\s*\*\s*([\d.]+)\);/gm)) {
    out[found[1]!] = { px: Number(found[2]) * 16, line: NaN };
  }
  for (const found of css.matchAll(/^\s*--text-([a-z]+)--line-height:\s*calc\(var\(--type-rem\)\s*\*\s*([\d.]+)\);/gm)) {
    out[found[1]!]!.line = Number(found[2]) * 16;
  }
  return out;
}

const SCALES = stepScales();
const ROLES = roles();

describe("글자 크기 배율 변수", () => {
  it("가상 rem은 1rem에 배율을 곱한 값이고, 배율의 기본은 1이다", () => {
    expect(code(SCALE_CSS)).toMatch(/:root\s*\{\s*--type-scale:\s*1;\s*--type-rem:\s*calc\(1rem \* var\(--type-scale\)\);\s*\}/);
  });

  it("세 단계 모두 배율이 읽히고, 속성 규칙은 기본을 뺀 두 단계뿐이다", () => {
    expect(Object.keys(SCALES).sort()).toEqual([...FONT_SIZE_IDS].sort());
    const attributeRules = [...code(SCALE_CSS).matchAll(new RegExp(`\\[${ROOT_ATTRIBUTES.fontSize}="([^"]*)"\\]`, "g"))].map(
      (m) => m[1]
    );
    expect([...attributeRules].sort()).toEqual(FONT_SIZE_IDS.filter((id) => id !== DEFAULT_FONT_SIZE_ID).sort());
  });

  it("메시지 본문이 작게 14 · 기본 15 · 크게 16px이다 (ADR-0189 증보 3 D8)", () => {
    const body = ROLES.body!;
    expect(body.px).toBe(15);
    expect(body.px * SCALES.smaller).toBeCloseTo(14, 6);
    expect(body.px * SCALES.default).toBeCloseTo(15, 6);
    expect(body.px * SCALES.larger).toBeCloseTo(16, 6);
  });

  it("단계는 작게 < 기본 < 크게로 오른다", () => {
    expect(SCALES.smaller).toBeLessThan(SCALES.default);
    expect(SCALES.default).toBeLessThan(SCALES.larger);
  });

  it("여덟 역할 모두 어느 단계에서도 줄 높이가 글자보다 크고, 비율이 단계마다 같다", () => {
    expect(Object.keys(ROLES).sort()).toEqual(["body", "code", "display", "heading", "label", "meta", "timestamp", "title"]);
    for (const [role, { px, line }] of Object.entries(ROLES)) {
      for (const id of FONT_SIZE_IDS) {
        const scale = SCALES[id];
        expect([role, id, line * scale > px * scale]).toEqual([role, id, true]);
      }
    }
  });

  it("가장 작은 글자도 작게에서 10px 밑으로 내려가지 않는다", () => {
    // 11px 캡션(timestamp)이 작게에서 10.3px이 된다. 이 하한은 역할을 더하거나 배율을 낮추는 결정이
    // 읽을 수 없는 글자를 만들지 않게 하는 안전선이다.
    const smallest = Math.min(...Object.values(ROLES).map((role) => role.px)) * SCALES.smaller;
    expect(smallest).toBeGreaterThanOrEqual(10);
  });
});

describe("컨트롤은 큰 글자를 담는다 (이슈 AC 5)", () => {
  /** 컨트롤 높이 사다리(px 고정). 배율을 받지 않는다. */
  function controlHeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const found of code(TOKENS_CSS).matchAll(/^\s*--spacing-(control(?:-sm|-lg)?|pill|field|icon-button):\s*(\d+)px;/gm)) {
      out[found[1]!] = Number(found[2]);
    }
    return out;
  }

  it("가장 작은 컨트롤 높이가 크게 단계의 title·display를 뺀 모든 역할 줄 높이보다 크다", () => {
    const heights = controlHeights();
    expect(Object.keys(heights).sort()).toEqual(["control", "control-lg", "control-sm", "field", "icon-button", "pill"]);
    const smallest = Math.min(...Object.values(heights));
    expect(smallest).toBe(heights["control-sm"]);
    // title·display는 컨트롤 안에 놓는 글자가 아니라 표면 제목이다. 나머지 여섯 역할은 컨트롤 라벨이 될 수 있다.
    for (const [role, { line }] of Object.entries(ROLES)) {
      if (role === "title" || role === "display") continue;
      const hosted = line * SCALES.larger;
      expect([role, hosted, hosted < smallest]).toEqual([role, hosted, true]);
    }
  });

  it("컨트롤 높이는 글자 배율을 받지 않는 px다 — 큰 글자가 컨트롤을 키우지도 줄이지도 않는다", () => {
    expect(code(TOKENS_CSS)).not.toMatch(/--spacing-(control|pill|field|icon-button)[a-z-]*:\s*calc\(/);
  });
});

describe("배율이 닿는 곳과 닿지 않는 곳", () => {
  it("`--type-rem`을 읽는 선언은 텍스트 역할과 입력 칸 바닥의 max() 둘뿐이다 — 틀은 배율을 받지 않는다", () => {
    const readers = [...code(TOKENS_CSS).matchAll(/^[^\n]*var\(--type-rem\)[^\n]*$/gm)].map((m) => m[0].trim());
    expect(readers.length).toBeGreaterThan(0);
    for (const line of readers) {
      expect(line, line).toMatch(/^--text-[a-z]+(--line-height)?:/);
    }
  });

  it("입력 칸의 바닥은 배율을 곱하지 않는 rem 그대로다 — 손가락 화면의 16px는 세 단계에서 변하지 않는다", () => {
    expect(code(TOKENS_CSS)).toMatch(/--field-text-floor:\s*1rem;/);
    expect(code(TOKENS_CSS)).toMatch(/--field-text-floor-leading:\s*1\.5rem;/);
    expect(code(SCALE_CSS)).not.toContain("field-text-floor");
  });

  it("body의 글자도 역할 변수를 읽는다 — 클래스 없는 글자까지 배율을 따른다", () => {
    expect(code(TOKENS_CSS)).toMatch(/body\s*\{[^}]*font-size:\s*var\(--text-body\);[^}]*line-height:\s*var\(--text-body--line-height\);/);
  });
});

describe("테마 토큰 표 §5의 글자 크기 표가 코드와 같다", () => {
  /** §5 안의 `| \`역할\` … | 곱수 | 작게 | 기본 | 크게 |` 행. */
  function docRows(): Record<string, number[]> {
    const start = DOC.indexOf("## 5. 플랫폼층과 밀도");
    const end = DOC.indexOf("## 6. DS2 시리즈");
    expect(start, "§5가 있다").toBeGreaterThan(-1);
    expect(end, "§6이 있다").toBeGreaterThan(start);
    const out: Record<string, number[]> = {};
    for (const row of DOC.slice(start, end).matchAll(/^\|\s*`([a-z]+)`[^|]*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*$/gm)) {
      out[row[1]!] = [Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])];
    }
    return out;
  }

  it("여덟 역할의 곱수와 세 단계 px가 tokens.css·typography-scale.css에서 계산한 값과 0.1px 안에서 같다", () => {
    const rows = docRows();
    expect(Object.keys(rows).sort()).toEqual(Object.keys(ROLES).sort());
    for (const [role, { px }] of Object.entries(ROLES)) {
      const [multiplier, smaller, normal, larger] = rows[role]!;
      expect([role, multiplier]).toEqual([role, px / 16]);
      expect(smaller, `${role} 작게`).toBeCloseTo(px * SCALES.smaller, 1);
      expect(normal, `${role} 기본`).toBeCloseTo(px * SCALES.default, 1);
      expect(larger, `${role} 크게`).toBeCloseTo(px * SCALES.larger, 1);
    }
  });
});
