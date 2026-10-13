import { describe, expect, it } from "vitest";
import {
  applyApprovalWaits,
  type AgentWorkingSignal,
  type ApprovalWait,
} from "./workingSignal";

const CH = "00000000-0000-7000-8000-0000000000c1";
const AGENT = "00000000-0000-7000-8000-0000000000a1";
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const NOW = 2_000_000_000_000;

function working(memberId = AGENT): AgentWorkingSignal {
  return {
    memberId,
    channelId: CH,
    state: "working",
    source: "run",
    runId: "run-1",
    startedAtMs: NOW - 30_000,
    headlines: ["채널을 만드는 중"],
    lastActivityAtMs: NOW - 1_000,
  };
}
const wait = (extra: Partial<ApprovalWait> = {}): ApprovalWait => ({
  channelId: CH,
  requestedBy: AGENT,
  expiresAtMs: NOW + 3_600_000,
  ...extra,
});

describe("승인 기다림이 작업 중을 이긴다 (#3738)", () => {
  it("같은 에이전트의 작업 중 턴은 승인 대기가 되고 헤드라인을 잃는다", () => {
    const [turn] = applyApprovalWaits([working()], CH, [wait()], NOW);
    expect(turn?.state).toBe("awaiting_approval");
    expect(turn?.headlines).toEqual([]);
    expect(turn?.runId).toBe("run-1");
  });

  it("레일이 턴을 잃었어도 살아 있는 승인이 턴을 세운다 (신호 소실 대신)", () => {
    const [turn] = applyApprovalWaits([], CH, [wait({ runId: "run-9" })], NOW);
    expect(turn).toMatchObject({
      memberId: AGENT,
      state: "awaiting_approval",
      runId: "run-9",
    });
    // 시작 시각을 지어내지 않는다.
    expect(turn?.startedAtMs).toBeUndefined();
  });

  it("기한이 지난 승인은 기다림이 아니다", () => {
    const turns = applyApprovalWaits(
      [working()],
      CH,
      [wait({ expiresAtMs: NOW })],
      NOW
    );
    expect(turns[0]?.state).toBe("working");
    expect(applyApprovalWaits([], CH, [wait({ expiresAtMs: NOW - 1 })], NOW)).toEqual([]);
  });

  it("다른 에이전트·다른 채널의 승인은 건드리지 않는다", () => {
    const turns = applyApprovalWaits(
      [working(OTHER)],
      CH,
      [wait(), wait({ channelId: "00000000-0000-7000-8000-0000000000c2", requestedBy: OTHER })],
      NOW
    );
    const other = turns.find((t) => t.memberId === OTHER);
    expect(other?.state).toBe("working");
    expect(turns.find((t) => t.memberId === AGENT)?.state).toBe("awaiting_approval");
  });

  it("대소문자가 달라도 같은 멤버로 읽는다", () => {
    const [turn] = applyApprovalWaits(
      [working(AGENT.toUpperCase())],
      CH,
      [wait()],
      NOW
    );
    expect(turn?.state).toBe("awaiting_approval");
  });

  it("입력 배열과 신호를 바꾸지 않는다", () => {
    const original = working();
    const input = [original];
    applyApprovalWaits(input, CH, [wait()], NOW);
    expect(original.state).toBe("working");
    expect(input).toHaveLength(1);
  });
});
