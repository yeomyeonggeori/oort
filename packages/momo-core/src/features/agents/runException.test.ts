import { describe, expect, it } from "vitest";
import type { AgentRunProgress } from "../../lib/api";
import {
  isUncollectedPastGrace,
  nextUncollectedDeadlineMs,
  routineWaitText,
  runException,
  runExceptionText,
  UNCLAIMED_END_REASONS,
  UNCOLLECTED_GRACE_MS,
  UNCOLLECTED_HEADLINE,
  uncollectedDeadlineMs,
} from "./runException";
import { serverFactsOf } from "./runPhase";
import { UNCOLLECTED_AFTER_MS, UNCOLLECTED_WORD } from "./runWaiting";

// =============================================================================
// 타임라인 예외 줄의 판정 (#4619 D). 못 가져감 유예(예상 확인 시각이 있으면 그것, 없으면 2분)의
// 경계, 이유 문장의 순서, 예외가 아닌 상태, 초 단위 숫자가 없다는 것을 잰다.
// =============================================================================

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const RUN = "0199aa11-2222-7000-8000-0000000000a1";
const MSG = "00000000-0000-7000-8000-0000000a0001";

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: RUN,
    channelId: "00000000-0000-7000-8000-000000000201",
    agentMemberId: "00000000-0000-7000-8000-000000000301",
    triggerMessageId: MSG,
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

const ENDED = {
  status: "failed",
  claimedAtMs: T + 5 * SEC,
  startedAtMs: T + 6 * SEC,
  finishedAtMs: T + 3 * MIN + 12 * SEC,
} as const;

describe("못 가져감 유예 (#4619: 예상 확인 시각이 있으면 그것, 없으면 2분)", () => {
  it("기본 유예는 2분이고, 홈 카드의 5분(서버 woken_grace)과 다른 값이다", () => {
    expect(UNCOLLECTED_GRACE_MS).toBe(2 * MIN);
    expect(UNCOLLECTED_GRACE_MS).not.toBe(UNCOLLECTED_AFTER_MS);
  });

  it("경계 ±1ms: 마감 1ms 전은 예외가 아니고, 마감과 그 뒤는 예외다", () => {
    const run = progress();
    expect(runException(run, T + UNCOLLECTED_GRACE_MS - 1)).toBeNull();
    expect(runException(run, T + UNCOLLECTED_GRACE_MS)?.kind).toBe("uncollected");
    expect(runException(run, T + UNCOLLECTED_GRACE_MS + 1)?.kind).toBe("uncollected");
    // 방금 들어온 요청은 당연히 아니다.
    expect(runException(run, T)).toBeNull();
  });

  it("유예는 파라미터다: 생략하면 2분, 주면 그 값", () => {
    const run = progress();
    expect(runException(run, T + 60 * SEC, { graceMs: 30 * SEC })?.kind).toBe("uncollected");
    expect(runException(run, T + 60 * SEC)).toBeNull();
  });

  it("예상 확인 시각이 유예보다 뒤면 그 시각까지 기다린다(경계 ±1ms)", () => {
    const expectedCheckAtMs = T + 14 * MIN;
    const routine = { typicalMinutes: 15, expectedCheckAtMs };
    const run = progress();
    // 2분이 훨씬 지나도 예상 시각 전에는 예외가 아니다.
    expect(runException(run, T + 5 * MIN, { routine })).toBeNull();
    expect(runException(run, expectedCheckAtMs - 1, { routine })).toBeNull();
    expect(runException(run, expectedCheckAtMs, { routine })?.kind).toBe("uncollected");
    expect(runException(run, expectedCheckAtMs + 1, { routine })?.kind).toBe("uncollected");
  });

  it("예상 시각이 유예보다 빨라도 유예 전에는 올리지 않는다(지터 때문에 매번 깜박이지 않게)", () => {
    const routine = { typicalMinutes: 15, expectedCheckAtMs: T + 30 * SEC };
    const run = progress();
    expect(runException(run, T + 31 * SEC, { routine })).toBeNull();
    expect(runException(run, T + UNCOLLECTED_GRACE_MS - 1, { routine })).toBeNull();
    expect(runException(run, T + UNCOLLECTED_GRACE_MS, { routine })?.kind).toBe("uncollected");
  });

  it("run이 들어오기 전의 낡은 예상 시각은 쓰지 않는다 — 유예로 돌아간다", () => {
    const stale = { typicalMinutes: 15, expectedCheckAtMs: T - 3 * MIN };
    expect(uncollectedDeadlineMs(T, stale)).toBe(T + UNCOLLECTED_GRACE_MS);
    // 들어온 시각과 같은 값도 그 run이 기다린 박자가 아니다.
    expect(uncollectedDeadlineMs(T, { expectedCheckAtMs: T })).toBe(T + UNCOLLECTED_GRACE_MS);
    expect(runException(progress(), T + UNCOLLECTED_GRACE_MS - 1, { routine: stale })).toBeNull();
    expect(runException(progress(), T + UNCOLLECTED_GRACE_MS, { routine: stale })?.kind).toBe(
      "uncollected"
    );
  });

  it("사람이 부르지 않은 시스템 작업(환영)은 몇 시간이 지나도 예외가 아니다", () => {
    const welcome = progress({ triggerMessageId: undefined, system: true });
    expect(isUncollectedPastGrace(serverFactsOf(welcome), T + 17 * HOUR)).toBe(false);
    expect(runException(welcome, T + 17 * HOUR)).toBeNull();
  });
});

