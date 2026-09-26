import { describe, expect, it } from "vitest";
import {
  WORKBENCH_GUTTER,
  WORKBENCH_MAX_PANES,
  WORKBENCH_MIN_PANE,
  WORKBENCH_TOGGLE_FALLBACK_RATIO,
  canSplitPane,
  closePane,
  computeGeometry,
  defaultWorkbenchLayout,
  findSplit,
  focusCycle,
  focusDirection,
  focusIndex,
  focusPane,
  minimumSize,
  nudgeSplit,
  paneCount,
  paneIds,
  ratioBounds,
  resizeSplit,
  splitPane,
  toggleMaximize,
  toggleSplitRatio,
  type LayoutResult,
  type Size,
  type SplitNode,
  type WorkbenchLayout,
} from "./layoutTree";

const BIG: Size = { width: 1600, height: 1000 };
const G = WORKBENCH_GUTTER;
const MIN = WORKBENCH_MIN_PANE;

function must(result: LayoutResult): WorkbenchLayout {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.layout;
}

/** p1 | p2 */
function twoColumns(): WorkbenchLayout {
  return must(splitPane(defaultWorkbenchLayout(), "p1", "row", BIG));
}

/**
 * p1 | p2
 * ---+---
 * p3 | p4
 * (왼쪽 열과 오른쪽 열을 각각 아래로 나눈다. 두 가로 경계는 서로 다른 분할이다.)
 */
function fourGrid(): WorkbenchLayout {
  let l = twoColumns(); // p1 | p2, s2
  l = must(splitPane(l, "p1", "column", BIG)); // p1 / p3, s3
  l = must(splitPane(l, "p2", "column", BIG)); // p2 / p4, s4
  return l;
}

/**
 * T자:
 *   p1   |  p2
 * -------+------
 *      p3
 */
function tShape(): WorkbenchLayout {
  let l = must(splitPane(defaultWorkbenchLayout(), "p1", "column", BIG)); // p1 / p2
  // p1을 오른쪽으로 나누면 위줄이 p1 | p3, 아래가 p2
  l = must(splitPane(l, "p1", "row", BIG));
  return l;
}

describe("기본 배치", () => {
  it("칸 하나, 포커스는 그 칸, 최대화 없음", () => {
    const l = defaultWorkbenchLayout();
    expect(paneIds(l.root)).toEqual(["p1"]);
    expect(l.focused).toBe("p1");
    expect(l.maximized).toBeNull();
  });
});

