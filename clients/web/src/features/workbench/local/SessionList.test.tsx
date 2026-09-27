// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PANE_GIT_UNKNOWN, type SessionListInput } from "@momo/core/features/workbench/sessionList";
import { SessionList } from "./SessionList";

// 세션 목록 단독(#2856). 도크 없이 목록의 로빙·묶음 접기·들여쓰기만 잰다.

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
});

const git = (worktree: string, branch: string) => ({
  ...PANE_GIT_UNKNOWN,
  repo: "momo",
  repoKey: "momo",
  worktree,
  branch,
  isDefault: worktree === "momo",
});

function key(target: Element, k: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function input(index: number, over: Partial<SessionListInput>): SessionListInput {
  return {
    paneId: `p${index}`,
    index,
    title: `세션 ${index}`,
    harness: "셸",
    status: "running",
    shared: false,
    git: git("momo", "main"),
    ...over,
  };
}

function mount(sessions: SessionListInput[], focusedPaneId: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(SessionList, {
        sessions,
        focusedPaneId,
        platform: "mac",
        onActivate: () => undefined,
        onMaximize: () => undefined,
        onFocusIndex: () => undefined,
        onCollapse: () => undefined,
        newSessionItems: null,
      })
    );
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid='session-list-row']")];
const groups = () => [...document.querySelectorAll<HTMLElement>("[data-testid='session-list-group']")];

describe("SessionList", () => {
  it("지금 칸이 든 묶음을 접어도 로빙 탭 자리는 그려진 행 하나에 남는다(design-review M2)", () => {
    window.localStorage.setItem("momo.web.workbench.sessionList.v1", JSON.stringify({ filter: "all", grouping: "status" }));
    mount([input(1, {}), input(2, { status: "done" }), input(3, {})], "p2");
    expect(groups().map((g) => g.textContent)).toEqual(["실행 중2", "끝남1"]);
    const done = groups()[1]!;
    act(() => done.click());
    expect(rows().map((r) => r.getAttribute("data-session-pane"))).toEqual(["p1", "p3"]);
    const stops = rows().filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("data-session-pane")).toBe("p1");
  });

  it("상태로 묶은 줄은 worktree 줄(저장소 · 브랜치)을 함께 싣고, 폴더 셸은 들여쓰지 않는다", () => {
    mount(
      [
        input(1, {}),
        input(2, { git: git("2774-xterm", "feat/2774-xterm") }),
        input(3, { git: PANE_GIT_UNKNOWN, title: "홈 셸" }),
      ],
      "p1"
    );
    // 저장소 둘(momo·폴더) → 머리 둘.
    expect(groups().map((g) => g.textContent)).toEqual(["momo2", "폴더1"]);
    const folder = rows().find((r) => r.getAttribute("data-session-pane") === "p3")!;
    expect(folder.getAttribute("data-depth")).toBe("0");
    expect(folder.hasAttribute("data-with-worktree")).toBe(false);
    const flat = rows().find((r) => r.getAttribute("data-session-pane") === "p2")!;
    expect(flat.hasAttribute("data-with-worktree")).toBe(true);
    expect(flat.textContent).toContain("feat/2774-xterm");
    expect(document.querySelector("[data-testid='session-list-repo']")?.textContent).toContain("모든 저장소");
  });

  it("트리 역할: 머리·줄이 treeitem, ←는 줄에서 머리로·머리를 접고, →는 편다(검수 #2951 M5)", () => {
    mount([input(1, {}), input(2, { git: PANE_GIT_UNKNOWN, title: "홈 셸" })], "p1");
    expect(document.querySelector("[data-testid='session-list-tree']")?.getAttribute("role")).toBe("tree");
    const row = rows()[0]!;
    expect(row.getAttribute("role")).toBe("treeitem");
    expect(row.getAttribute("aria-level")).toBe("2");
    expect(row.getAttribute("aria-selected")).toBe("true");
    act(() => row.focus());
    key(row, "ArrowLeft");
    const head = groups()[0]!;
    expect(document.activeElement).toBe(head);
    key(head, "ArrowLeft");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(rows().map((r) => r.getAttribute("data-session-pane"))).toEqual(["p2"]);
    key(groups()[0]!, "ArrowRight");
    expect(groups()[0]!.getAttribute("aria-expanded")).toBe("true");
    // ↓는 머리와 줄을 함께 돈다.
    key(groups()[0]!, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-session-pane")).toBe("p1");
  });

  it("확인 중(git null)인 칸은 묶지 않고 막대 줄로 끝에, 읽기 도구에는 「git 확인 중」", () => {
    mount([input(1, {}), input(2, { git: null, title: "새 셸" })], "p1");
    const pending = rows().find((r) => r.getAttribute("data-session-pane") === "p2")!;
    expect(pending.hasAttribute("data-checking")).toBe(true);
    expect(pending.getAttribute("aria-label")).toContain("git 확인 중");
    expect(rows().map((r) => r.getAttribute("data-session-pane"))).toEqual(["p1", "p2"]);
  });

  it("분리된 HEAD 평탄화 줄은 폴더와 「분리된 HEAD」를 보이고 이름에도 싣는다(검수 #2951 M1)", () => {
    mount(
      [
        input(1, {}),
        input(2, {}),
        input(3, { git: { ...git("bisect", "x"), branch: null, detached: true } }),
      ],
      "p1"
    );
    const row = rows().find((r) => r.getAttribute("data-session-pane") === "p3")!;
    expect(row.textContent).toContain("bisect (분리된 HEAD)");
    expect(row.getAttribute("aria-label")).toContain("bisect 분리된 HEAD");
  });
});
