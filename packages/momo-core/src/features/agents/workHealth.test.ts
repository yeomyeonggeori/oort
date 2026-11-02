import { describe, expect, it } from "vitest";
import { agentRunLedgerFromWire } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import {
  WORK_DWELL_AFTER_MS,
  WORK_QUIET_AFTER_MS,
  workHealth,
  workHealthLine,
  type WorkHealthInput,
} from "./workHealth";

// =============================================================================
// 건강 신호(#4657): 서버가 적어 둔 사실로만 말한다. 계약은 `workHealth.ts` 머리 주석이다.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;
const MIN = 60_000;
const fmt = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });

function events(rows: unknown[]) {
  return agentRunLedgerFromWire({ runId: RUN, events: rows }).events;
}

function input(over: Partial<WorkHealthInput> & { rows?: unknown[] } = {}): WorkHealthInput {
  const { rows = [], ...rest } = over;
  return {
    facts: { phase: "running", lastEventAtMs: T },
    events: events(rows),
    nowMs: T,
    live: true,
    ...rest,
  };
}

describe("건강 신호: 시간", () => {
  it("조용함·머문 시간은 연결이 살아 있고 서버가 running이라 할 때만, 문턱을 넘어야 서며 분 단위로 말한다", () => {
    // 오래된 단계(30분 전)와 가장 새 단계(T): 머문 시간은 가장 새 단계부터 센다.
    const stage = [
      { ordinal: 1, kind: "stage", stage: "문서 읽기", createdAtMs: T - 30 * MIN },
      { ordinal: 2, kind: "stage", stage: "표 정리", createdAtMs: T },
    ];
    // 문턱 바로 앞: 아무 말도 없다(어느 박자에서도 평소다).
    expect(workHealth(input({ rows: stage, nowMs: T + WORK_QUIET_AFTER_MS - 1 }))).toMatchObject({ quietMinutes: null, dwellMinutes: null });
    // 5분: 조용함. 머문 시간은 10분부터.
    expect(workHealth(input({ rows: stage, nowMs: T + WORK_QUIET_AFTER_MS }))).toMatchObject({ quietMinutes: 5, dwellMinutes: null });
    const long = workHealth(input({ rows: stage, nowMs: T + WORK_DWELL_AFTER_MS + 59_000 }));
    expect(long).toMatchObject({ quietMinutes: 10, dwellMinutes: 10 });
    expect(workHealthLine(long, fmt)).toBe("조용해요 · 마지막 보고 10분 전 · 같은 단계에 10분째");
    expect(workHealthLine(long, fmt)).not.toMatch(/\d+초/);
    // 마지막 보고는 서버 진행 읽기와 원장의 가장 새 행 중 늦은 쪽이다. 원장이 더 새로우면 원장이 이기고(활동 행 +9분),
    // 깨움 줄(+12분)은 세지 않는다(서버도 `last_event_at`에서 뺀다): 지금이 +16분이면 마지막 보고는 7분 전이다.
    const rows = [
      { ordinal: 1, kind: "stage", stage: "표 정리", createdAtMs: T },
      { ordinal: 2, kind: "activity", createdAtMs: T + 9 * MIN, activity: { id: "a1", kind: "edit", status: "in_progress", n: 1, startedAtMs: T + 9 * MIN } },
      { ordinal: 3, kind: "doorbell_rung", code: "leading_ok", createdAtMs: T + 12 * MIN },
    ];
    expect(workHealth(input({ rows, nowMs: T + 16 * MIN })).quietMinutes).toBe(7);
    // 서버 진행 읽기가 더 새로우면(원장을 다시 읽기 전) 그쪽이 이긴다.
    expect(workHealth(input({ rows, nowMs: T + 16 * MIN, facts: { phase: "running", lastEventAtMs: T + 15 * MIN } })).quietMinutes).toBeNull();
    // 연결이 끊기면 시간 신호는 서지 않는다(끊긴 화면의 「n분 전」은 우리 시계 혼자 흘러간 숫자다).
    expect(workHealth(input({ rows: stage, nowMs: T + 30 * MIN, live: false }))).toMatchObject({ quietMinutes: null, dwellMinutes: null });
    // 서버가 running이라고 하지 않으면(승인 대기·끝남) 침묵은 에이전트의 잘못이 아니다.
    expect(workHealth(input({ rows: stage, nowMs: T + 30 * MIN, facts: { phase: "awaiting_approval", lastEventAtMs: T } }))).toMatchObject({ quietMinutes: null, dwellMinutes: null });
  });
});

describe("건강 신호: 개수", () => {
  it("실패한 활동·거절된 승인·재시도는 서버가 적어 둔 행에서 세고, 말할 것이 없으면 줄이 없다", () => {
    const rows = [
      { ordinal: 1, kind: "activity", createdAtMs: T + 1000, activity: { id: "a1", kind: "run", status: "failed", n: 3, startedAtMs: T + 1000 } },
      { ordinal: 2, kind: "activity", createdAtMs: T + 2000, activity: { id: "a2", kind: "run", status: "completed", n: 1, startedAtMs: T + 2000 } },
      { ordinal: 3, kind: "approval_decided", code: "rejected", approvalId: "0199aa11-2222-7000-8000-0000000000c1", createdAtMs: T + 3000 },
      { ordinal: 4, kind: "approval_decided", code: "approved", approvalId: "0199aa11-2222-7000-8000-0000000000c2", createdAtMs: T + 3500 },
      // renew: 실패 → 실패 → 성공 → 실패: 직전 호출이 실패였던 renew가 둘(재시도 2). 마지막 실패는 아직 재시도가 아니다.
      // run_event는 실패가 없어 0이고, renew가 실패한 **직후**의 run_event(다른 도구)도 재시도가 아니다.
      { ordinal: 5, kind: "tool_call", tool: "oort_job_renew", code: "conflict", createdAtMs: T + 4000 },
      { ordinal: 6, kind: "tool_call", tool: "oort_run_event", code: "ok", createdAtMs: T + 4500 },
      { ordinal: 7, kind: "tool_call", tool: "oort_job_renew", code: "unavailable", createdAtMs: T + 5000 },
      { ordinal: 8, kind: "tool_call", tool: "oort_job_renew", code: "ok", createdAtMs: T + 6000 },
      { ordinal: 9, kind: "tool_call", tool: "oort_job_renew", code: "conflict", createdAtMs: T + 7000 },
      { ordinal: 10, kind: "tool_call", tool: "oort_run_event", code: "ok", createdAtMs: T + 8000 },
    ];
    const health = workHealth(input({ rows }));
    // 실패한 활동은 활동 하나가 한 번이다(n=3이어도 1).
    expect(health).toMatchObject({ failedActivities: 1, rejectedApprovals: 1, retries: 2 });
    expect(workHealthLine(health, fmt)).toBe("실패한 활동 1 · 거절된 승인 1 · oort 호출 재시도 2번");
    // 신호가 없으면 줄이 서지 않는다(「문제 없음」을 지어내지 않는다).
    const quiet = workHealth(input({ rows: [{ ordinal: 1, kind: "queued", createdAtMs: T }] }));
    expect(quiet).toEqual({ quietMinutes: null, dwellMinutes: null, failedActivities: 0, rejectedApprovals: 0, retries: 0 });
    expect(workHealthLine(quiet, fmt)).toBeNull();
    // 연결이 끊겨도 개수는 남는다(서버가 이미 적은 사실이다).
    expect(workHealth(input({ rows, live: false }))).toMatchObject({ failedActivities: 1, rejectedApprovals: 1, retries: 2 });
  });
});
