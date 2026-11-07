import { describe, expect, it } from "vitest";
import { SET_GRID_GAP_PX, SET_GRID_MAX_COLUMNS, SET_TILE_MIN_PX, setGridColumns } from "./setGridColumns";

// 세트 카드 격자의 열 수 (#5527, 검수 7c M2). 순수 함수의 문턱을 값으로 못 박는다. 실제 칸 폭·키보드 이동과의 일치는 `ExpressionSetApprovalCard.fit.browser.test.ts`가 실제 엔진으로 잰다.

/** 열이 n개일 때 격자가 가져야 하는 가장 좁은 폭(시험이 식을 따로 적는다: 구현의 식이 틀려도 같이 틀리지 않게). */
const need = (columns: number) => columns * SET_TILE_MIN_PX + (columns - 1) * SET_GRID_GAP_PX;

describe("세트 카드 격자 열 수 (#5527 M2)", () => {
  it("칸의 가장 좁은 폭을 지키는 열 수 중 가장 많은 것을 고른다: 문턱마다 한 열씩 줄고 1에서 멈춘다", () => {
    expect(SET_GRID_MAX_COLUMNS).toBe(4);
    expect([2000, 900, need(4)].map((width) => setGridColumns(width))).toEqual([4, 4, 4]);
    expect([need(4) - 1, need(3)].map((width) => setGridColumns(width))).toEqual([3, 3]);
    expect([need(3) - 1, need(2)].map((width) => setGridColumns(width))).toEqual([2, 2]);
    expect([need(2) - 1, 120, 1].map((width) => setGridColumns(width))).toEqual([1, 1, 1]);
  });

  it("데스크탑 최소 창(720)의 카드 안쪽 폭(약 270)은 2열이고, 그 칸은 가장 좁은 폭 이상이다. 옛 4열은 칸이 60px라 그림 64를 담지 못했다", () => {
    const inner = 272;
    const columns = setGridColumns(inner);
    expect(columns).toBe(2);
    expect((inner - (columns - 1) * SET_GRID_GAP_PX) / columns).toBeGreaterThanOrEqual(SET_TILE_MIN_PX);
    expect((inner - 3 * SET_GRID_GAP_PX) / 4).toBeLessThan(64);
  });

  it("폭을 모르면(0 이하·무한·숫자 아님) 이전 값을, 그것도 없으면 넓은 카드의 모양(4)을 돌려준다", () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setGridColumns(width)).toBe(4);
      expect(setGridColumns(width, 2)).toBe(2);
    }
  });

  it("다시 셀 때(이전 값이 있을 때) 열을 줄이는 쪽만 스크롤바 여유를 둔다. 늘리는 쪽은 문턱 그대로다", () => {
    // 3열이던 카드가 스크롤바(15px)가 생겨 문턱 바로 아래로 줄어도 3열을 지킨다. 여유를 넘게 줄면 줄인다.
    expect(setGridColumns(need(3) - 15, 3)).toBe(3);
    expect(setGridColumns(need(3) - 17, 3)).toBe(2);
    // 한 번에 여러 열이 줄어야 하는 폭이면 여유와 상관없이 바로 그 열 수다.
    expect(setGridColumns(need(2) + 5, 4)).toBe(2);
    // 늘릴 때는 여유가 없다: 2열이던 카드는 3열의 문턱에 닿아야 3열이 된다.
    expect(setGridColumns(need(3) - 1, 2)).toBe(2);
    expect(setGridColumns(need(3), 2)).toBe(3);
    // 이전 값이 없으면(첫 측정) 여유도 없다.
    expect(setGridColumns(need(3) - 15)).toBe(2);
  });
});
