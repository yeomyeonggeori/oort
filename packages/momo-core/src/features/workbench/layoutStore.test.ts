import { describe, expect, it } from "vitest";
import {
  WORKBENCH_LAYOUT_ENTRY_PREFIX,
  parseWorkbenchLayout,
  serializeWorkbenchLayout,
  workbenchLayoutEntry,
} from "./layoutStore";
import {
  WORKBENCH_MAX_PANES,
  defaultWorkbenchLayout,
  resizeSplit,
  splitPane,
  toggleMaximize,
  toggleSplitRatio,
  type LayoutResult,
  type WorkbenchLayout,
} from "./layoutTree";

const BIG = { width: 1600, height: 1000 };

function must(result: LayoutResult): WorkbenchLayout {
  if (!result.ok) throw new Error(result.reason);
  return result.layout;
}

function sample(): WorkbenchLayout {
  let l = must(splitPane(defaultWorkbenchLayout(), "p1", "row", BIG));
  l = must(splitPane(l, "p1", "column", BIG));
  l = must(resizeSplit(l, "s2", 0.3, BIG));
  l = must(toggleSplitRatio(l, "s2", BIG)); // restoreRatio 0.3
  l = must(toggleMaximize(l, "p3"));
  return l;
}

describe("저장 항목 이름: 세션마다 따로", () => {
  it("세션 키가 이름에 붙는다", () => {
    expect(workbenchLayoutEntry("/Users/me/momo/.worktrees/fix-login")).toBe(
      `${WORKBENCH_LAYOUT_ENTRY_PREFIX}/Users/me/momo/.worktrees/fix-login`
    );
  });

  it("다른 세션은 다른 이름", () => {
    expect(workbenchLayoutEntry("a")).not.toBe(workbenchLayoutEntry("b"));
  });

  it("빈 키는 default", () => {
    expect(workbenchLayoutEntry("  ")).toBe(`${WORKBENCH_LAYOUT_ENTRY_PREFIX}default`);
  });
});

describe("왕복", () => {
  it("쓰고 읽으면 같은 배치(비율, 기억한 비율, 최대화, seq까지)", () => {
    const l = sample();
    expect(parseWorkbenchLayout(serializeWorkbenchLayout(l))).toEqual(l);
  });

  it("기본 배치도 왕복한다", () => {
    const l = defaultWorkbenchLayout();
    expect(parseWorkbenchLayout(serializeWorkbenchLayout(l))).toEqual(l);
  });
});

describe("읽지 못하는 값은 null(호스트는 기본 배치를 그린다)", () => {
  const good = JSON.parse(serializeWorkbenchLayout(sample())) as Record<string, unknown>;
  const mutate = (patch: (v: Record<string, unknown>) => void): string => {
    const copy = structuredClone(good);
    patch(copy);
    return JSON.stringify(copy);
  };

  it.each<[string, string | null | undefined]>([
    ["null", null],
    ["undefined", undefined],
    ["빈 문자열", ""],
    ["JSON 아님", "{not json"],
    ["배열", "[]"],
    ["다른 버전", mutate((v) => (v.v = 2))],
    ["root 없음", mutate((v) => delete v.root)],
    ["모르는 kind", mutate((v) => ((v.root as Record<string, unknown>).kind = "tab"))],
    ["모르는 axis", mutate((v) => ((v.root as Record<string, unknown>).axis = "diagonal"))],
    ["비율 0", mutate((v) => ((v.root as Record<string, unknown>).ratio = 0))],
    ["비율 1", mutate((v) => ((v.root as Record<string, unknown>).ratio = 1))],
    ["비율 문자열", mutate((v) => ((v.root as Record<string, unknown>).ratio = "0.5"))],
    ["기억 비율 범위 밖", mutate((v) => ((v.root as Record<string, unknown>).restoreRatio = 3))],
    ["포커스 칸 없음", mutate((v) => (v.focused = "p99"))],
    ["최대화 칸 없음", mutate((v) => (v.maximized = "p99"))],
    ["seq 0", mutate((v) => (v.seq = 0))],
    ["seq 소수", mutate((v) => (v.seq = 2.5))],
    [
      "칸 id 겹침",
      JSON.stringify({
        v: 1,
        root: {
          kind: "split",
          id: "s2",
          axis: "row",
          ratio: 0.5,
          first: { kind: "pane", id: "p1" },
          second: { kind: "pane", id: "p1" },
        },
        focused: "p1",
        maximized: null,
        seq: 3,
      }),
    ],
    ["빈 id", JSON.stringify({ v: 1, root: { kind: "pane", id: "" }, focused: "", maximized: null, seq: 2 })],
  ])("%s", (_name, raw) => {
    expect(parseWorkbenchLayout(raw)).toBeNull();
  });

  it(`칸 수 상한(${WORKBENCH_MAX_PANES}) 초과`, () => {
    // 한 방향으로 17칸을 잇는 사슬(깊이 16).
    let node: Record<string, unknown> = { kind: "pane", id: "p0" };
    for (let i = 1; i <= WORKBENCH_MAX_PANES; i++) {
      node = { kind: "split", id: `s${i}`, axis: "row", ratio: 0.5, first: node, second: { kind: "pane", id: `p${i}` } };
    }
    const raw = JSON.stringify({ v: 1, root: node, focused: "p0", maximized: null, seq: 100 });
    expect(parseWorkbenchLayout(raw)).toBeNull();
  });
});

describe("고쳐 읽기", () => {
  it("seq가 쓰인 번호보다 작으면 올린다(새 id가 겹치지 않게)", () => {
    const l = sample();
    const raw = JSON.stringify({ ...l, seq: 1 });
    const parsed = parseWorkbenchLayout(raw)!;
    expect(parsed.seq).toBe(l.seq);
    const next = must(splitPane(parsed, "p1", "row", BIG));
    expect(next.focused).toBe(`p${l.seq}`);
  });

  it("칸이 하나인데 최대화가 적혀 있으면 푼다", () => {
    const raw = JSON.stringify({ v: 1, root: { kind: "pane", id: "p1" }, focused: "p1", maximized: "p1", seq: 2 });
    expect(parseWorkbenchLayout(raw)!.maximized).toBeNull();
  });

  it("maximized가 빠져 있으면 null로 읽는다", () => {
    const raw = JSON.stringify({ v: 1, root: { kind: "pane", id: "p1" }, focused: "p1", seq: 2 });
    expect(parseWorkbenchLayout(raw)).toEqual(defaultWorkbenchLayout());
  });
});
