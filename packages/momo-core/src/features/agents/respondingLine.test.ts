import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "../../lib/api";
import { keepsRunReceipt, type DoorbellFact } from "./runStatusLine";
import {
  activityDetail,
  activityLines,
  activitySuffix,
  activityText,
  isRespondingLine,
} from "./turnCopy";
import { signalFromProgress } from "./runPhase";

// #4020 — 메시지마다 붙던 영수증을 빼고, 컴포저 위 한 줄이 「답하는 중」을 말한다.

const T = 1_800_000_000_000;
const MIN = 60_000;
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const names = (id: string) => ({ name: id === AGENT ? "그록" : "김인턴" });

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    createdAtMs: T,
    updatedAtMs: T,
    ...extra,
  };
}

function lineOf(extra: Partial<AgentRunProgress>) {
  const signal = signalFromProgress(progress(extra));
  if (signal === null) throw new Error("signal");
  return activityLines([signal], names).lines[0]!;
}

const OK_BELL: DoorbellFact = { lastAtMs: T, failed: false, count: 1 };
const BAD_BELL: DoorbellFact = { lastAtMs: T, failed: true, count: 1 };

describe("컴포저 줄: 가져가서 쓰는 동안만 「답하는 중」", () => {
  it("가져감·작업 중은 답하는 중이다", () => {
    const claimed = lineOf({ phase: "claimed", status: "claimed", leaseState: "live", claimedAtMs: T });
    const running = lineOf({ phase: "running", status: "running", leaseState: "live", startedAtMs: T });
    expect(isRespondingLine(claimed)).toBe(true);
    expect(isRespondingLine(running)).toBe(true);
    expect(activityText(claimed)).toBe("그록이 답하는 중");
    expect(activityText(running)).toBe("그록이 답하는 중");
  });

  it("아직 아무도 가져가지 않은 대기·승인 대기·소식 끊긴 가져감은 답하는 중이 아니다", () => {
    const queued = lineOf({ queuePosition: 2 });
    const waiting = lineOf({ phase: "awaiting_approval", status: "awaiting_approval" });
    const stale = lineOf({ phase: "claimed", status: "claimed", leaseState: "stale", claimedAtMs: T });
    for (const line of [queued, waiting, stale]) {
      expect(isRespondingLine(line)).toBe(false);
      expect(activityText(line)).not.toContain("답하는 중");
    }
    expect(activityText(queued)).toBe("그록: 대기 2번째");
    expect(activitySuffix(waiting)).toContain("승인을 기다립니다");
  });

  it("조사는 이름이 정한다", () => {
    const line = lineOf({ phase: "running", status: "running", leaseState: "live" });
    expect(activitySuffix({ ...line, name: { name: "김인턴" } })).toBe("이 답하는 중");
    expect(activitySuffix({ ...line, name: { name: "허미" } })).toBe("가 답하는 중");
  });

  it("에이전트가 보고한 단계는 문장을 바꾸지 않고 곁의 보조 글이 된다", () => {
    const line = lineOf({
      phase: "running",
      status: "running",
      leaseState: "live",
      startedAtMs: T,
      latestStage: "채널 이름 확인",
    });
    expect(activityText(line)).toBe("그록이 답하는 중");
    expect(activityDetail(line, T + 2 * MIN)).toContain("채널 이름 확인");
  });
});

describe("keepsRunReceipt: 타임라인 본 줄에는 사람이 알아야 하는 상태만", () => {
  it("평소의 진행·완료는 줄을 남기지 않는다", () => {
    expect(keepsRunReceipt(progress(), null)).toBe(false);
    expect(keepsRunReceipt(progress(), OK_BELL)).toBe(false);
    expect(keepsRunReceipt(progress({ phase: "claimed", leaseState: "live" }), OK_BELL)).toBe(false);
    expect(keepsRunReceipt(progress({ phase: "running", leaseState: "live" }), null)).toBe(false);
    expect(keepsRunReceipt(progress({ phase: "succeeded", leaseState: "none" }), null)).toBe(false);
    expect(keepsRunReceipt(progress({ phase: "cancelled", leaseState: "none" }), null)).toBe(false);
  });

  it("실패·시간 초과·신호 소실·승인 대기·일시 정지는 남긴다", () => {
    for (const phase of ["failed", "timed_out", "awaiting_approval", "paused"] as const) {
      expect(keepsRunReceipt(progress({ phase }), null)).toBe(true);
    }
    expect(
      keepsRunReceipt(progress({ phase: "timed_out", endReason: "lease_abandoned" }), null)
    ).toBe(true);
  });

  it("깨우는 신호가 닿지 않았거나 가져간 뒤 소식이 끊기면 남긴다", () => {
    expect(keepsRunReceipt(progress(), BAD_BELL)).toBe(true);
    expect(keepsRunReceipt(progress({ phase: "claimed", leaseState: "live" }), BAD_BELL)).toBe(true);
    expect(keepsRunReceipt(progress({ phase: "claimed", leaseState: "stale" }), null)).toBe(true);
  });
});
