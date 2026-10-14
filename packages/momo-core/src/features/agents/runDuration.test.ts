import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "../../lib/api";
import {
  DURATION_UNKNOWN,
  durationText,
  runDurationBreakdown,
  runDurations,
  runTookText,
  runWorkingText,
  spanText,
} from "./runDuration";
import { runPhaseDetail, serverFactsOf } from "./runPhase";

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

function progress(extra: Partial<AgentRunProgress>): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: "00000000-0000-7000-8000-000000000201",
    agentMemberId: "00000000-0000-7000-8000-000000000301",
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

const facts = (extra: Partial<AgentRunProgress>) => serverFactsOf(progress(extra));

describe("durationText: 끝난 구간은 초까지", () => {
  it.each([
    [0, "1초 미만"],
    [999, "1초 미만"],
    [12 * SEC, "12초"],
    [59 * SEC, "59초"],
    [60 * SEC, "1분"],
    [3 * MIN + 12 * SEC, "3분 12초"],
    [9 * MIN + 59 * SEC, "9분 59초"],
    [12 * MIN + 30 * SEC, "12분"],
    [65 * MIN, "1시간 5분"],
    [120 * MIN, "2시간"],
    [26 * 60 * MIN, "1일 2시간"],
    [-5 * SEC, "1초 미만"],
  ])("%d ms → %s", (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});

describe("spanText: 늘어나는 구간은 한 단위만", () => {
  it.each([
    [40 * SEC, "40초"],
    [12 * MIN + 59 * SEC, "12분"],
    [3 * 60 * MIN + 1, "3시간"],
    [50 * 60 * MIN, "2일"],
  ])("%d ms → %s", (ms, text) => {
    expect(spanText(ms)).toBe(text);
  });
});

describe("runDurations: 대기 → 작업 → 총, 모르는 시각은 메우지 않는다", () => {
  it("끝난 run은 세 구간을 모두 잰다", () => {
    const f = facts({
      phase: "succeeded",
      status: "succeeded",
      claimedAtMs: T + 12 * SEC,
      startedAtMs: T + 14 * SEC,
      finishedAtMs: T + 3 * MIN + 12 * SEC,
    });
    expect(runDurations(f, T + 99 * MIN)).toEqual({
      waitMs: 12 * SEC,
      workMs: 2 * MIN + 58 * SEC,
      totalMs: 3 * MIN + 12 * SEC,
      open: false,
    });
    expect(runDurationBreakdown(f, T + 99 * MIN)).toBe("대기 12초 → 작업 2분 58초 → 총 3분 12초");
    expect(runTookText(f)).toBe("3분 12초 걸림");
  });

  it("끝난 시각이 없으면 총은 「모름」이지 지금까지가 아니다", () => {
    const f = facts({ phase: "failed", status: "failed", claimedAtMs: T + SEC, startedAtMs: T + 2 * SEC });
    expect(runDurations(f, T + 10 * MIN).totalMs).toBeUndefined();
    expect(runDurations(f, T + 10 * MIN).workMs).toBeUndefined();
    expect(runDurationBreakdown(f, T + 10 * MIN)).toBe(
      `대기 1초 → 작업 ${DURATION_UNKNOWN} → 총 ${DURATION_UNKNOWN}`
    );
    expect(runTookText(f)).toBe("걸린 시간 모름");
  });

  it("시작 시각이 없으면 작업 시간을 가져간 때부터 세지 않는다", () => {
    const f = facts({
      phase: "running",
      status: "running",
      leaseState: "live",
      claimedAtMs: T + 30 * SEC,
      lastEventAtMs: T + 5 * MIN,
    });
    expect(runDurations(f, T + 6 * MIN).workMs).toBeUndefined();
    expect(runWorkingText(f, T + 6 * MIN)).toBe("작업 시간 모름 · 마지막 보고 1분 전");
    expect(runDurationBreakdown(f, T + 6 * MIN)).toBe("대기 30초 → 작업 모름");
  });

  it("대기 중인 run은 대기만, 지금까지 센다", () => {
    const f = facts({});
    expect(runDurationBreakdown(f, T + 45 * SEC)).toBe("대기 45초째");
  });

  it("아무도 가져가지 않고 끝난 run은 끝날 때까지가 대기이고 작업 구간이 없다", () => {
    const f = facts({
      phase: "timed_out",
      status: "timed_out",
      endReason: "unclaimed_expired",
      finishedAtMs: T + 30 * MIN,
    });
    expect(runDurationBreakdown(f, T + 99 * MIN)).toBe("대기 30분 → 총 30분");
  });

  it("서버 시계가 조금 앞서도 음수를 말하지 않는다", () => {
    const f = facts({});
    expect(runDurationBreakdown(f, T - 3 * SEC)).toBe("대기 1초 미만째");
  });
});

describe("runPhaseDetail이 같은 말을 쓴다 (표면 공용)", () => {
  it("작업 중: 「12분째 · 마지막 보고 1분 전」", () => {
    const f = facts({
      phase: "running",
      status: "running",
      leaseState: "live",
      claimedAtMs: T,
      startedAtMs: T,
      lastEventAtMs: T + 11 * MIN,
    });
    expect(runPhaseDetail(f, T + 12 * MIN)).toBe("12분째 · 마지막 보고 1분 전");
  });

  it("끝: 「3분 12초 걸림」에 아는 사유만 붙는다", () => {
    const done = facts({ phase: "succeeded", status: "succeeded", finishedAtMs: T + 3 * MIN + 12 * SEC });
    expect(runPhaseDetail(done, T + 99 * MIN)).toBe("3분 12초 걸림");
    const cancelled = facts({
      phase: "cancelled",
      status: "cancelled",
      endReason: "cancelled_by_member",
      finishedAtMs: T + 2 * MIN,
    });
    expect(runPhaseDetail(cancelled, T + 99 * MIN)).toBe("2분 걸림 · 멤버가 취소했어요");
    const unknownCode = facts({ phase: "failed", status: "failed", endReason: "brand_new" });
    expect(runPhaseDetail(unknownCode, T)).toBe("걸린 시간 모름");
  });

  it("대기: 1분 전에도 초로 말한다", () => {
    expect(runPhaseDetail(facts({ queuePosition: 1 }), T + 8 * SEC)).toBe("8초째 기다려요");
  });
});
