import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAY_DIVIDER_PAD_CLASS,
  DIVIDER_GAP_CLASS,
  DIVIDER_RULE_CLASS,
  MARKER_DIVIDER_PAD_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
  SPACING_BRIDGE,
  SPACING_SCALE_PX,
  spacingPx,
} from "./spacing";

// =============================================================================
// 코어의 간격 판정과 화면의 Tailwind 클래스가 갈라지지 않게 하는 단정들.
//
// CSP가 인라인 스타일을 막으므로 값은 두 벌로 존재할 수밖에 없다(`spacing.ts` 머리
// 주석). 두 벌인 것을 못 막으면 **갈라지는 것을 막는다**: 코어의 숫자를 고치고
// 클래스를 안 고치면 이 파일이 붉다.
//
// 폰이 같은 코어 값을 자기 단위로 소비하므로, 이 단정이 지키는 것은 웹 한쪽이 아니라
// 「두 클라가 같은 얼굴을 갖는다」는 M-2의 약속 전체다.
//
// ## 이 파일이 한 번 틀린 표를 봤다 (U4-4R W-2)
//
// 1차는 `spacing.ts`가 들고 있던 **Tailwind 기본 스케일**로 검산했다. 거기에는 `1.5`가
// 있으므로 `py-1.5`(6px)는 산수를 통과했고 — 이 레포의 `tokens.css`에는 그 단계가
// 없어서 브라우저에는 규칙이 만들어지지 않았다. 8건이 초록인 채로 화면의 묶음 안
// 간격은 0px이었다.
//
// 그래서 이제 검산에 쓰는 표를 **`tokens.css`에서 읽는다.** 사본(`SPACING_SCALE_PX`)은
// 런타임용으로 남기되, 그 사본이 진짜인지를 이 파일이 매번 대조한다. 클래스가 실제로
// 컴파일되는지를 묻는 유일한 방법은 그 파일을 읽는 것이다.
// =============================================================================

const TOKENS_CSS_PATH = fileURLToPath(
  new URL("../../design/tokens.css", import.meta.url)
);
const TOKENS_CSS = readFileSync(TOKENS_CSS_PATH, "utf8");

/**
 * `tokens.css`가 실제로 선언한 `--spacing-*` 단계들.
 *
 * 이 표에 없는 이름은 유틸리티가 만들어지지 않는다 — `--spacing: initial`로 동적
 * 배수가 꺼져 있어서 Tailwind가 기본으로 주던 `p-<숫자>` 계산 경로가 통째로 없다.
 */
function declaredSpacingSteps(): Record<string, number> {
  const steps: Record<string, number> = {};
  const pattern = /^\s*--spacing-([a-z0-9-]+):\s*(-?[\d.]+)px;/gm;
  for (const match of TOKENS_CSS.matchAll(pattern)) {
    steps[match[1]] = Number(match[2]);
  }
  return steps;
}

const CSS_STEPS = declaredSpacingSteps();

/** `tokens.css`의 표로만 클래스를 푼다 — 사본이 아니라 CSS가 답한다. */
function cssPx(className: string): number {
  const suffix = className.slice(className.indexOf("-") + 1);
  const value = CSS_STEPS[suffix];
  if (value === undefined) {
    throw new Error(
      `tokens.css에 "--spacing-${suffix}"가 없다: "${className}"는 클래스 이름만 있고 ` +
        "CSS 규칙이 없다 — 화면에서는 그 여백이 0px이 된다 (U4-4R W-1)"
    );
  }
  return value;
}

/** `"pt-3 pb-row"` -> `{ top: 12, bottom: 6 }`. 값의 출처는 `tokens.css`다. */
function padOf(classes: string): { top: number; bottom: number } {
  const parts = classes.split(" ");
  const find = (prefixes: string[]) => {
    for (const part of parts) {
      const prefix = part.slice(0, part.indexOf("-"));
      if (prefixes.includes(prefix)) return cssPx(part);
    }
    throw new Error(`${prefixes.join("/")}에 해당하는 클래스가 없다: "${classes}"`);
  };
  return { top: find(["pt", "py"]), bottom: find(["pb", "py"]) };
}

