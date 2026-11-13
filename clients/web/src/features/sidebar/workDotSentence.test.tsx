// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PANE_UNSEEN_LABEL } from "@momo/core/features/workbench/paneStatus";
import type { NeedsMe } from "@momo/core/features/inbox/needsMe";
import type { PaneAttentionEntry } from "@/features/workbench/local/paneAttention";

// =============================================================================
// design-review #5584 r2 H1 (b)·G1: 「작업」 점은 글자가 없어 읽기 도구에는 접근 이름의 문장만 닿는다.
// 빨간 점(오류로 끝난 칸)이 「아직 안 본 끝난 세션」으로 들리면 실패가 성공으로 들린다. 펼친 줄과 접힌 레일이
// 같은 칸 판정에서 **같은 문장**을 말하는지 실제로 그려서 잰다(점의 톤만 재던 시험은 문장을 되돌려도 초록이었다).
// =============================================================================

const pane = vi.hoisted(() => ({ entries: [] as PaneAttentionEntry[] }));
vi.mock("@/features/workbench/local/paneAttention", () => ({ useLocalPaneAttention: () => pane.entries }));
vi.mock("@/features/scheduled/useScheduled", () => ({ useScheduled: () => ({ surface: "absent" }) }));
vi.mock("@/features/drafts/DraftsNavItem", () => ({ DraftsNavItem: () => null }));
vi.mock("@/features/workspace/useAddWorkspace", () => ({ useOpenAddWorkspace: () => () => undefined }));
vi.mock("./useWorkspaceAvatar", () => ({ useWorkspaceAvatar: () => undefined }));
vi.mock("@/features/emoji/useHoverNone", () => ({ useHoverNone: () => false }));

import { SidebarDestinations } from "./SidebarDestinations";
import { WorkspaceRail } from "./WorkspaceRail";
import { destinationMarks } from "./sidebarBadge";

afterEach(() => {
  cleanup();
  pane.entries = [];
});

const NONE: NeedsMe = { total: 0, panes: 0 } as unknown as NeedsMe;
const ACTIVE = { inbox: false, directory: false, ai: false, agents: false, work: false } as never;

function entry(paneId: string, mark: "done" | "failed", index: number): PaneAttentionEntry {
  return {
    paneId,
    status: "done",
    mark,
    signal: mark === "failed" ? "turn-failed" : "turn-done",
    index,
    name: mark === "failed" ? "빌드 스크립트 정리" : "로그 회전 설정",
    atMs: 1_000 + index,
  };
}

/** 펼친 「작업」 줄의 접근 이름. */
function expandedName(entries: PaneAttentionEntry[]): string | null {
  pane.entries = entries;
  const view = render(
    <MemoryRouter>
      <SidebarDestinations active={ACTIVE} needsMe={NONE} />
    </MemoryRouter>
  );
  const name = view.getByTestId("nav-work").getAttribute("aria-label");
  view.unmount();
  return name;
}

/** 접힌 레일 「작업」의 접근 이름(셸 `Sidebar.tsx`와 같은 입력으로 표지를 푼다). */
function railName(entries: PaneAttentionEntry[]): string | null {
  const marks = destinationMarks({
    needsMe: NONE,
    unreadChannels: 0,
    doneUnseen: entries.some((e) => e.status === "done"),
    failedUnseen: entries.some((e) => e.mark === "failed"),
  });
  const view = render(
    <MemoryRouter>
      <WorkspaceRail workspace={{ name: "w", isPending: false, isError: false }} workspaceId="w" active={null} collapsed marks={marks} />
    </MemoryRouter>
  );
  const link = view.getByTestId("rail-work");
  const name = link.getAttribute("aria-label");
  expect(view.getByTestId("rail-work-dot").getAttribute("data-tone")).toBe(entries.some((e) => e.mark === "failed") ? "danger" : "ok");
  view.unmount();
  return name;
}

describe("「작업」 점의 문장: 실패는 실패라고 말한다 (#5584 r2 H1 (b))", () => {
  it("안 본 칸 중 하나라도 오류로 끝났으면 펼친 줄과 접힌 레일 모두 「오류로 끝난 세션이 있어요」", () => {
    const entries = [entry("p3", "failed", 3), entry("p4", "done", 4)];
    expect(expandedName(entries)).toBe("작업, 오류로 끝난 세션이 있어요");
    expect(railName(entries)).toBe("작업, 오류로 끝난 세션이 있어요");
    // 사전 값과도 같다(문장이 한 자리에서 나온다).
    expect(expandedName(entries)).toBe(`작업, ${PANE_UNSEEN_LABEL.failed}`);
  });

  it("실패만 있어도 같다. 성공의 문장(「아직 안 본 끝난 세션」)은 어디에도 없다", () => {
    const entries = [entry("p3", "failed", 3)];
    for (const name of [expandedName(entries), railName(entries)]) {
      expect(name).toContain("오류로 끝난 세션이 있어요");
      expect(name).not.toContain("아직 안 본 끝난 세션이 있어요");
    }
  });

  it("모두 잘 끝났으면 두 자리 모두 「아직 안 본 끝난 세션이 있어요」(실패 문장을 아무 데나 달지 않는다)", () => {
    const entries = [entry("p4", "done", 4)];
    expect(expandedName(entries)).toBe("작업, 아직 안 본 끝난 세션이 있어요");
    expect(railName(entries)).toBe("작업, 아직 안 본 끝난 세션이 있어요");
  });

  it("점이 없으면 문장도 없다", () => {
    expect(expandedName([])).toBeNull();
  });
});
