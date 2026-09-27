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

const git = (worktree: string, branch: string) => ({ ...PANE_GIT_UNKNOWN, repo: "momo", worktree, branch, isDefault: worktree === "momo" });

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
        loading: false,
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
});
