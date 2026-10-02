import { describe, expect, it } from "vitest";
import { needsMe } from "./needsMe";

describe("needsMe (#3337 단일 출처)", () => {
  it("승인·응답 필요 칸·멘션을 모두 합한다", () => {
    expect(
      needsMe({
        decidableApprovalIds: ["a1", "a2"],
        waitingPaneIds: ["p1"],
        unreadMentions: 3,
      })
    ).toEqual({ approvals: 2, panes: 1, mentions: 3, total: 6 });
  });

  it("승인만 있어도 센다 (멘션만 세던 옛 배지의 회귀)", () => {
    expect(
      needsMe({ decidableApprovalIds: ["a1"], waitingPaneIds: [], unreadMentions: 0 }).total
    ).toBe(1);
  });

  it("응답 필요 칸만 있어도 센다", () => {
    expect(
      needsMe({ decidableApprovalIds: [], waitingPaneIds: ["p1", "p2"], unreadMentions: 0 }).total
    ).toBe(2);
  });

  it("같은 승인 id와 같은 칸 id는 한 번만 센다 (이중 계산 금지)", () => {
    const n = needsMe({
      decidableApprovalIds: ["a1", "a1", "a1"],
      waitingPaneIds: ["p1", "p1"],
      unreadMentions: 0,
    });
    expect(n).toEqual({ approvals: 1, panes: 1, mentions: 0, total: 2 });
  });

  it("음수·NaN 멘션 수는 0으로 접는다", () => {
    expect(needsMe({ decidableApprovalIds: [], waitingPaneIds: [], unreadMentions: -2 }).total).toBe(0);
    expect(needsMe({ decidableApprovalIds: [], waitingPaneIds: [], unreadMentions: NaN }).total).toBe(0);
  });
});
