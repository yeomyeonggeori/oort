import { describe, expect, it } from "vitest";
import {
  agentRunProgressFromWire,
  type AgentLiveness,
  type AgentLivenessState,
  type AgentRunProgress,
} from "../../lib/api";
import {
  CANCEL_CONFIRM_SENTENCE,
  cancelConfirmSentence,
  cancelReceipt,
  cancelSucceeded,
  cancelUntakenConfirmSentence,
  cancelWordingFor,
  STOP_WORDING,
  UNTAKEN_WORDING,
} from "./runCancel";
import { runPhaseDetail, runPhaseLabel, serverFactsOf, signalFromProgress } from "./runPhase";
import { runStatusLine, runStatusText } from "./runStatusLine";
import {
  CONNECTION_MAYBE_OFF_SENTENCE,
  isSystemRun,
  isUncollected,
  isUntakenHumanRun,
  queuedWaitCopy,
  UNCOLLECTED_AFTER_MS,
  UNCOLLECTED_WORD,
  uncollectedReason,
  waitingLead,
} from "./runWaiting";
import {
  activityDetail,
  activityLines,
  activitySuffix,
  activityText,
} from "./turnCopy";
import type { AgentWorkingSignal, ServerRunFacts } from "./workingSignal";

// =============================================================================
// 아무도 가져가지 않은 채 오래 머무는 「사람이 부른 일」 (ADR-0200 증보 3 E6, #4285).
// 규칙의 판정은 코어 한 곳이고 웹·폰의 홈 카드와 대화 아래 활동 줄이 그것을 부른다. 여기서
// 재는 것은 그 판정이다: 낱말이 바뀌는 때(N분), 근거 줄의 순서(생존 문구가 앞), 이유 문장이
// 서는 상태와 서지 않는 상태(모든 D4 상태를 표로), 그리고 부르지 않는 run(가져감·시스템 작업).
// =============================================================================

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const AGENT = "00000000-0000-7000-8000-00000000a001";
const CH = "00000000-0000-7000-8000-000000000201";

function facts(over: Partial<ServerRunFacts> = {}): ServerRunFacts {
  return {
    phase: "queued",
    leaseState: "none",
    queuedAtMs: NOW - 10 * MIN,
    ...over,
  };
}

function liveness(state: AgentLivenessState, minutesAgo?: number): AgentLiveness {
  return {
    agentMemberId: AGENT,
    state,
    ...(minutesAgo === undefined ? {} : { lastSignalAtMs: NOW - minutesAgo * MIN }),
  };
}

/** D4 상태 전부. `Record`라서 서버가 상태를 더하면 이 표가 컴파일에서 먼저 막힌다. */
const EVERY_STATE: Record<AgentLivenessState, true> = {
  inactive: true,
  error: true,
  woken_not_collected: true,
  work_waiting: true,
  responsive: true,
  alive_idle: true,
  quiet: true,
  unresponsive: true,
};
const STATES = Object.keys(EVERY_STATE) as AgentLivenessState[];

describe("사람이 부른 run이 가져가는 이 없이 N분을 넘었는가", () => {
  it("5분 직전은 아니고 5분 정각부터다 (서버 D4 woken_grace와 같은 순간)", () => {
    expect(UNCOLLECTED_AFTER_MS).toBe(5 * MIN);
    expect(isUncollected(facts({ queuedAtMs: NOW - 5 * MIN + 1 }), NOW)).toBe(false);
    expect(isUncollected(facts({ queuedAtMs: NOW - 5 * MIN }), NOW)).toBe(true);
    expect(isUncollected(facts({ queuedAtMs: NOW - 5 * MIN - 1 }), NOW)).toBe(true);
  });

  it("가져간(claimed) run은 아니다 — 에이전트가 일을 잡았으므로 「받지 않았어요」는 거짓이다", () => {
    for (const phase of ["claimed", "running", "awaiting_approval", "paused"] as const) {
      expect(isUncollected(facts({ phase, queuedAtMs: NOW - 3 * 60 * MIN }), NOW)).toBe(false);
    }
  });

  it("끝난 run은 아니다", () => {
    for (const phase of ["succeeded", "failed", "timed_out", "cancelled"] as const) {
      expect(isUncollected(facts({ phase, queuedAtMs: NOW - 3 * 60 * MIN }), NOW)).toBe(false);
    }
  });

  it("부른 사람이 없는 시스템 작업(환영)은 아니다 — 기다리는 사람이 없다", () => {
    const welcome = facts({ system: true, queuedAtMs: NOW - 5 * 60 * MIN });
    expect(isSystemRun(welcome)).toBe(true);
    expect(isUntakenHumanRun(welcome)).toBe(false);
    expect(isUncollected(welcome, NOW)).toBe(false);
    expect(isUntakenHumanRun(facts())).toBe(true);
  });

  it("서버가 모르는 run(관리형·옛 서버)은 판정하지 않는다", () => {
    expect(isUncollected(undefined, NOW)).toBe(false);
    expect(isUncollected(null, NOW)).toBe(false);
    expect(queuedWaitCopy({ facts: undefined, nowMs: NOW })).toBeNull();
  });
});

