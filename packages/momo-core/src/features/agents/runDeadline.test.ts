import { describe, expect, it } from "vitest";
import { agentRunLedgerFromWire, type AgentRunProgress } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import { nextMinuteMarkMs, nextRunDeadlineMs } from "./runDeadline";
import { runDurationBreakdown } from "./runDuration";
import { runPhaseDetail, serverFactsOf } from "./runPhase";
import { runStateWord } from "./runWaiting";
import { WORK_DWELL_AFTER_MS, WORK_QUIET_AFTER_MS, workHealth, workHealthLine } from "./workHealth";

// =============================================================================
// 시트의 마감 표(#4658): 「시간만으로 사실이 바뀌는 순간」이 글을 만드는 쪽과 맞는지 잰다. 마감 값만 단정하면 표와 글이 따로 낡아 가도
// 초록이다 — 그래서 이 파일의 핵심은 **글을 직접 만들어** 마감 전에는 같고 마감에 바뀐다는 것을 보이는 맞대기다.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const fmt = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });

function progress(extra: Partial<AgentRunProgress>): AgentRunProgress {
  return {
    id: RUN,
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
const ledger = (rows: unknown[]) => agentRunLedgerFromWire({ runId: RUN, events: rows }).events;

describe("nextMinuteMarkMs: 닻에서 센 분 숫자가 다음에 오르는 순간", () => {
  it("닻이 미래이면 그 닻이고, 지났으면 다음 분 경계다 — 정확히 경계에 불리면 다음 칸이다(경계는 포함)", () => {
    expect(nextMinuteMarkMs(T + 5 * SEC, T)).toBe(T + 5 * SEC);
    expect(nextMinuteMarkMs(T, T + 30 * SEC)).toBe(T + MIN);
    expect(nextMinuteMarkMs(T, T + MIN - 1)).toBe(T + MIN);
    expect(nextMinuteMarkMs(T, T + MIN)).toBe(T + 2 * MIN);
    expect(nextMinuteMarkMs(T, T)).toBe(T + MIN);
  });
});

describe("nextRunDeadlineMs: phase마다 어떤 글이 시간을 읽는가", () => {
  const running = {
    phase: "running" as const,
    status: "running" as const,
    leaseState: "live" as const,
    claimedAtMs: T + 12 * SEC,
    startedAtMs: T + 20 * SEC,
  };

  it("끝난 run은 마감이 없다 — 걸린 시간·단계 시각은 더 바뀌지 않는다", () => {
    for (const phase of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      const done = facts({ phase, status: phase, finishedAtMs: T + 3 * MIN });
      expect(nextRunDeadlineMs({ facts: done, events: [], nowMs: T + 99 * MIN, live: true })).toBeNull();
    }
  });

  it("사람이 부른 대기는 유예 마감(5분)과 분 경계 중 이른 쪽, 부른 사람 없는 시스템 작업은 유예가 없다", () => {
    const human = facts({});
    expect(nextRunDeadlineMs({ facts: human, events: [], nowMs: T + 30 * SEC, live: true })).toBe(T + MIN);
    // 4분 59초: 유예 마감(5분)이 분 경계(5분)와 같은 순간이다.
    expect(nextRunDeadlineMs({ facts: human, events: [], nowMs: T + 5 * MIN - SEC, live: true })).toBe(T + 5 * MIN);
    // 유예가 막 지난 순간(경계는 포함): 지난 마감은 다시 돌려주지 않고 다음 분 경계를 돌려준다.
    expect(nextRunDeadlineMs({ facts: human, events: [], nowMs: T + 5 * MIN, live: true })).toBe(T + 6 * MIN);
    const system = facts({ system: true });
    expect(nextRunDeadlineMs({ facts: system, events: [], nowMs: T + 30 * SEC, live: true })).toBe(T + MIN);
  });

  it("조용함·머문 시간의 문턱은 연결이 살아 있을 때만 마감이 되고, 끊기면 서지 않는다", () => {
    // 시작·마지막 보고 시각을 모르는 run: 건강 신호의 닻은 원장의 단계뿐이다(분 경계 마감이 끼지 않는다).
    const bare = facts({ phase: "running", status: "running", leaseState: "live" });
    const stage = ledger([{ ordinal: 1, kind: "stage", stage: "읽는 중", createdAtMs: T }]);
    // 단계 9분 뒤: 조용함(5분)은 지났고 머문 시간(10분)이 1분 뒤에 선다.
    const at = T + 9 * MIN;
    expect(nextRunDeadlineMs({ facts: bare, events: stage, nowMs: at, live: true })).toBe(T + WORK_DWELL_AFTER_MS);
    expect(nextRunDeadlineMs({ facts: bare, events: stage, nowMs: at, live: false })).toBeNull();
    // 단계 직후: 가장 이른 문턱은 조용함(5분)이다.
    expect(nextRunDeadlineMs({ facts: bare, events: stage, nowMs: T + SEC, live: true })).toBe(T + WORK_QUIET_AFTER_MS);
    // 머문 시간 문턱을 넘은 뒤에는 「같은 단계에 n분째」가 분마다 오른다.
    expect(nextRunDeadlineMs({ facts: bare, events: stage, nowMs: T + 10 * MIN + 5 * SEC, live: true })).toBe(
      T + 11 * MIN
    );
  });

  it("승인 대기는 걸린 시간 줄(작업 n분째)의 분 경계만 읽는다", () => {
    const waiting = facts({ ...running, phase: "awaiting_approval", status: "awaiting_approval" });
    expect(nextRunDeadlineMs({ facts: waiting, events: [], nowMs: T + 90 * SEC, live: true })).toBe(T + 20 * SEC + 2 * MIN);
  });

  it("마감은 언제나 지금보다 뒤다(지난 마감을 돌려주면 다시 그리기가 끝나지 않는다)", () => {
    const f = facts({ ...running, lastEventAtMs: T + 3 * MIN });
    const events = ledger([{ ordinal: 1, kind: "stage", stage: "읽는 중", createdAtMs: T + 2 * MIN }]);
    for (let offset = 0; offset < 40 * MIN; offset += 7 * SEC + 13) {
      const at = nextRunDeadlineMs({ facts: f, events, nowMs: T + offset, live: true });
      expect(at === null || at > T + offset).toBe(true);
    }
  });
});

describe("마감은 글이 실제로 바뀌는 순간이다 — 마감 전에는 같고, 마감에 바뀐다", () => {
  /** 시트가 시간을 읽는 글 전부: 머리 근거 글 · 걸린 시간 줄 · 상태 낱말 · 건강 줄. */
  function sheetText(
    f: ReturnType<typeof facts>,
    events: ReturnType<typeof ledger>,
    nowMs: number,
    live: boolean
  ): string {
    return [
      runStateWord(f, nowMs),
      runPhaseDetail(f, nowMs, { minutesOnly: true }) ?? "",
      runDurationBreakdown(f, nowMs, true),
      workHealthLine(workHealth({ facts: f, events, nowMs, live }), fmt, { lastReportShownElsewhere: true }) ?? "",
    ].join(" | ");
  }

  const scenarios: [string, ReturnType<typeof facts>, ReturnType<typeof ledger>, number][] = [
    ["대기: 유예 마감에 낱말이 바뀐다", facts({}), [], 4 * MIN + 30 * SEC],
    ["대기: 분 숫자가 오른다", facts({}), [], 1 * MIN + 10 * SEC],
    [
      "가져감: 가져간 뒤 분 숫자",
      facts({ phase: "claimed", status: "running", leaseState: "live", claimedAtMs: T + 5 * SEC }),
      [],
      2 * MIN,
    ],
    [
      "가져감: 소식이 끊긴 뒤 분 숫자",
      facts({ phase: "claimed", status: "running", leaseState: "stale", claimedAtMs: T, lastEventAtMs: T + 30 * SEC }),
      [],
      3 * MIN,
    ],
    [
      "작업 중: 「n분째 · 마지막 보고 m분 전」",
      facts({
        phase: "running",
        status: "running",
        leaseState: "live",
        claimedAtMs: T + 12 * SEC,
        startedAtMs: T + 20 * SEC,
        lastEventAtMs: T + 40 * SEC,
      }),
      [],
      2 * MIN,
    ],
    [
      "작업 중: 조용함 문턱",
      facts({
        phase: "running",
        status: "running",
        leaseState: "live",
        claimedAtMs: T + SEC,
        startedAtMs: T + 2 * SEC,
        lastEventAtMs: T + 3 * SEC,
      }),
      [],
      4 * MIN + 30 * SEC,
    ],
  ];

  it.each(scenarios)("%s", (_name, f, events, offset) => {
    const now = T + offset;
    const deadline = nextRunDeadlineMs({ facts: f, events, nowMs: now, live: true });
    expect(deadline).not.toBeNull();
    const at = deadline as number;
    // 지금부터 마감 직전까지는 글이 같다(그동안 다시 그릴 이유가 없다) …
    expect(sheetText(f, events, at - 1, true)).toBe(sheetText(f, events, now, true));
    // … 마감에는 달라진다(다시 그리지 않으면 낡은 글이 남는다).
    expect(sheetText(f, events, at, true)).not.toBe(sheetText(f, events, at - 1, true));
  });

  it("머문 시간 문턱: 단계 10분 뒤에 건강 줄에 「같은 단계에 n분째」가 선다", () => {
    // 시작 시각을 모르는 run: 머리 근거 글의 분 경계가 끼지 않아 가장 이른 마감이 문턱 자신이다.
    const f = facts({ phase: "running", status: "running", leaseState: "live" });
    const events = ledger([{ ordinal: 1, kind: "stage", stage: "읽는 중", createdAtMs: T }]);
    const now = T + 9 * MIN;
    const deadline = nextRunDeadlineMs({ facts: f, events, nowMs: now, live: true }) as number;
    expect(deadline).toBe(T + WORK_DWELL_AFTER_MS);
    expect(sheetText(f, events, deadline - 1, true)).not.toContain("같은 단계에");
    expect(sheetText(f, events, deadline, true)).toContain("같은 단계에 10분째");
  });
});
