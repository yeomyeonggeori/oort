import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// #5193 — 메뉴 막대 아이콘은 앱 셸이 `TrayStatus`를 꽂을 때만 선다. 컴포넌트·셸·다리의 시험이 모두 초록이어도 꽂는 한 줄이
// 지워지면 아이콘은 아예 없다(소리 없는 실패). 규칙은 다른 시험이 재고, 이 시험은 **배선**을 잰다 —
// `features/agents/approvalWaitWiring.test.ts`가 `<ApprovalsLiveSync />`로 같은 일을 한다.
// =============================================================================

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("메뉴 막대 배선 (#5193)", () => {
  it("앱 셸은 독 배지와 같은 자리(stress 모드 밖)에서 TrayStatus를 마운트한다", () => {
    const shell = source("../../app/AppShell.tsx");
    expect(shell).toContain('import { TrayStatus } from "@/features/notifications/TrayStatus";');
    expect(shell).toMatch(/\{!stress && <DockBadge \/>\}[\s\S]{0,400}\{!stress && <TrayStatus \/>\}/);
  });

  // 작업 줄이 가는 곳(`adeItemLanding`, 코어)은 관제 서랍의 카드(`AdeDrawer.openItem`)가 쓰는 규칙의 사본이다. 서랍은 이 시험의
  // 시야 밖에서 바뀔 수 있어서(서랍 시험은 카드 열기를 재지 않는다), 서랍이 규칙을 바꾸면 여기가 붉어져 사본을 함께 고치게 한다.
  // 두 곳을 하나로 합치는 일은 후속이다(서랍 시험이 먼저 필요하다).
  it("작업 줄이 가는 곳은 관제 서랍의 카드와 같은 규칙이다: 서랍이 규칙을 바꾸면 adeItemLanding도 함께 고친다", () => {
    const drawer = source("../ade/AdeDrawer.tsx");
    expect(drawer).toContain('item.kind === "run" && item.runId && item.memberId');
    expect(drawer).toContain('origin: "ade"');
    expect(drawer).toContain("navigate(workSessionPath(item.channelId, item.sessionId));");
    const landing = source("../../../../../packages/momo-core/src/features/work/adeLanding.ts");
    expect(landing).toContain('item.kind === "run" && item.runId && item.memberId');
    expect(landing).toContain('origin: "ade"');
  });

  it("독 배지와 메뉴 막대는 수를 같은 훅에서 받는다: 어느 한쪽이 자기 계산을 하지 않는다", () => {
    expect(source("./DockBadge.tsx")).toContain("useDockBadgeCount()");
    expect(source("./TrayStatus.tsx")).toContain("useDockBadgeCount()");
  });
});