describe("근거 줄 맨 앞의 생존 문구 (E6: 「그 liveness 문구를 먼저」)", () => {
  // 서버의 경고 라벨(`livenessView`의 warn)과 연결이 꺼진 상태만 문구가 선다.
  const LEAD: Record<AgentLivenessState, { text: string; short: string } | null> = {
    woken_not_collected: { text: "깨웠지만 아직 안 가져감", short: "안 가져감" },
    work_waiting: { text: "일이 기다리는 중", short: "일이 밀림" },
    unresponsive: { text: "응답 없음 3시간", short: "응답 없음" },
    error: { text: "호출이 거절됨", short: "거절됨" },
    inactive: { text: "연결이 꺼져 있어요", short: "꺼짐" },
    responsive: null,
    alive_idle: null,
    quiet: null,
  };

  it.each(STATES)("%s", (state) => {
    const l = liveness(state, 3 * 60);
    const expected = LEAD[state];
    expect(waitingLead(l, NOW)).toBe(expected?.text);
    expect(waitingLead(l, NOW, "short")).toBe(expected?.short);
  });

  it("모르는 상태(읽는 중)와 호스티드가 아니라는 답에는 문구를 지어내지 않는다", () => {
    expect(waitingLead(undefined, NOW)).toBeUndefined();
    expect(waitingLead(null, NOW)).toBeUndefined();
  });
});

describe("이유 한 문장 「연결이 꺼져 있을 수 있어요」", () => {
  // 서버 판정에 연결을 의심할 근거가 있을 때만. 근거가 없는 상태에 붙이면 거짓이다.
  const DOUBT: Record<AgentLivenessState, boolean> = {
    woken_not_collected: true,
    unresponsive: true,
    quiet: true,
    inactive: false, // 근거 줄이 이미 사실로 말한다
    work_waiting: false, // 신호는 60분 안에 있다: 살아 있는데 일을 안 가져간다
    error: false, // 연결이 아니라 자격의 문제다
    alive_idle: false,
    responsive: false,
  };

  it.each(STATES)("%s", (state) => {
    expect(uncollectedReason(liveness(state))).toBe(
      DOUBT[state] ? CONNECTION_MAYBE_OFF_SENTENCE : undefined
    );
  });

  it("호스티드가 아니거나(null) 아직 모르면(undefined) 문장이 없다", () => {
    expect(uncollectedReason(null)).toBeUndefined();
    expect(uncollectedReason(undefined)).toBeUndefined();
  });
});

