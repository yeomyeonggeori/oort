import { describe, expect, it } from "vitest";
import {
  DAY_DIVIDER_PAD_CLASS,
  DIVIDER_GAP_CLASS,
  DIVIDER_RULE_CLASS,
  MARKER_DIVIDER_PAD_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
  SPACING_BRIDGE,
  tailwindPx,
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
// =============================================================================

/** `"pt-3 pb-1.5"` -> `{ top: 12, bottom: 6 }`. */
function padOf(classes: string): { top: number; bottom: number } {
  const parts = classes.split(" ");
  const find = (prefixes: string[]) => {
    for (const part of parts) {
      const prefix = part.slice(0, part.indexOf("-"));
      if (prefixes.includes(prefix)) return tailwindPx(part);
    }
    throw new Error(`${prefixes.join("/")}에 해당하는 클래스가 없다: "${classes}"`);
  };
  return { top: find(["pt", "py"]), bottom: find(["pb", "py"]) };
}

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
    expect(tailwindPx(DIVIDER_GAP_CLASS)).toBe(SPACING_BRIDGE.labelGap);
    expect(tailwindPx(DIVIDER_RULE_CLASS)).toBe(SPACING_BRIDGE.ruleThickness);
  });

  it("날짜가 같은 날 안의 표지보다 더 연다", () => {
    expect(tailwindPx(DAY_DIVIDER_PAD_CLASS)).toBeGreaterThan(
      tailwindPx(MARKER_DIVIDER_PAD_CLASS)
    );
  });
});

describe("임의값을 클래스에 적어 넣지 못한다", () => {
  it("Tailwind 기본 스케일 밖은 거부한다", () => {
    expect(() => tailwindPx("pt-[13px]")).toThrow(/기본 스케일에 없는/);
    expect(() => tailwindPx("py-7")).toThrow(/기본 스케일에 없는/);
  });
});
