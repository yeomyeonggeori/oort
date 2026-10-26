import { describe, expect, it } from "vitest";
import type { AgentRunPhase, AgentRunProgress } from "../../lib/api";
import {
  runException,
  UNCLAIMED_END_REASONS,
  UNCOLLECTED_GRACE_MS,
  UNCOLLECTED_HEADLINE,
} from "./runException";
import { CHIP_WORD_UNCOLLECTED, triggerChip } from "./triggerChip";

// =============================================================================
// 같은 행에 서는 두 표면의 낱말 (#4619). 메시지 머리의 칩(`triggerChip`)과 그 아래의 예외 줄(`runException`)은
// 한 행에 함께 서므로, 같은 run을 서로 다른 낱말로 부르면 읽는 사람은 두 사건으로 읽는다. 두 모듈의 단위 시험은
// 서로를 보지 않아서 한쪽 낱말만 바뀌어도 둘 다 초록이다(이 시험이 생기기 전에 실제로 그랬다: 칩 「못 가져감」 대
// 줄 「시간 초과」). 여기서는 같은 run 하나를 두 모듈에 넣어 낱말과 존재 여부를 함께 붙든다.
//
// 규칙 셋:
//   1. 예외 줄이 「못 가져감」이면 칩도 같은 낱말이다(열려 있든 서버가 그래서 끝냈든).
//   2. 칩이 「못 가져감」이면 예외 줄이 있다(줄 없이 칩만 「못 가져감」이면 행동이 갈 곳이 없다).
//   3. 예외 줄이 「실패」이면 칩도 같은 낱말이다.
// 가져간 뒤의 시간 초과·신호 소실은 칩이 큰 범주(「실패」)로, 줄이 구체 낱말로 말한다 — 일부러 다르고 아래에서 못 박는다.
// =============================================================================

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const AGENT = "00000000-0000-7000-8000-000000000301";
const nameFor = () => ({ name: "달무리봇" });

function run(extra: Partial<AgentRunProgress>): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: "00000000-0000-7000-8000-000000000201",
    agentMemberId: AGENT,
    triggerMessageId: "00000000-0000-7000-8000-0000000a0001",
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

const PHASES: AgentRunPhase[] = [
  "queued",
  "claimed",
  "running",
  "awaiting_approval",
  "paused",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];
const END_REASONS: (string | undefined)[] = [
  undefined,
  "approval_expired",
  "unclaimed_expired",
  "woken_not_collected",
  "lease_abandoned",
  "agent_error",
  "cancelled_by_member",
  "human_cancelled",
  "a_code_from_a_newer_server",
];
const OFFSETS = [0, 10 * SEC, UNCOLLECTED_GRACE_MS - 1, UNCOLLECTED_GRACE_MS, 5 * MIN, HOUR, 17 * HOUR];
const ROUTINES = [undefined, { typicalMinutes: 15, expectedCheckAtMs: T + 14 * MIN }] as const;

describe("칩과 예외 줄이 같은 run을 같은 낱말로 부른다", () => {
  const rows: {
    where: string;
    exception: ReturnType<typeof runException>;
    chip: ReturnType<typeof triggerChip>;
  }[] = [];
  for (const phase of PHASES) {
    for (const endReason of END_REASONS) {
      for (const dt of OFFSETS) {
        for (const routine of ROUTINES) {
          const r = run({
            phase,
            status: phase,
            ...(endReason !== undefined ? { endReason } : {}),
            ...(phase === "claimed" ? { claimedAtMs: T } : {}),
          } as Partial<AgentRunProgress>);
          const now = T + dt;
          rows.push({
            where: `${phase}/${endReason ?? "-"}/+${dt}ms/${routine === undefined ? "no-routine" : "routine"}`,
            exception: runException(r, now, routine === undefined ? {} : { routine }),
            chip: triggerChip([r], nameFor, now, {
              ...(routine === undefined ? {} : { routineFor: () => routine }),
            }),
          });
        }
      }
    }
  }

  it("전수 반복이 비어 있지 않다(예외 줄이 선 경우·못 가져감 칩이 선 경우가 모두 많다)", () => {
    expect(rows.length).toBe(PHASES.length * END_REASONS.length * OFFSETS.length * ROUTINES.length);
    expect(rows.filter((r) => r.exception?.kind === "uncollected").length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.exception?.kind === "failed").length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.chip?.kind === "uncollected").length).toBeGreaterThan(20);
  });

  it("1. 예외 줄이 「못 가져감」이면 칩도 같은 낱말이다", () => {
    for (const { where, exception, chip } of rows) {
      if (exception?.kind !== "uncollected") continue;
      expect(chip, where).not.toBeNull();
      expect(chip!.kind, where).toBe("uncollected");
      expect(chip!.word, where).toBe(exception.headline);
      expect(chip!.word, where).toBe(UNCOLLECTED_HEADLINE);
    }
  });

  it("2. 칩이 「못 가져감」이면 예외 줄이 있다 — 줄 없이 칩만 서지 않는다", () => {
    for (const { where, exception, chip } of rows) {
      if (chip?.kind !== "uncollected") continue;
      expect(exception, where).not.toBeNull();
      expect(exception!.kind, where).toBe("uncollected");
      expect(chip.word, where).toBe(CHIP_WORD_UNCOLLECTED);
    }
  });

  it("3. 예외 줄이 「실패」이면 칩도 같은 낱말이다", () => {
    for (const { where, exception, chip } of rows) {
      if (exception?.kind !== "failed") continue;
      expect(chip, where).not.toBeNull();
      expect(chip!.kind, where).toBe("failed");
      expect(chip!.word, where).toBe(exception.headline);
    }
  });

  it("서버가 아무도 가져가지 않아 끝낸 두 코드는 열린 못 가져감과 칩·줄 모두 같은 낱말이다", () => {
    for (const endReason of UNCLAIMED_END_REASONS) {
      const r = run({ phase: "timed_out", status: "timed_out", endReason });
      const exception = runException(r, T + HOUR);
      const chip = triggerChip([r], nameFor, T + HOUR);
      expect(exception?.headline, endReason).toBe(UNCOLLECTED_HEADLINE);
      expect(chip?.word, endReason).toBe(UNCOLLECTED_HEADLINE);
    }
  });

  it("가져간 뒤의 시간 초과·신호 소실: 칩은 큰 범주 「실패」, 줄이 구체 낱말이다(일부러 다르다)", () => {
    const lost = run({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" });
    expect(triggerChip([lost], nameFor, T + HOUR)?.word).toBe("실패");
    expect(runException(lost, T + HOUR)?.headline).toBe("신호 소실");
    const plain = run({ phase: "timed_out", status: "timed_out" });
    expect(triggerChip([plain], nameFor, T + HOUR)?.word).toBe("실패");
    expect(runException(plain, T + HOUR)?.headline).toBe("시간 초과");
  });

  it("줄도 칩도 없는 상태: 취소는 둘 다 없다. 줄 없이 칩만 있는 상태는 진행 중·답함·승인 대기뿐이다", () => {
    for (const { where, exception, chip } of rows) {
      if (exception !== null) continue;
      if (chip === null) continue;
      expect(
        ["received", "claimed", "working", "approval", "answered"],
        where
      ).toContain(chip.kind);
    }
    const cancelled = run({ phase: "cancelled", status: "cancelled" });
    expect(runException(cancelled, T + HOUR)).toBeNull();
    expect(triggerChip([cancelled], nameFor, T + HOUR)).toBeNull();
  });
});