describe("queuedWaitCopy — 낱말·근거 줄·이유", () => {
  it("5분 전까지는 서버가 말한 「대기 n번째」 그대로, 넘으면 「아직 받지 않았어요」", () => {
    const young = queuedWaitCopy({
      facts: facts({ queuePosition: 2, aheadTotal: 1, queuedAtMs: NOW - 4 * MIN }),
      nowMs: NOW,
    });
    expect(young?.uncollected).toBe(false);
    expect(young?.word).toBe("대기 2번째");
    expect(young?.word).toBe(runPhaseLabel(facts({ queuePosition: 2 })));

    const old = queuedWaitCopy({
      facts: facts({ queuePosition: 2, aheadTotal: 1, queuedAtMs: NOW - 6 * MIN }),
      nowMs: NOW,
    });
    expect(old?.uncollected).toBe(true);
    expect(old?.word).toBe(UNCOLLECTED_WORD);
    expect(old?.word).toBe("아직 받지 않았어요");
  });

  it("생존 문구가 없으면 근거 줄은 전과 같다 (순번 대신 앞선 건수는 남는다)", () => {
    const f = facts({ queuePosition: 2, aheadTotal: 1, queuedAtMs: NOW - 11 * MIN });
    const copy = queuedWaitCopy({ facts: f, nowMs: NOW, liveness: liveness("responsive", 1) });
    expect(copy?.detail).toBe("11분째 기다려요 · 에이전트 앞에 1건");
    expect(copy?.detail).toBe(runPhaseDetail(f, NOW));
  });

  it("경고 라벨이 있으면 그 문구가 맨 앞이고 경과 시간이 뒤다", () => {
    const f = facts({ queuedAtMs: NOW - 5 * 60 * MIN, aheadTotal: 2 });
    const copy = queuedWaitCopy({ facts: f, nowMs: NOW, liveness: liveness("woken_not_collected") });
    expect(copy?.detail).toBe("깨웠지만 아직 안 가져감 · 5시간째 기다려요 · 에이전트 앞에 2건");
  });

  it("라벨이 서는 때는 N과 무관하다 — 응답 없는 에이전트에게 방금 보낸 요청에도 그 사실이 먼저 보인다", () => {
    const f = facts({ queuedAtMs: NOW - 30_000 });
    const copy = queuedWaitCopy({ facts: f, nowMs: NOW, liveness: liveness("unresponsive", 180) });
    expect(copy?.uncollected).toBe(false);
    expect(copy?.word).toBe(runPhaseLabel(f));
    expect(copy?.detail).toBe("응답 없음 3시간 · 30초째 기다려요");
    expect(copy?.reason).toBeUndefined();
  });

  it("이유 문장은 N을 넘었고 서버 판정에 근거가 있을 때만 선다", () => {
    const old = facts({ queuedAtMs: NOW - 8 * MIN });
    const young = facts({ queuedAtMs: NOW - 2 * MIN });
    expect(queuedWaitCopy({ facts: old, nowMs: NOW, liveness: liveness("woken_not_collected") })?.reason).toBe(
      "연결이 꺼져 있을 수 있어요"
    );
    expect(queuedWaitCopy({ facts: young, nowMs: NOW, liveness: liveness("woken_not_collected") })?.reason).toBeUndefined();
    expect(queuedWaitCopy({ facts: old, nowMs: NOW, liveness: liveness("alive_idle") })?.reason).toBeUndefined();
    expect(queuedWaitCopy({ facts: old, nowMs: NOW, liveness: null })?.reason).toBeUndefined();
    expect(queuedWaitCopy({ facts: old, nowMs: NOW })?.reason).toBeUndefined();
  });

  it("사이드바용 짧은 문구(digit 없는 낱말)로도 같은 순서다", () => {
    const f = facts({ queuedAtMs: NOW - 8 * MIN });
    const copy = queuedWaitCopy({
      facts: f,
      nowMs: NOW,
      liveness: liveness("woken_not_collected"),
      form: "short",
    });
    expect(copy?.detail).toBe("안 가져감 · 8분째 기다려요");
  });

  it("가져간 run과 시스템 작업에는 이 말을 하지 않는다 (null — 부르는 쪽이 기존 규칙을 쓴다)", () => {
    const old = NOW - 3 * 60 * MIN;
    expect(queuedWaitCopy({ facts: facts({ phase: "claimed", queuedAtMs: old }), nowMs: NOW })).toBeNull();
    expect(queuedWaitCopy({ facts: facts({ system: true, queuedAtMs: old }), nowMs: NOW })).toBeNull();
  });
});