describe("분할", () => {
  it("오른쪽으로 분할: 원래 칸이 앞, 새 칸이 뒤, 포커스는 새 칸", () => {
    const l = twoColumns();
    expect(l.root).toMatchObject({ kind: "split", axis: "row", ratio: 0.5 });
    expect(paneIds(l.root)).toEqual(["p1", "p2"]);
    expect(l.focused).toBe("p2");
    expect(l.seq).toBe(3);
  });

  it("중첩: 가로 안에 세로, 세로 안에 가로", () => {
    const l = fourGrid();
    expect(paneIds(l.root)).toEqual(["p1", "p3", "p2", "p4"]);
    const root = l.root as SplitNode;
    expect(root.axis).toBe("row");
    expect(root.first).toMatchObject({ kind: "split", axis: "column" });
    expect(root.second).toMatchObject({ kind: "split", axis: "column" });
  });

  it("최대화 중에 나누면 최대화를 푼다", () => {
    let l = twoColumns();
    l = must(toggleMaximize(l, "p1"));
    l = must(splitPane(l, "p1", "row", BIG));
    expect(l.maximized).toBeNull();
  });

  it("id는 겹치지 않는다(닫고 다시 나눠도)", () => {
    let l = fourGrid();
    l = must(closePane(l, "p4"));
    l = must(splitPane(l, "p2", "column", BIG));
    const ids = paneIds(l.root);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("p5");
  });

  it("없는 칸은 not-found", () => {
    const r = splitPane(defaultWorkbenchLayout(), "nope", "row", BIG);
    expect(r).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("최소 칸 크기: 경계에서 정확히 거부한다", () => {
  // 가로로 나눈 두 칸이 각각 MIN.width가 되는 최소 격자 너비.
  const exactWidth = MIN.width * 2 + G;
  const exactHeight = MIN.height * 2 + G;

  it("딱 맞는 너비는 허용, 1px 모자라면 too-small", () => {
    const l = defaultWorkbenchLayout();
    expect(canSplitPane(l, "p1", "row", { width: exactWidth, height: 400 }).ok).toBe(true);
    expect(splitPane(l, "p1", "row", { width: exactWidth - 1, height: 400 })).toMatchObject({
      ok: false,
      reason: "too-small",
    });
  });

  it("세로 분할은 높이로 잰다(너비가 넉넉해도)", () => {
    const l = defaultWorkbenchLayout();
    expect(canSplitPane(l, "p1", "column", { width: 4000, height: exactHeight }).ok).toBe(true);
    expect(splitPane(l, "p1", "column", { width: 4000, height: exactHeight - 1 })).toMatchObject({
      ok: false,
      reason: "too-small",
    });
  });

  it("거부하면 배치는 그대로다", () => {
    const l = defaultWorkbenchLayout();
    const r = splitPane(l, "p1", "row", { width: 100, height: 100 });
    expect(r.layout).toBe(l);
  });

  it("안쪽 칸은 그 칸의 크기로 잰다(격자 전체가 아니라)", () => {
    // 1000px 너비: 첫 분할 뒤 각 칸 496px. 496을 다시 나누면 244 >= 240 허용,
    // 그 244px 칸은 더 못 나눈다.
    const size = { width: 1000, height: 600 };
    let l = must(splitPane(defaultWorkbenchLayout(), "p1", "row", size));
    l = must(splitPane(l, "p2", "row", size));
    expect(splitPane(l, "p3", "row", size)).toMatchObject({ ok: false, reason: "too-small" });
    // 같은 칸을 아래로는 나눌 수 있다(높이는 넉넉).
    expect(splitPane(l, "p3", "column", size).ok).toBe(true);
  });

  it(`칸 수 상한 ${WORKBENCH_MAX_PANES}개에서 limit`, () => {
    const huge = { width: 100_000, height: 100_000 };
    let l = defaultWorkbenchLayout();
    while (paneCount(l.root) < WORKBENCH_MAX_PANES) {
      l = must(splitPane(l, l.focused, paneCount(l.root) % 2 === 0 ? "row" : "column", huge));
    }
    expect(splitPane(l, l.focused, "row", huge)).toMatchObject({ ok: false, reason: "limit" });
  });
});

describe("기하", () => {
  it("경계 두께를 빼고 비율대로 나눈다", () => {
    const g = computeGeometry(twoColumns().root, { width: 1008, height: 500 });
    expect(g.panes.get("p1")).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(g.panes.get("p2")).toEqual({ x: 508, y: 0, width: 500, height: 500 });
  });

  it("부분 트리 최소 크기: 같은 축은 더하고 다른 축은 큰 쪽", () => {
    const l = fourGrid();
    expect(minimumSize(l.root)).toEqual({
      width: MIN.width * 2 + G,
      height: MIN.height * 2 + G,
    });
  });
});

describe("닫기", () => {
  it("형제가 부모 자리를 잇는다", () => {
    const l = must(closePane(twoColumns(), "p2"));
    expect(l.root).toEqual({ kind: "pane", id: "p1" });
    expect(l.focused).toBe("p1");
  });

  it("앞 칸을 닫으면 포커스는 형제 가지의 맞닿은(첫) 칸으로", () => {
    let l = fourGrid(); // [p1/p3] | [p2/p4]
    l = must(focusPane(l, "p3"));
    // p3을 닫으면 p1이 왼쪽 열 전체가 된다.
    l = must(closePane(l, "p3"));
    expect(l.focused).toBe("p1");
    expect(paneIds(l.root)).toEqual(["p1", "p2", "p4"]);
  });

  it("뒤 칸을 닫으면 포커스는 형제 가지의 맞닿은(마지막) 칸으로", () => {
    // p1 | [p2 / p3] 에서 오른쪽 열 전체가 한 가지. 그 가지의 형제 p1 쪽을 본다.
    let l = twoColumns();
    l = must(splitPane(l, "p1", "column", BIG)); // [p1 / p3] | p2
    l = must(focusPane(l, "p2"));
    l = must(closePane(l, "p2"));
    expect(l.focused).toBe("p3");
  });

  it("포커스가 아닌 칸을 닫으면 포커스는 그대로", () => {
    let l = fourGrid();
    l = must(focusPane(l, "p1"));
    l = must(closePane(l, "p4"));
    expect(l.focused).toBe("p1");
  });

  it("최대화된 칸을 닫으면 최대화가 풀린다", () => {
    let l = fourGrid();
    l = must(toggleMaximize(l, "p4"));
    l = must(closePane(l, "p4"));
    expect(l.maximized).toBeNull();
  });

  it("마지막 칸은 닫지 않는다", () => {
    expect(closePane(defaultWorkbenchLayout(), "p1")).toMatchObject({
      ok: false,
      reason: "last-pane",
    });
  });

  it("없는 칸은 not-found", () => {
    expect(closePane(twoColumns(), "p9")).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("다른 가지의 참조는 그대로 둔다", () => {
    const l = fourGrid();
    const right = (l.root as SplitNode).second;
    const next = must(closePane(l, "p3"));
    expect((next.root as SplitNode).second).toBe(right);
  });
});

describe("경계 끌기", () => {
  const size = { width: 1008, height: 600 }; // 경계를 뺀 길이 1000

  it("비율을 바꾼다", () => {
    const l = must(resizeSplit(twoColumns(), "s2", 0.3, size));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(0.3);
  });

  it("최소 크기에서 멈춘다(양쪽)", () => {
    const low = must(resizeSplit(twoColumns(), "s2", 0.01, size));
    expect(findSplit(low.root, "s2")!.ratio).toBeCloseTo(MIN.width / 1000);
    const high = must(resizeSplit(twoColumns(), "s2", 0.99, size));
    expect(findSplit(high.root, "s2")!.ratio).toBeCloseTo(1 - MIN.width / 1000);
  });

  it("안쪽에 분할이 있으면 그 부분 트리 최소 크기까지만", () => {
    // p1 | [p2 | p3]: 오른쪽 가지 최소 너비는 240 + 8 + 240 = 488
    let l = must(splitPane(defaultWorkbenchLayout(), "p1", "row", BIG));
    l = must(splitPane(l, "p2", "row", BIG));
    l = must(resizeSplit(l, "s2", 0.95, size));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(1 - 488 / 1000);
  });

  it("격자가 이미 너무 작으면 비율을 바꾸지 않는다", () => {
    const l = twoColumns();
    const r = resizeSplit(l, "s2", 0.3, { width: 300, height: 300 });
    expect(r).toMatchObject({ ok: false, reason: "too-small" });
    expect(r.layout).toBe(l);
  });

  it("범위는 ratioBounds와 같다", () => {
    expect(ratioBounds(twoColumns(), "s2", size)).toEqual({
      min: MIN.width / 1000,
      max: 1 - MIN.width / 1000,
    });
  });

  it("NaN은 받지 않는다", () => {
    expect(resizeSplit(twoColumns(), "s2", Number.NaN, size).ok).toBe(false);
  });

  it("키보드 한 걸음", () => {
    const l = must(nudgeSplit(twoColumns(), "s2", -0.05, size));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(0.45);
  });
});

describe("경계 더블클릭: 두 단계 토글", () => {
  const size = { width: 1008, height: 600 };

  it("균등이 아니면 균등으로 가고, 다시 누르면 원래 비율로 돌아온다", () => {
    let l = must(resizeSplit(twoColumns(), "s2", 0.3, size));
    l = must(toggleSplitRatio(l, "s2", size));
    expect(findSplit(l.root, "s2")!.ratio).toBe(0.5);
    l = must(toggleSplitRatio(l, "s2", size));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(0.3);
    l = must(toggleSplitRatio(l, "s2", size));
    expect(findSplit(l.root, "s2")!.ratio).toBe(0.5);
  });

  it("균등이고 기억이 없으면 앞 칸을 ⅔로", () => {
    const l = must(toggleSplitRatio(twoColumns(), "s2", size));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(WORKBENCH_TOGGLE_FALLBACK_RATIO);
  });

  it("돌아갈 비율도 최소 크기 안으로 잘린다", () => {
    let l = must(resizeSplit(twoColumns(), "s2", 0.3, BIG));
    l = must(toggleSplitRatio(l, "s2", BIG)); // 기억 0.3, 지금 ½
    // 격자가 줄어 0.3이면 앞 칸이 최소보다 작아진다.
    const small = { width: 608, height: 600 }; // 길이 600, 최소 비율 0.4
    l = must(toggleSplitRatio(l, "s2", small));
    expect(findSplit(l.root, "s2")!.ratio).toBeCloseTo(0.4);
  });
});

describe("최대화", () => {
  it("켜면 그 칸에 포커스, 끄면 다른 칸은 그대로 트리에 있다", () => {
    let l = fourGrid();
    const root = l.root;
    l = must(toggleMaximize(l, "p3"));
    expect(l.maximized).toBe("p3");
    expect(l.focused).toBe("p3");
    expect(l.root).toBe(root);
    l = must(toggleMaximize(l, "p3"));
    expect(l.maximized).toBeNull();
    expect(l.root).toBe(root);
  });

  it("인자가 없으면 포커스 칸", () => {
    const l = must(toggleMaximize(twoColumns()));
    expect(l.maximized).toBe("p2");
  });

  it("칸이 하나면 single-pane", () => {
    expect(toggleMaximize(defaultWorkbenchLayout())).toMatchObject({
      ok: false,
      reason: "single-pane",
    });
  });

  it("다른 칸이 최대화된 상태에서 켜면 그 칸으로 바뀐다", () => {
    let l = must(toggleMaximize(fourGrid(), "p1"));
    l = must(toggleMaximize(l, "p4"));
    expect(l.maximized).toBe("p4");
  });
});

describe("포커스 이동", () => {
  it("순환은 트리 순서로 돌고 감긴다", () => {
    let l = fourGrid(); // 순서 p1 p3 p2 p4
    l = must(focusPane(l, "p4"));
    l = must(focusCycle(l, 1));
    expect(l.focused).toBe("p1");
    l = must(focusCycle(l, -1));
    expect(l.focused).toBe("p4");
    l = must(focusCycle(l, -1));
    expect(l.focused).toBe("p2");
  });

  it("칸이 하나면 순환은 single-pane", () => {
    expect(focusCycle(defaultWorkbenchLayout(), 1)).toMatchObject({ ok: false, reason: "single-pane" });
  });

  it("번호는 1부터, 없는 번호는 not-found", () => {
    const l = fourGrid();
    expect(must(focusIndex(l, 1)).focused).toBe("p1");
    expect(must(focusIndex(l, 3)).focused).toBe("p2");
    expect(focusIndex(l, 5)).toMatchObject({ ok: false, reason: "not-found" });
    expect(focusIndex(l, 0)).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("2×2 방향 이동", () => {
    let l = must(focusPane(fourGrid(), "p1"));
    l = must(focusDirection(l, "right", BIG));
    expect(l.focused).toBe("p2");
    l = must(focusDirection(l, "down", BIG));
    expect(l.focused).toBe("p4");
    l = must(focusDirection(l, "left", BIG));
    expect(l.focused).toBe("p3");
    l = must(focusDirection(l, "up", BIG));
    expect(l.focused).toBe("p1");
  });

  it("가장자리에서는 감기지 않는다(edge), 배치도 그대로", () => {
    const l = must(focusPane(fourGrid(), "p1"));
    const r = focusDirection(l, "left", BIG);
    expect(r).toMatchObject({ ok: false, reason: "edge" });
    expect(r.layout).toBe(l);
  });

  it("T자: 아래 넓은 칸에서 위로 가면 왼쪽 위(겹침이 같으면 트리 순서)", () => {
    // 위: p1 | p3, 아래: p2
    let l = must(focusPane(tShape(), "p2"));
    l = must(focusDirection(l, "up", BIG));
    expect(l.focused).toBe("p1");
  });

  it("T자: 겹침이 큰 칸을 고른다", () => {
    // 위 줄 비율을 0.3으로 두면 p3(오른쪽 위)이 아래 칸과 더 많이 겹친다.
    let l = tShape();
    const topSplit = paneIds(l.root).length === 3 ? findSplitOf(l, "p1") : "";
    l = must(resizeSplit(l, topSplit, 0.3, BIG));
    l = must(focusPane(l, "p2"));
    l = must(focusDirection(l, "up", BIG));
    expect(l.focused).toBe("p3");
  });

  it("T자: 위 칸에서 아래로 가면 둘 다 p2", () => {
    let l = must(focusPane(tShape(), "p1"));
    expect(must(focusDirection(l, "down", BIG)).focused).toBe("p2");
    l = must(focusPane(l, "p3"));
    expect(must(focusDirection(l, "down", BIG)).focused).toBe("p2");
  });

  it("가까운 칸이 먼저다(겹침이 더 큰 먼 칸보다)", () => {
    // p1 | p2 | p3 에서 p1 → 오른쪽은 p2
    let l = must(splitPane(defaultWorkbenchLayout(), "p1", "row", BIG));
    l = must(splitPane(l, "p2", "row", BIG));
    l = must(focusPane(l, "p1"));
    expect(must(focusDirection(l, "right", BIG)).focused).toBe("p2");
  });

  it("최대화 중에 다른 칸으로 가면 최대화를 푼다(가려진 칸에 입력하지 않게)", () => {
    let l = must(toggleMaximize(fourGrid(), "p1"));
    l = must(focusCycle(l, 1));
    expect(l.maximized).toBeNull();
    let m = must(toggleMaximize(fourGrid(), "p1"));
    m = must(focusDirection(m, "right", BIG));
    expect(m.maximized).toBeNull();
    expect(m.focused).toBe("p2");
  });

  it("최대화된 칸 자신에 포커스를 주면 최대화는 유지", () => {
    const l = must(toggleMaximize(fourGrid(), "p1"));
    expect(must(focusPane(l, "p1")).maximized).toBe("p1");
  });
});

function findSplitOf(layout: WorkbenchLayout, paneId: string): string {
  const walk = (node: WorkbenchLayout["root"]): string | null => {
    if (node.kind === "pane") return null;
    if (
      (node.first.kind === "pane" && node.first.id === paneId) ||
      (node.second.kind === "pane" && node.second.id === paneId)
    ) {
      return node.id;
    }
    return walk(node.first) ?? walk(node.second);
  };
  return walk(layout.root) ?? "";
}