describe("검산에 쓰는 표가 이 레포의 표다 (U4-4R W-2)", () => {
  it("동적 배수가 꺼져 있다 — 그래서 격자 밖 단계는 아예 컴파일되지 않는다", () => {
    // 이 한 줄이 없으면 `py-1.5`가 조용히 살아나고, 아래 단정들은 다시 아무것도
    // 지키지 못한다. 표를 읽기 전에 표의 성질부터 확인한다.
    expect(TOKENS_CSS).toMatch(/^\s*--spacing:\s*initial;/m);
  });

  it("사본이 tokens.css와 한 글자도 다르지 않다", () => {
    expect(Object.keys(SPACING_SCALE_PX).length).toBeGreaterThan(0);
    for (const [step, px] of Object.entries(SPACING_SCALE_PX)) {
      // 사본에만 있는 단계 = 컴파일되지 않는 단계. 1차가 정확히 그 상태였다.
      expect(CSS_STEPS, `--spacing-${step}가 tokens.css에 없다`).toHaveProperty(
        step
      );
      expect(CSS_STEPS[step], `--spacing-${step}`).toBe(px);
    }
  });

  it("1차가 적었던 py-1.5는 이 표에 없다 — 그것이 W-1의 자리였다", () => {
    // 되돌아오는 것을 막는 단정이다. `tokens.css`는 이 클래스를 「컴파일되지 않는
    // 예」로 이름 대어 적어 두었고, 그 예가 실제로 화면에 나갔다.
    expect(CSS_STEPS).not.toHaveProperty("1.5");
    expect(SPACING_SCALE_PX).not.toHaveProperty("1.5");
    expect(() => cssPx("py-1.5")).toThrow(/tokens.css에/);
  });
});

describe("행 간격이 코어 판정을 따른다 (H-7)", () => {
  /**
   * 코어가 말하는 것은 **행 사이의 거리**이지 한쪽 패딩이 아니다. 웹에서 그 거리는
   * 위 행의 아래 패딩 + 아래 행의 위 패딩이므로, 검산도 그 합으로 한다.
   */
  it("두 연속 행 사이가 withinGroup이다", () => {
    const cont = padOf(ROW_CONTINUATION_PAD_CLASS);
    expect(cont.bottom + cont.top).toBe(SPACING_BRIDGE.withinGroup);
  });

  it("묶음이 바뀌는 자리가 betweenGroups다", () => {
    // 앞 행은 이어지는 행(또는 묶음의 마지막 행)이므로 그 아래 패딩을 쓴다.
    const previous = padOf(ROW_CONTINUATION_PAD_CLASS);
    const head = padOf(ROW_GROUP_START_PAD_CLASS);
    expect(previous.bottom + head.top).toBe(SPACING_BRIDGE.betweenGroups);
  });

  it("묶음 머리 행이 이어지는 행보다 위로 더 열린다", () => {
    expect(padOf(ROW_GROUP_START_PAD_CLASS).top).toBeGreaterThan(
      padOf(ROW_CONTINUATION_PAD_CLASS).top
    );
  });

  it("이어지는 행의 위아래가 대칭이다 — hover 띠가 글자 밑으로 처지지 않게", () => {
    const cont = padOf(ROW_CONTINUATION_PAD_CLASS);
    expect(cont.top).toBe(cont.bottom);
  });
});

describe("구분선 간격이 코어 판정을 따른다 (M-2)", () => {
  it("날짜 구분선의 위아래가 코어 값이다", () => {
    const pad = padOf(DAY_DIVIDER_PAD_CLASS);
    expect(pad.top).toBe(SPACING_BRIDGE.dayDividerBlock.blockStart);
    expect(pad.bottom).toBe(SPACING_BRIDGE.dayDividerBlock.blockEnd);
  });

  it("안읽음·복구 표지의 위아래가 코어 값이다", () => {
    const pad = padOf(MARKER_DIVIDER_PAD_CLASS);
    expect(pad.top).toBe(SPACING_BRIDGE.markerDividerBlock.blockStart);
    expect(pad.bottom).toBe(SPACING_BRIDGE.markerDividerBlock.blockEnd);
  });

  it("라벨과 rule 사이, 그리고 rule 두께가 코어 값이다", () => {
    expect(cssPx(DIVIDER_GAP_CLASS)).toBe(SPACING_BRIDGE.labelGap);
    expect(cssPx(DIVIDER_RULE_CLASS)).toBe(SPACING_BRIDGE.ruleThickness);
  });

  it("날짜가 같은 날 안의 표지보다 더 연다", () => {
    expect(cssPx(DAY_DIVIDER_PAD_CLASS)).toBeGreaterThan(
      cssPx(MARKER_DIVIDER_PAD_CLASS)
    );
  });
});

describe("임의값을 클래스에 적어 넣지 못한다", () => {
  it("이 레포의 표 밖은 거부한다", () => {
    expect(() => spacingPx("pt-[13px]")).toThrow(/간격 표에 없는/);
    expect(() => spacingPx("py-7")).toThrow(/간격 표에 없는/);
    // 리듬 축이 아닌 이름도 간격으로는 못 쓴다: `py-pane`은 320px짜리 여백이 된다.
    expect(() => spacingPx("py-pane")).toThrow(/간격 표에 없는/);
  });
});
