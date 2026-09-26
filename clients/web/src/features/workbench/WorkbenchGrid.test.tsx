// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import {
  WORKBENCH_GUTTER,
  WORKBENCH_MIN_PANE,
  defaultWorkbenchLayout,
  splitPane,
  type Size,
  type WorkbenchLayout,
} from "@momo/core/features/workbench/layoutTree";
import { workbenchLayoutEntry } from "@momo/core/features/workbench/layoutStore";
import { WorkbenchGrid } from "./WorkbenchGrid";
import { WorkbenchHarness } from "./WorkbenchHarness";
import {
  memoryLayoutStorage,
  useWorkbenchLayout,
  type LayoutStorage,
} from "./useWorkbenchLayout";

// 격자 엔진의 화면 쪽(#2773). 트리 연산 자체는 core 시험이 두껍게 잰다. 여기서는
// 키(물리 키, 한글 입력), 거부 문구, 최대화 중 칸 유지, 경계 끌기·더블클릭·화살표,
// 저장소 실패에도 그려지는지를 잰다.

const BIG: Size = { width: 1600, height: 1000 };

beforeAll(() => {
  // jsdom에는 PointerEvent가 없다. MouseEvent로 clientX를 싣는다.
  if (typeof window.PointerEvent === "undefined") {
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {
      pointerId = 1;
    } as unknown as typeof MouseEvent;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Controlled({
  initial = defaultWorkbenchLayout(),
  size = BIG,
  onChange,
}: {
  initial?: WorkbenchLayout;
  size?: Size;
  onChange?: (l: WorkbenchLayout) => void;
}) {
  const [layout, setLayout] = useState(initial);
  return (
    <WorkbenchGrid
      layout={layout}
      onLayoutChange={(next) => {
        onChange?.(next);
        setLayout(next);
      }}
      platform="mac"
      size={size}
    />
  );
}

function grid() {
  return screen.getByTestId("workbench-grid");
}
function panes() {
  return screen.getAllByTestId("workbench-pane");
}
function focusedPaneId() {
  return panes().find((p) => p.hasAttribute("data-focused"))?.getAttribute("data-pane-id");
}

function four(): WorkbenchLayout {
  let l = splitPane(defaultWorkbenchLayout(), "p1", "row", BIG).layout;
  l = splitPane(l, "p1", "column", BIG).layout;
  l = splitPane(l, "p2", "column", BIG).layout;
  return l;
}

describe("분할 키: 물리 키로 판정한다", () => {
  it("⌘D 오른쪽, ⌘⇧D 아래", () => {
    render(<Controlled />);
    fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    expect(panes()).toHaveLength(2);
    expect(document.querySelector('[data-axis="row"]')).not.toBeNull();
    fireEvent.keyDown(grid(), { key: "D", code: "KeyD", metaKey: true, shiftKey: true });
    expect(panes()).toHaveLength(3);
    expect(document.querySelector('[data-axis="column"]')).not.toBeNull();
  });

  it("한글 2벌식: key가 「ㅇ」이어도 ⌘D는 분할이다", () => {
    render(<Controlled />);
    fireEvent.keyDown(grid(), { key: "ㅇ", code: "KeyD", metaKey: true });
    expect(panes()).toHaveLength(2);
  });

  it("격자 키는 바깥(앱 ⌘↵ 보내기 등)으로 새지 않는다", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Controlled initial={four()} />
      </div>
    );
    fireEvent.keyDown(grid(), { key: "Enter", code: "Enter", metaKey: true, shiftKey: true });
    expect(outer).not.toHaveBeenCalled();
    // 격자 키가 아닌 것은 흘려 보낸다.
    fireEvent.keyDown(grid(), { key: "k", code: "KeyK", metaKey: true });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});

describe("최소 칸 크기 아래로는 분할을 거부한다", () => {
  const exact = WORKBENCH_MIN_PANE.width * 2 + WORKBENCH_GUTTER;

  it("1px 모자라면 칸 수가 그대로이고 거부 문구를 보인다, 버튼도 꺼진다", () => {
    render(<Controlled size={{ width: exact - 1, height: 600 }} />);
    fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    expect(panes()).toHaveLength(1);
    expect(screen.getByTestId("workbench-status").textContent).toContain("칸이 좁아 더 나눌 수 없습니다");
    const button = screen.getByRole("button", { name: "오른쪽으로 분할" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // 꺼진 버튼을 눌러도 나뉘지 않고, 까닭을 말한다(포인터 사용자에게도).
    fireEvent.click(button);
    expect(panes()).toHaveLength(1);
  });

  it("딱 맞으면 나뉜다", () => {
    render(<Controlled size={{ width: exact, height: 600 }} />);
    expect(screen.getByRole("button", { name: "오른쪽으로 분할" }).hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "오른쪽으로 분할" }));
    expect(panes()).toHaveLength(2);
  });
});

describe("최대화: 다른 칸은 트리에 남는다", () => {
  it("⌘⇧↵로 켜면 네 칸이 모두 DOM에 있고, 가려진 칸은 inert·invisible", () => {
    render(<Controlled initial={four()} />);
    const before = panes();
    fireEvent.keyDown(grid(), { key: "Enter", code: "Enter", metaKey: true, shiftKey: true });
    const after = panes();
    expect(after).toHaveLength(4);
    // 같은 DOM 노드다(떼었다 붙이지 않았다).
    after.forEach((node, i) => expect(node).toBe(before[i]));
    const maxed = after.filter((p) => p.hasAttribute("data-maximized"));
    expect(maxed).toHaveLength(1);
    expect(maxed[0]!.className).toContain("wb-maximized");
    for (const other of after.filter((p) => !p.hasAttribute("data-maximized"))) {
      expect(other.hasAttribute("inert")).toBe(true);
      expect(other.className).toContain("invisible");
    }
    fireEvent.keyDown(grid(), { key: "Enter", code: "NumpadEnter", metaKey: true, shiftKey: true });
    expect(panes().some((p) => p.hasAttribute("data-maximized"))).toBe(false);
    expect(panes().some((p) => p.hasAttribute("inert"))).toBe(false);
  });

  it("칸이 하나면 최대화하지 않고 까닭을 말한다", () => {
    render(<Controlled />);
    fireEvent.keyDown(grid(), { key: "Enter", code: "Enter", metaKey: true, shiftKey: true });
    expect(panes()[0]!.hasAttribute("data-maximized")).toBe(false);
    expect(screen.getByTestId("workbench-status").textContent).toContain("칸이 하나라");
  });
});

describe("신호색 링은 격자가 실제로 포커스를 가질 때만", () => {
  it("활성 칸의 링은 group-focus-within에 묶여 있다(항상 켜진 focus-ring이 아니다)", () => {
    render(<Controlled initial={four()} />);
    const active = panes().find((p) => p.hasAttribute("data-focused"))!;
    const classes = active.className.split(/\s+/);
    expect(classes).toContain("group-focus-within/wb:focus-ring");
    expect(classes).not.toContain("focus-ring");
    expect(grid().className.split(/\s+/)).toContain("group/wb");
  });

  it("최대화 중에는 가려진 칸 수와 되돌리는 키를 말한다", () => {
    render(<Controlled initial={four()} />);
    fireEvent.keyDown(grid(), { key: "Enter", code: "Enter", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("workbench-status").textContent).toContain("칸 3개가 가려져 있습니다");
  });

  it("칸 닫기 버튼은 ⌘W를 약속하지 않는다(브라우저·셸 메뉴가 먼저 가져간다)", () => {
    render(<Controlled initial={four()} />);
    const close = screen.getAllByRole("button", { name: "칸 닫기" })[0]!;
    expect(close.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(close.getAttribute("title")).toBe("칸 닫기");
  });
});

describe("포커스 이동", () => {
  it("⌘⌥방향, ⌘] 순환, ⌃번호", () => {
    render(<Controlled initial={four()} />); // 포커스 p4(오른쪽 아래)
    expect(focusedPaneId()).toBe("p4");
    fireEvent.keyDown(grid(), { key: "ArrowUp", code: "ArrowUp", metaKey: true, altKey: true });
    expect(focusedPaneId()).toBe("p2");
    fireEvent.keyDown(grid(), { key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true });
    expect(focusedPaneId()).toBe("p1");
    fireEvent.keyDown(grid(), { key: "]", code: "BracketRight", metaKey: true });
    expect(focusedPaneId()).toBe("p3");
    fireEvent.keyDown(grid(), { key: "4", code: "Digit4", ctrlKey: true });
    expect(focusedPaneId()).toBe("p4");
  });

  it("포커스 칸으로 DOM 포커스가 옮겨 간다", () => {
    render(<Controlled initial={four()} />);
    fireEvent.keyDown(grid(), { key: "1", code: "Digit1", ctrlKey: true });
    expect(document.activeElement?.getAttribute("data-pane-id")).toBe("p1");
  });

  it("칸을 누르면 그 칸이 포커스", () => {
    render(<Controlled initial={four()} />);
    fireEvent.pointerDown(panes()[0]!);
    expect(focusedPaneId()).toBe("p1");
  });

  it("⌘W는 포커스 칸을 닫는다", () => {
    render(<Controlled initial={four()} />);
    fireEvent.keyDown(grid(), { key: "w", code: "KeyW", metaKey: true });
    expect(panes()).toHaveLength(3);
    expect(panes().map((p) => p.getAttribute("data-pane-id"))).not.toContain("p4");
  });
});

describe("경계", () => {
  function splitter() {
    return screen.getByRole("separator");
  }

  it("화살표 한 번에 5%, Home·End는 최소 크기 끝까지", () => {
    render(<Controlled initial={splitPane(defaultWorkbenchLayout(), "p1", "row", BIG).layout} />);
    expect(splitter().getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
    expect(splitter().getAttribute("aria-valuenow")).toBe("45");
    fireEvent.keyDown(splitter(), { key: "Home" });
    expect(splitter().getAttribute("aria-valuenow")).toBe(splitter().getAttribute("aria-valuemin"));
    fireEvent.keyDown(splitter(), { key: "End" });
    expect(splitter().getAttribute("aria-valuenow")).toBe(splitter().getAttribute("aria-valuemax"));
  });

  it("더블클릭 두 단계 토글: ½ ↔ 기억한 비율", () => {
    render(<Controlled initial={splitPane(defaultWorkbenchLayout(), "p1", "row", BIG).layout} />);
    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
    fireEvent.keyDown(splitter(), { key: "ArrowLeft" }); // 40
    fireEvent.doubleClick(splitter());
    expect(splitter().getAttribute("aria-valuenow")).toBe("50");
    fireEvent.doubleClick(splitter());
    expect(splitter().getAttribute("aria-valuenow")).toBe("40");
  });

  it("끌기: 포인터 위치가 비율이 되고, 최소 크기에서 멈춘다", () => {
    render(<Controlled initial={splitPane(defaultWorkbenchLayout(), "p1", "row", BIG).layout} />);
    const box = document.querySelector<HTMLElement>('.wb-split[data-split-id="s2"]')!;
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: BIG.width,
      height: BIG.height,
      right: BIG.width,
      bottom: BIG.height,
      toJSON: () => ({}),
    });
    const s = splitter();
    fireEvent.pointerDown(s, { button: 0, clientX: 800 });
    // 경계 중심이 x=404이면 앞 칸 400 / (1600-8) ≈ 25%
    fireEvent.pointerMove(s, { clientX: 404 });
    expect(s.getAttribute("aria-valuenow")).toBe("25");
    // 너무 왼쪽: 최소 240px에서 멈춘다(240/1592 ≈ 15%)
    fireEvent.pointerMove(s, { clientX: 10 });
    expect(s.getAttribute("aria-valuenow")).toBe(String(Math.round((240 / 1592) * 100)));
    fireEvent.pointerUp(s);
    // 놓은 뒤 움직임은 무시한다.
    fireEvent.pointerMove(s, { clientX: 1200 });
    expect(s.getAttribute("aria-valuenow")).toBe(String(Math.round((240 / 1592) * 100)));
  });
});

// ---- 저장 -----------------------------------------------------------------------

function Persisted({ sessionKey, storage }: { sessionKey: string; storage: LayoutStorage | null }) {
  const { layout, storage: status, setLayout } = useWorkbenchLayout(sessionKey, storage);
  return (
    <WorkbenchGrid layout={layout} onLayoutChange={setLayout} storage={status} platform="mac" size={BIG} />
  );
}

describe("세션마다 이 기기에 저장", () => {
  it("나눈 배치가 다시 열어도 남는다", () => {
    const storage = memoryLayoutStorage();
    const first = render(<Persisted sessionKey="~/a" storage={storage} />);
    fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    first.unmount();
    render(<Persisted sessionKey="~/a" storage={storage} />);
    expect(panes()).toHaveLength(2);
    expect(storage.getItem(workbenchLayoutEntry("~/a"))).not.toBeNull();
  });

  it("세션을 바꾸면 그 세션의 배치, 돌아오면 원래 배치", () => {
    const storage = memoryLayoutStorage();
    const view = render(<Persisted sessionKey="~/a" storage={storage} />);
    fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    expect(panes()).toHaveLength(3);
    view.rerender(<Persisted sessionKey="~/b" storage={storage} />);
    expect(panes()).toHaveLength(1);
    view.rerender(<Persisted sessionKey="~/a" storage={storage} />);
    expect(panes()).toHaveLength(3);
    // b는 a의 배치로 덮이지 않았다.
    expect(storage.getItem(workbenchLayoutEntry("~/b"))).toBeNull();
  });

  it("깨진 저장값은 칸 하나로 그린다", () => {
    const storage = memoryLayoutStorage({ [workbenchLayoutEntry("~/a")]: "{broken" });
    render(<Persisted sessionKey="~/a" storage={storage} />);
    expect(panes()).toHaveLength(1);
  });

  it("읽기가 던져도 그린다(칸 하나), 저장 실패를 한 줄로 말한다", () => {
    const storage: LayoutStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    render(<Persisted sessionKey="~/a" storage={storage} />);
    expect(panes()).toHaveLength(1);
    expect(screen.getByTestId("workbench-status").textContent).toContain("저장하지 못했습니다");
  });

  it("쓰기가 던져도 배치는 바뀌고, 저장 실패를 말한다", () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    render(<Persisted sessionKey="~/a" storage={storage} />);
    expect(screen.getByTestId("workbench-status").textContent).not.toContain("저장하지 못했습니다");
    act(() => {
      fireEvent.keyDown(grid(), { key: "d", code: "KeyD", metaKey: true });
    });
    expect(panes()).toHaveLength(2);
    expect(screen.getByTestId("workbench-status").textContent).toContain("저장하지 못했습니다");
  });

  it("저장소가 아예 없어도(null) 그린다", () => {
    render(<Persisted sessionKey="~/a" storage={null} />);
    expect(panes()).toHaveLength(1);
  });
});

describe("하네스", () => {
  it.each([
    ["two", 2, false],
    ["four", 4, false],
    ["max", 4, true],
  ] as const)("?preset=%s → 칸 %i개", (preset, count, maximized) => {
    render(
      <MemoryRouter initialEntries={[`/design/workbench?preset=${preset}`]}>
        <WorkbenchHarness />
      </MemoryRouter>
    );
    expect(panes()).toHaveLength(count);
    expect(panes().some((p) => p.hasAttribute("data-maximized"))).toBe(maximized);
  });
});
