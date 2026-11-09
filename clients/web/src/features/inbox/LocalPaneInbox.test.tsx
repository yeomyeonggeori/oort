// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createPaneAttention, type PaneObservation } from "@/features/workbench/local/paneAttention";
import { LocalPaneInbox } from "./LocalPaneInbox";

// design-review #5584 H1: 인박스 「이 기기의 칸」 줄은 실패한 턴을 성공(✓·「작업이 끝났어요」)으로 말하지 않는다.

afterEach(cleanup);

function storeWith(...steps: PaneObservation[][]) {
  const store = createPaneAttention({ notify: vi.fn(), windowFocused: () => false, now: () => 1_000 });
  for (const panes of steps) store.observe(panes, null);
  return store;
}

const pane = (over: Partial<PaneObservation>): PaneObservation => ({
  paneId: "p3",
  index: 3,
  name: "빌드 스크립트 정리",
  status: "running",
  signal: "working",
  ...over,
});

function rows(store: ReturnType<typeof createPaneAttention>) {
  const view = render(
    <MemoryRouter>
      <LocalPaneInbox store={store} />
    </MemoryRouter>
  );
  return view.getAllByTestId("inbox-local-pane");
}

describe("LocalPaneInbox", () => {
  it("실패한 턴: 빨간 ✕ 표지(「실패」)와 「오류로 끝났어요」", () => {
    const store = storeWith([pane({})], [pane({ status: "done", mark: "failed", signal: "turn-failed" })]);
    const [row] = rows(store);
    expect(row!.querySelector("[data-testid='status-mark']")?.getAttribute("data-status")).toBe("failed");
    expect(row!.textContent).toContain("오류로 끝났어요");
    expect(row!.textContent).toContain("실패");
    expect(row!.textContent).not.toContain("작업이 끝났어요");
    expect(row!.textContent).not.toContain("끝남");
  });

  it("끝난 턴은 그대로 ✓ 「작업이 끝났어요」", () => {
    const store = storeWith([pane({})], [pane({ status: "done", mark: "done", signal: "turn-done" })]);
    const [row] = rows(store);
    expect(row!.querySelector("[data-testid='status-mark']")?.getAttribute("data-status")).toBe("done");
    expect(row!.textContent).toContain("작업이 끝났어요");
  });

  it("「끝남」 줄이 남은 칸에 실패가 오면 줄이 실패로 바뀐다", () => {
    const store = storeWith([pane({})], [pane({ status: "done", mark: "done", signal: "turn-done" })]);
    const view = render(
      <MemoryRouter>
        <LocalPaneInbox store={store} />
      </MemoryRouter>
    );
    act(() => store.observe([pane({ status: "done", mark: "failed", signal: "turn-failed" })], null));
    expect(view.getAllByTestId("inbox-local-pane").map((r) => r.textContent)).toEqual([
      expect.stringContaining("오류로 끝났어요"),
    ]);
  });
});