describe("예외 줄의 말: 낱말·이유·행동", () => {
  const LATE = T + 10 * MIN;

  it("못 가져감: 낱말은 「못 가져감」, 행동 후보는 다시 깨우기·취소·설정, 열린 run이다", () => {
    const e = runException(progress(), LATE);
    expect(e).toMatchObject({
      kind: "uncollected",
      runId: RUN,
      triggerMessageId: MSG,
      headline: UNCOLLECTED_HEADLINE,
      open: true,
      actions: ["wake", "cancel", "settings"],
    });
    expect(UNCOLLECTED_HEADLINE).toBe("못 가져감");
    expect(runExceptionText("달무리봇", e!)).toBe("달무리봇: 못 가져감");
  });

  it("홈 카드·작업 패널의 「아직 받지 않았어요」(5분, #4285)는 다른 표면의 말이라 이 줄의 낱말이 아니다", () => {
    expect(UNCOLLECTED_HEADLINE).not.toBe(UNCOLLECTED_WORD);
    expect(runException(progress(), LATE)?.headline).not.toBe(UNCOLLECTED_WORD);
  });

  it("서버가 아무도 가져가지 않아 끝낸 run(timed_out + unclaimed_expired·woken_not_collected)도 같은 「못 가져감」이다", () => {
    expect([...UNCLAIMED_END_REASONS].sort()).toEqual(["unclaimed_expired", "woken_not_collected"]);
    const cases: [string, string][] = [
      ["unclaimed_expired", "아무도 가져가지 않아 끝냈어요"],
      ["woken_not_collected", "깨웠지만 가져가지 않아 끝냈어요"],
    ];
    for (const [endReason, reason] of cases) {
      const e = runException(
        progress({ phase: "timed_out", status: "timed_out", endReason, finishedAtMs: T + 30 * MIN }),
        T + HOUR
      );
      expect(e, endReason).toMatchObject({
        kind: "uncollected",
        headline: UNCOLLECTED_HEADLINE,
        reason,
        open: false,
        // 끝난 run에는 되돌릴 행동이 없다.
        actions: [],
      });
      expect(runExceptionText("달무리봇", e!)).toBe(`달무리봇: 못 가져감 · ${reason}`);
    }
  });

  it("그 두 코드가 아닌 timed_out(가져간 뒤의 소식 끊김 등)은 여전히 시간 초과·신호 소실이다", () => {
    const lost = runException(
      progress({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" }),
      T + HOUR
    );
    expect(lost).toMatchObject({ kind: "timed_out", headline: "신호 소실" });
    const plain = runException(progress({ phase: "timed_out", status: "timed_out" }), T + HOUR);
    expect(plain).toMatchObject({ kind: "timed_out", headline: "시간 초과" });
    // failed인데 같은 코드가 와도 실패다(코드가 phase를 덮어쓰지 않는다).
    const failed = runException(
      progress({ phase: "failed", status: "failed", endReason: "unclaimed_expired" }),
      T + HOUR
    );
    expect(failed?.kind).toBe("failed");
  });

  it("이유의 순서: 루틴 박자가 있으면 그 말이 앞서고, 생존 판정의 「연결이 꺼져 있을 수 있어요」를 대신한다", () => {
    const routine = { typicalMinutes: 15, expectedCheckAtMs: T + 3 * MIN };
    const e = runException(progress(), LATE, {
      routine,
      liveness: { state: "woken_not_collected" },
    });
    expect(e?.reason).toBe("다음 확인 때 가져가요(보통 15분 안)");
    expect(runExceptionText("달무리봇", e!)).toBe(
      "달무리봇: 못 가져감 · 다음 확인 때 가져가요(보통 15분 안)"
    );
    expect(e?.reason).not.toContain("연결이 꺼져 있을 수 있어요");
  });

  it("박자를 모르면 서버 판정에 근거가 있을 때만 「연결이 꺼져 있을 수 있어요」, 없으면 이유가 없다", () => {
    for (const state of ["woken_not_collected", "unresponsive", "quiet"] as const) {
      expect(runException(progress(), LATE, { liveness: { state } })?.reason).toBe(
        "연결이 꺼져 있을 수 있어요"
      );
    }
    // 살아 있는데 일을 안 가져가는 에이전트, 호출이 거절된 에이전트, 판정 없음: 이유를 지어내지 않는다.
    for (const liveness of [
      { state: "work_waiting" as const },
      { state: "error" as const },
      { state: "responsive" as const },
      null,
      undefined,
    ]) {
      expect(runException(progress(), LATE, { liveness })?.reason).toBeUndefined();
    }
  });

  it("실패·시간 초과: runPhase 낱말에 서버의 닫힌 종료 코드 문장이 이유로 붙는다", () => {
    const failed = runException(
      progress({ phase: "failed", endReason: "agent_error", ...ENDED }),
      T + HOUR
    );
    expect(failed).toMatchObject({
      kind: "failed",
      headline: "실패",
      reason: "에이전트가 오류로 끝냈어요",
      open: false,
      // 끝난 run에는 되돌릴 행동이 없다. 「진행 과정 열기」는 줄 자체가 맡는다.
      actions: [],
    });
    expect(runExceptionText("달무리봇", failed!)).toBe(
      "달무리봇: 실패 · 에이전트가 오류로 끝냈어요"
    );

    const timedOut = runException(
      progress({ phase: "timed_out", status: "timed_out", endReason: "agent_error" }),
      T + HOUR
    );
    expect(timedOut).toMatchObject({
      kind: "timed_out",
      headline: "시간 초과",
      reason: "에이전트가 오류로 끝냈어요",
      open: false,
    });

    // 서버가 「소식 끊김」으로 끝냈을 때만 「신호 소실」이다(runPhase의 규칙 그대로).
    const lost = runException(
      progress({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" }),
      T + HOUR
    );
    expect(lost?.headline).toBe("신호 소실");
  });

  it("모르는 종료 코드는 이유를 만들지 않는다", () => {
    const e = runException(
      progress({ phase: "failed", endReason: "brand_new_code_from_a_newer_server", ...ENDED }),
      T + HOUR
    );
    expect(e?.kind).toBe("failed");
    expect(e?.reason).toBeUndefined();
  });

  it("예외가 아닌 것: 승인 대기·일시 정지·가져감(소식 끊김 포함)·작업 중·완료·취소", () => {
    const quiet: Partial<AgentRunProgress>[] = [
      { phase: "awaiting_approval", status: "awaiting_approval" },
      { phase: "paused", status: "paused" },
      { phase: "claimed", leaseState: "stale", claimedAtMs: T },
      { phase: "claimed", leaseState: "live", claimedAtMs: T },
      { phase: "running", status: "running", leaseState: "live", startedAtMs: T },
      { phase: "succeeded", status: "succeeded", finishedAtMs: T + MIN },
      { phase: "cancelled", status: "cancelled", endReason: "cancelled_by_member" },
    ];
    for (const extra of quiet) {
      expect(runException(progress(extra), T + 17 * HOUR), JSON.stringify(extra)).toBeNull();
    }
  });
});

describe("초 단위 숫자가 없다", () => {
  it("어떤 경과에서도 예외 줄의 글자에 「n초」가 없다", () => {
    const rows: Partial<AgentRunProgress>[] = [
      {},
      { phase: "failed", endReason: "agent_error", ...ENDED },
      { phase: "timed_out", status: "timed_out", endReason: "woken_not_collected" },
    ];
    const offsets = [0, 5 * SEC, 59 * SEC, 61 * SEC, 125 * SEC, 3601 * SEC, 17 * HOUR];
    let seen = 0;
    for (const extra of rows) {
      for (const dt of offsets) {
        const e = runException(progress(extra), T + dt, {
          routine: { typicalMinutes: 15 },
          liveness: { state: "unresponsive" },
        });
        if (e === null) continue;
        seen += 1;
        const text = runExceptionText("달무리봇", e);
        expect(text, `${JSON.stringify(extra)} +${dt}ms`).not.toMatch(/\d+\s*초/);
        expect(text).not.toMatch(/\d+\s*s\b/);
      }
    }
    // 위 단정이 빈 반복이 아님을 못 박는다: 예외가 실제로 여러 번 만들어졌다.
    expect(seen).toBeGreaterThanOrEqual(10);
  });
});

describe("다시 그릴 시각", () => {
  it("유예 안의 대기 run 중 가장 이른 마감을 돌려주고, 지난 것·가져간 것·시스템 작업은 세지 않는다", () => {
    const first = progress({ id: "r1", createdAtMs: T });
    const later = progress({ id: "r2", createdAtMs: T + 30 * SEC });
    expect(nextUncollectedDeadlineMs([later, first], T + 10 * SEC)).toBe(
      T + UNCOLLECTED_GRACE_MS
    );
    // 첫 번째의 마감이 지났으면 다음 것의 마감이다.
    expect(nextUncollectedDeadlineMs([first, later], T + UNCOLLECTED_GRACE_MS)).toBe(
      T + 30 * SEC + UNCOLLECTED_GRACE_MS
    );
    // 마감 시각 그 자체는 이미 예외다: 다시 그릴 시각이 아니다.
    expect(nextUncollectedDeadlineMs([first], T + UNCOLLECTED_GRACE_MS)).toBeNull();
    expect(
      nextUncollectedDeadlineMs(
        [
          progress({ phase: "claimed", leaseState: "live", claimedAtMs: T }),
          progress({ triggerMessageId: undefined, system: true }),
          progress({ phase: "running", status: "running", startedAtMs: T }),
        ],
        T + SEC
      )
    ).toBeNull();
    expect(nextUncollectedDeadlineMs([], T)).toBeNull();
  });

  it("루틴 박자가 마감을 늦추면 그 시각이다", () => {
    const routineFor = () => ({ expectedCheckAtMs: T + 14 * MIN });
    expect(nextUncollectedDeadlineMs([progress()], T + 3 * MIN, routineFor)).toBe(T + 14 * MIN);
  });
});

describe("루틴 문구", () => {
  it("「보통 N분 안」은 상한이라 올림이고, 1분 아래는 1분이며, 60분부터는 시간이다", () => {
    expect(routineWaitText({ typicalMinutes: 15 })).toBe("다음 확인 때 가져가요(보통 15분 안)");
    expect(routineWaitText({ typicalMinutes: 14.2 })).toBe("다음 확인 때 가져가요(보통 15분 안)");
    expect(routineWaitText({ typicalMinutes: 0.2 })).toBe("다음 확인 때 가져가요(보통 1분 안)");
    expect(routineWaitText({ typicalMinutes: 60 })).toBe("다음 확인 때 가져가요(보통 1시간 안)");
    expect(routineWaitText({ typicalMinutes: 90 })).toBe("다음 확인 때 가져가요(보통 2시간 안)");
  });
});
