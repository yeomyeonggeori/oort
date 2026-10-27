import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// #3738 — 「승인 기다림이 작업 중을 이긴다」는 규칙(core `applyApprovalWaits`)은 두 표면이
// 실제로 그것을 거칠 때만 사람에게 닿는다: 사이드바의 채널 알약과 컴포저의 활동 줄.
// 규칙 자체는 core 시험이 재고, 이 시험은 **배선**을 잰다 — 호출 한 줄이 지워지면
// 규칙은 멀쩡한데 화면은 다시 「작업 중 → 신호 소실」로 돌아간다 (2026-10-13 실측).
// =============================================================================

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("승인 대기 배선 (#3738)", () => {
  it("사이드바 채널 알약은 열린 턴을 승인 원장에 통과시킨다", () => {
    const text = source("../sidebar/Sidebar.tsx");
    expect(text).toMatch(/applyApprovalWaits\(\s*agentTurnsInChannel\(/);
    expect(text).toContain("useApprovalWaits()");
  });

  it("컴포저 레일도 같은 통과를 한다(활동 줄은 #4619에서 입력창 레일로 옮겨 갔다)", () => {
    const rail = source("./ActivityRail.tsx");
    expect(rail).toMatch(/applyApprovalWaits\(\s*agentTurnsInChannel\(/);
    expect(rail).toContain("useApprovalWaits()");
    // 컴포저가 그 레일을 실제로 꽂는다: 레일이 멀쩡해도 꽂는 줄이 지워지면 화면은 다시 승인을 「작업 중」으로 말한다.
    expect(source("../chat/Composer.tsx")).toContain("<ComposerActivityRail");
  });

  it("앱 셸은 승인 실시간 동기를 마운트한다", () => {
    expect(source("../../app/AppShell.tsx")).toContain("<ApprovalsLiveSync />");
  });

  it("대기 승인 쿼리는 폴링 그물을 가진다", () => {
    const text = source("../inbox/useInbox.ts");
    expect(text).toContain("PENDING_APPROVALS_POLL_MS");
    expect(text).toMatch(/refetchInterval/);
  });
});
