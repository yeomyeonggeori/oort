// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { defaultWorkbenchLayout, splitPane } from "@momo/core/features/workbench/layoutTree";
import type { Size } from "@momo/core/features/workbench/layoutTree";
import { WorkbenchGrid, type PaneStatusView } from "./WorkbenchGrid";

// #3279: 칸 크롬 경량화. jsdom은 CSS 호버를 계산하지 않으므로 「호버·포커스 때만 보임」은
// 클래스 계약으로, 「키보드로 닿는다」는 실제 DOM(탭 순서·aria-label)으로 잰다.

const BIG: Size = { width: 1600, height: 1000 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function three() {
  let l = splitPane(defaultWorkbenchLayout(), "p1", "row", BIG).layout;
  l = splitPane(l, "p2", "column", BIG).layout;
  return l;
}

const WAIT: PaneStatusView = {
  mark: <i />,
  label: "응답 필요",
  waiting: { line: "실행 허락을 기다려요", keycap: "⌃⇧J", mark: <i /> },
};

function renderGrid(waitingId: string | null = "p2") {
  return render(
    <MemoryRouter>
      <WorkbenchGrid
        layout={three()}
        onLayoutChange={() => {}}
        platform="mac"
        size={BIG}
        paneStatus={(p) => (p.id === waitingId ? WAIT : null)}
        paneLane={() => ({ kind: "local", label: "로컬", icon: <i /> })}
      />
    </MemoryRouter>
  );
}

const panes = () => screen.getAllByTestId("workbench-pane");

describe("칸 단추는 호버·포커스 때만 보인다", () => {
  it("단추 묶음이 호버·포커스 안·최대화·터치에서만 드러나고, 숨은 동안은 포인터를 받지 않는다", () => {
    renderGrid();
    for (const pane of panes()) {
      expect(pane.className.split(/\s+/)).toContain("group/pane");
      const cls = within(pane).getByTestId("workbench-pane-actions").className.split(/\s+/);
      expect(cls).toContain("opacity-0");
      expect(cls).toContain("pointer-events-none");
      expect(cls).toContain("group-hover/pane:opacity-100");
      expect(cls).toContain("has-[:focus-visible]:opacity-100");
      expect(cls).toContain("has-[:focus-visible]:pointer-events-auto");
    }
  });

  it("단추는 늘 DOM에 있어 Tab으로 닿고, 이름(aria-label)이 있고, 포커스 링을 가진다", () => {
    renderGrid();
    const first = panes()[0]!;
    const buttons = within(first).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "오른쪽으로 분할",
      "아래로 분할",
      "칸 최대화",
      "칸 닫기",
    ]);
    for (const b of buttons) {
      expect(b.hasAttribute("tabindex") ? b.getAttribute("tabindex") : "0").not.toBe("-1");
      expect(b.className).toContain("focus-visible:focus-ring");
      expect(b.hasAttribute("hidden")).toBe(false);
    }
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("머리 한 줄: 번호, 레인 표지, 제목 순서이고 레인 표지는 남는다", () => {
    renderGrid();
    const header = within(panes()[0]!).getByTestId("workbench-pane-lane").parentElement!;
    const order = Array.from(header.children).map((c) => c.getAttribute("data-testid") ?? c.textContent);
    expect(order.slice(0, 3)).toEqual(["1", "workbench-pane-lane", "칸 1"]);
    expect(header.className.split(/\s+/)).not.toContain("border-b");
  });

  it("단축키는 그대로: 칸 닫기 단추와 ⌘W 안내", () => {
    renderGrid();
    const close = within(panes()[0]!).getByRole("button", { name: "칸 닫기" });
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Meta+W");
    fireEvent.keyDown(screen.getByTestId("workbench-grid"), { key: "d", code: "KeyD", metaKey: true });
  });
});

describe("신호색은 「응답 필요」 칸만", () => {
  it("wb-waiting은 응답 필요 칸에만 붙고, 다른 칸의 클래스에 signal이 없다", () => {
    renderGrid("p2");
    const waiting = panes().filter((p) => p.hasAttribute("data-waiting"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.getAttribute("data-pane-id")).toBe("p2");
    expect(waiting[0]!.className).toContain("wb-waiting");
    expect(waiting[0]!.getAttribute("aria-label")).toContain("응답 필요");
    for (const p of panes().filter((x) => x !== waiting[0])) {
      expect(p.className).not.toContain("wb-waiting");
      expect(p.querySelector('[class*="signal"]')).toBeNull();
      expect(p.querySelector('[data-testid="workbench-pane-waiting"]')).toBeNull();
    }
  });

  it("응답 필요 칸이 없으면 어느 칸에도 신호색이 없다", () => {
    renderGrid(null);
    for (const p of panes()) {
      expect(p.className).not.toContain("wb-waiting");
      expect(p.querySelector('[class*="signal"]')).toBeNull();
    }
  });

  it("경계는 얇은 선이다(둥근 알약 손잡이가 아니다)", () => {
    renderGrid();
    for (const sp of screen.getAllByTestId("workbench-splitter")) {
      const line = sp.firstElementChild as HTMLElement;
      expect(line.className).not.toContain("rounded-full");
      expect(line.className).toMatch(/h-full w-px|h-px w-full/);
    }
  });
});