describe("와이어 경계: 부른 사람이 없는 run(환영) 판별", () => {
  // 서버 진행 읽기에는 환영 표지가 없다(ADR-0200 증보 3 E6 「새 필드 없음」). 서버의 트리거는
  // 넷이고, 멘션·스레드 답글은 메시지 id, 작업은 필수 제목이 있어 둘 다 없는 run은 환영뿐이다.
  const wire = (extra: Record<string, unknown> = {}) => ({
    id: "0199aa11-2222-7000-8000-0000000000b1",
    channelId: CH,
    agentMemberId: AGENT,
    status: "queued",
    phase: "queued",
    leaseState: "none",
    stepCount: 0,
    createdAtMs: NOW - 10 * MIN,
    updatedAtMs: NOW - 10 * MIN,
    ...extra,
  });

  it("트리거 메시지도 작업 제목도 없으면 시스템 작업이다", () => {
    const run = agentRunProgressFromWire(wire());
    expect(run.system).toBe(true);
    expect(serverFactsOf(run).system).toBe(true);
    expect(signalFromProgress(run)?.server?.system).toBe(true);
  });

  it("멘션·스레드 답글(트리거 메시지 id)은 사람이 부른 run이다", () => {
    const run = agentRunProgressFromWire(
      wire({ triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1" })
    );
    expect(run.system).toBeUndefined();
    expect(serverFactsOf(run).system).toBeUndefined();
  });

  it("작업(트리거 메시지 없이 제목만)도 사람이 부른 run이다 — 「트리거 없음」이 판별자가 아니다", () => {
    const run = agentRunProgressFromWire(wire({ triggerSummary: "배포 점검표 만들기" }));
    expect(run.system).toBeUndefined();
  });

  it("빈 제목은 제목이 아니다", () => {
    expect(agentRunProgressFromWire(wire({ triggerSummary: "   " })).system).toBe(true);
    expect(agentRunProgressFromWire(wire({ triggerMessageId: "" })).system).toBe(true);
  });
});

describe("대화 아래 활동 줄", () => {
  const nameFor = () => ({ name: "달무리봇" });
  function turn(over: Partial<ServerRunFacts> = {}): AgentWorkingSignal {
    return {
      memberId: AGENT,
      channelId: CH,
      state: "queued",
      source: "run",
      runId: "r1",
      headlines: [],
      lastActivityAtMs: NOW - 10 * MIN,
      server: facts(over),
    };
  }
  const lineOf = (signal: AgentWorkingSignal, l?: AgentLiveness | null) =>
    activityLines([signal], nameFor, 3, l === undefined ? undefined : () => l).lines[0]!;

  it("5분을 넘은 사람 요청은 꼬리가 「아직 받지 않았어요」, 근거 줄은 생존 문구가 앞이다", () => {
    const line = lineOf(turn({ queuedAtMs: NOW - 17 * 60 * MIN }), liveness("woken_not_collected"));
    expect(activitySuffix(line, NOW)).toBe(": 아직 받지 않았어요");
    expect(activityText(line, NOW)).toBe("달무리봇: 아직 받지 않았어요");
    expect(activityDetail(line, NOW)).toBe(
      "깨웠지만 아직 안 가져감 · 17시간째 기다려요 · 연결이 꺼져 있을 수 있어요"
    );
  });

  it("시계를 주지 않은 호출(접근성 이름·옛 호출)은 기존 말 그대로다", () => {
    const line = lineOf(turn({ queuePosition: 2, queuedAtMs: NOW - 17 * 60 * MIN }));
    expect(activitySuffix(line)).toBe(": 대기 2번째");
    expect(activityText(line)).toBe("달무리봇: 대기 2번째");
  });

  it("5분 안의 요청은 「대기 n번째」 그대로, 근거 줄은 전과 같다", () => {
    const line = lineOf(turn({ queuePosition: 1, queuedAtMs: NOW - 2 * MIN }));
    expect(activitySuffix(line, NOW)).toBe(": 대기 1번째");
    expect(activityDetail(line, NOW)).toBe("2분째 기다려요");
  });

  it("생존 판정을 읽지 못했으면(undefined) 근거 줄에 문구도 이유도 지어내지 않는다", () => {
    const line = lineOf(turn({ queuedAtMs: NOW - 17 * 60 * MIN }));
    expect(activitySuffix(line, NOW)).toBe(": 아직 받지 않았어요");
    expect(activityDetail(line, NOW)).toBe("17시간째 기다려요");
  });

  it("시스템 작업 줄과 가져간 줄은 기존 규칙이다", () => {
    const welcome = lineOf(turn({ system: true, queuePosition: 1, queuedAtMs: NOW - 17 * 60 * MIN }), liveness("woken_not_collected"));
    expect(activitySuffix(welcome, NOW)).toBe(": 대기 1번째");
    expect(activityDetail(welcome, NOW)).toBe("17시간째 기다려요");

    const claimed = lineOf(
      turn({ phase: "claimed", leaseState: "stale", claimedAtMs: NOW - 34 * MIN, queuedAtMs: NOW - 40 * MIN }),
      liveness("woken_not_collected")
    );
    expect(activitySuffix(claimed, NOW)).not.toContain("아직 받지 않았어요");
    expect(activityDetail(claimed, NOW)).toBe("가져간 뒤 34분째 소식이 없어요");
  });
});

describe("종결(#4284 woken_not_collected): 카드가 사라지고 한 줄이 남는다", () => {
  const ended: AgentRunProgress = {
    id: "0199aa11-2222-7000-8000-0000000000b1",
    channelId: CH,
    agentMemberId: AGENT,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
    status: "timed_out",
    phase: "timed_out",
    leaseState: "none",
    stepCount: 0,
    ahead: [],
    endReason: "woken_not_collected",
    createdAtMs: NOW - 31 * MIN,
    updatedAtMs: NOW - MIN,
    finishedAtMs: NOW - MIN,
  };

  it("끝난 run은 열린 턴 신호가 아니다 — 홈 카드·활동 줄에 서지 않는다", () => {
    expect(signalFromProgress(ended)).toBeNull();
    expect(signalFromProgress({ ...ended, phase: "queued", status: "queued", endReason: undefined })).not.toBeNull();
  });

  it("보낸 메시지 아래 상태 줄은 끝낸 이유를 문장으로 남긴다", () => {
    const line = runStatusLine(ended, null, NOW);
    expect(line.ended).toBe(true);
    expect(runStatusText(line)).toContain("깨웠지만 가져가지 않아 끝냈어요");
  });
});

describe("취소·중단 낱말 한 벌 (#4285)", () => {
  const RESULT = {
    runId: "run-1",
    status: "cancelled" as const,
    linkedWorkSessionIds: [] as string[],
    workSessionsTerminated: false,
  };

  it("아직 아무도 가져가지 않은(queued) run만 「취소」, 가져간 뒤는 기존 「중단」이다", () => {
    expect(cancelWordingFor({ phase: "queued" })).toBe(UNTAKEN_WORDING);
    for (const phase of ["claimed", "running", "awaiting_approval", "paused"] as const) {
      expect(cancelWordingFor({ phase })).toBe(STOP_WORDING);
    }
    // 서버가 모르는 run은 알 수 없다 — 기존 말 그대로다.
    expect(cancelWordingFor(undefined)).toBe(STOP_WORDING);
    expect(cancelWordingFor(null)).toBe(STOP_WORDING);
  });

  it("기존 「중단」 한 벌은 바뀌지 않았다", () => {
    expect(STOP_WORDING.action).toBe("중단");
    expect(STOP_WORDING.commit).toBe("중단 확정");
    expect(STOP_WORDING.busy).toBe("중단 중");
    expect(STOP_WORDING.armName).toBe("실행 중단, 확인 필요");
    expect(STOP_WORDING.armHint).toBe("누르면 중단할지 물어요.");
    expect(STOP_WORDING.dismissName).toBe("중단하지 않기");
    expect(STOP_WORDING.consequence(1)).toBe(CANCEL_CONFIRM_SENTENCE);
    expect(STOP_WORDING.consequence(3)).toBe(cancelConfirmSentence(3));
    expect(STOP_WORDING.receipt(RESULT, "달무리봇")).toBe(cancelReceipt(RESULT, "달무리봇"));
  });

  it("「취소」 한 벌: 낱말·확인 문장·영수증", () => {
    expect(UNTAKEN_WORDING.action).toBe("취소");
    expect(UNTAKEN_WORDING.commit).toBe("취소 확정");
    expect(UNTAKEN_WORDING.busy).toBe("취소 중");
    expect(UNTAKEN_WORDING.armName).toBe("요청 취소, 확인 필요");
    expect(UNTAKEN_WORDING.armHint).toBe("누르면 취소할지 물어요.");
    expect(UNTAKEN_WORDING.dismissName).toBe("취소하지 않기");
    expect(UNTAKEN_WORDING.consequence(1)).toBe(
      "취소하면 이 요청은 여기서 끝나요. 같은 일은 다시 시킬 수 있어요."
    );
    expect(cancelUntakenConfirmSentence(3)).toMatch(
      /요청 3개가 기다리고 있고, 그중 맨 앞의 하나만 취소해요\.$/
    );
    expect(UNTAKEN_WORDING.announce(UNTAKEN_WORDING.consequence(1))).toMatch(/취소할지 물어요\.$/);
    expect(UNTAKEN_WORDING.receipt(RESULT, "달무리봇")).toBe("달무리봇의 요청을 취소했어요.");
  });

  it("서버가 이어진 작업 세션을 말하면 영수증은 그 사실을 줄이지 않는다", () => {
    const linked = { ...RESULT, linkedWorkSessionIds: ["s1"] };
    expect(UNTAKEN_WORDING.receipt(linked, "달무리봇")).toBe(cancelReceipt(linked, "달무리봇"));
  });

  it("cancelSucceeded는 낱말 한 벌을 받아 영수증을 만든다 (기본은 기존 「중단」)", () => {
    expect(cancelSucceeded(RESULT, "달무리봇")).toEqual({
      kind: "cancelled",
      sentence: "달무리봇의 실행을 중단했어요.",
    });
    expect(cancelSucceeded(RESULT, "달무리봇", UNTAKEN_WORDING)).toEqual({
      kind: "cancelled",
      sentence: "달무리봇의 요청을 취소했어요.",
    });
  });
});
