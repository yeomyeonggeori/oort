import { describe, expect, it } from "vitest";
import {
  WORKBENCH_MIN_PANE,
  computeGeometry,
  defaultWorkbenchLayout,
  fitLayoutToSize,
  splitPane,
  type WorkbenchLayout,
} from "./layoutTree";

const big = { width: 2000, height: 2000 };

/** 전체 화면에서 아래로 두 번 나눈 배치(½·¼·¼). */
function stacked3(): WorkbenchLayout {
  let l = splitPane(defaultWorkbenchLayout(), "p1", "column", big).layout;
  l = splitPane(l, "p2", "column", big).layout;
  return l;
}

function minPaneHeight(layout: WorkbenchLayout, size: { width: number; height: number }) {
  return Math.min(...[...computeGeometry(layout.root, size).panes.values()].map((r) => r.height));
}

describe("보이는 크기에 맞추기 (#2774 R5)", () => {
  it("중첩 분할을 줄여도 칸은 최소 높이를 지킨다(저장 비율은 그대로)", () => {
    const l = stacked3();
    const size = { width: 1000, height: 400 };
    // 맞추지 않으면 ¼ 칸이 최소보다 낮다.
    expect(minPaneHeight(l, size)).toBeLessThan(WORKBENCH_MIN_PANE.height);
    const { layout, cramped } = fitLayoutToSize(l, size);
    expect(cramped).toBe(false);
    expect(minPaneHeight(layout, size)).toBeGreaterThanOrEqual(WORKBENCH_MIN_PANE.height - 0.01);
    expect(l.root.kind === "split" && l.root.ratio).toBe(0.5);
  });

  it("넉넉하면 배치를 바꾸지 않는다", () => {
    const l = stacked3();
    expect(fitLayoutToSize(l, { width: 1000, height: 1200 }).layout).toBe(l);
  });

  it("최소보다 작으면 포커스 칸만 보이게(최대화처럼) 그린다", () => {
    const l = stacked3();
    const { layout, cramped } = fitLayoutToSize(l, { width: 1000, height: 300 });
    expect(cramped).toBe(true);
    expect(layout.maximized).toBe(l.focused);
  });

  it("칸 하나이거나 크기를 모르면 그대로", () => {
    const one = defaultWorkbenchLayout();
    expect(fitLayoutToSize(one, { width: 10, height: 10 }).layout).toBe(one);
    const l = stacked3();
    expect(fitLayoutToSize(l, { width: 0, height: 0 }).layout).toBe(l);
  });
});
