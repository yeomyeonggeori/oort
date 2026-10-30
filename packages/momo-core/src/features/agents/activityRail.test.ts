import { describe, expect, it } from "vitest";
import type { AgentRunPhase, AgentRunProgress } from "../../lib/api";
import {
  activityRail,
  RAIL_WORD,
  RAIL_WORD_RECEIVED,
  RAIL_WORD_WOKEN,
} from "./activityRail";
import { runPhaseLabel, signalFromProgress } from "./runPhase";
import { RUN_STATUS_CLAIMED, RUN_STATUS_WORKING } from "./runStatusLine";
import { UNCOLLECTED_AFTER_MS } from "./runWaiting";
import type { AgentNameLookup, AgentNameParts } from "./turnCopy";
import type { AgentWorkingSignal } from "./workingSignal";

// =============================================================================
// 입력창 레일의 모델 (#4619 A): 국면별 문구, 합치기, 끝나면 사라짐, 「아직 받지 않았어요」 유예를 넘은 run의 퇴장,
// 팝오버의 1분 단위 근거, 그리고 어디에도 초 단위 숫자가 없다는 것.
// =============================================================================

const CH = "00000000-0000-7000-8000-000000000201";
const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";
const C = "00000000-0000-7000-8000-000000000303";
const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const NAMES: Record<string, AgentNameParts> = {
  [A]: { name: "달무리봇" },
  [B]: { name: "모래시계봇" },
  [C]: { name: "구름봇" },
};
const nameFor: AgentNameLookup = (id) => NAMES[id] ?? { name: "" };

function progress(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id: "0199aa11-2222-7000-8000-0000000000a1",
    channelId: CH,
    agentMemberId: A,
    triggerMessageId: "0199aa11-2222-7000-8000-0000000000c1",
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

function turn(extra: Partial<AgentRunProgress> = {}): AgentWorkingSignal {
  const signal = signalFromProgress(progress(extra));
  if (signal === null) throw new Error("열린 턴이 아니다");
  return signal;
}

const RUNNING = {
  phase: "running",
  status: "running",
  leaseState: "live",
  claimedAtMs: T,
  startedAtMs: T,
  latestStage: "설계 문서 읽는 중",
  lastEventAtMs: T,
} as const satisfies Partial<AgentRunProgress>;

const CLAIMED = {
  phase: "claimed",
  leaseState: "live",
  claimedAtMs: T,
} as const satisfies Partial<AgentRunProgress>;

const APPROVAL = {
  phase: "awaiting_approval",
  status: "awaiting_approval",
  startedAtMs: T,
} as const satisfies Partial<AgentRunProgress>;

describe("국면 → 한 줄", () => {
  it("낱말은 runPhase·runStatusLine 어휘 그대로다(새로 정한 것은 받음·깨움 둘뿐)", () => {
    expect(RAIL_WORD.claimed).toBe(RUN_STATUS_CLAIMED);
    expect(RAIL_WORD.working).toBe(RUN_STATUS_WORKING);
    expect(RAIL_WORD.approval).toBe(
      runPhaseLabel({ phase: "awaiting_approval", leaseState: "none", queuedAtMs: 0 })
    );
    expect(RAIL_WORD.paused).toBe(
      runPhaseLabel({ phase: "paused", leaseState: "none", queuedAtMs: 0 })
    );
    expect(RAIL_WORD.received).toBe(RAIL_WORD_RECEIVED);
    expect(RAIL_WORD.woken).toBe(RAIL_WORD_WOKEN);
    expect(Object.values(RAIL_WORD)).toEqual([
      "받음",
      "깨움",
      "가져감",
      "작업 중",
      "승인 필요",
      "일시 정지",
    ]);
  });

  it("작업 중: 「이름 · 작업 중 · 최근 단계」, 단계가 없으면 「이름 · 작업 중」", () => {
    const withStage = activityRail([turn(RUNNING)], nameFor, T + MIN);
    expect(withStage?.text).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(withStage?.lead).toMatchObject({ phase: "working", active: true, needsHuman: false });

    const noStage = activityRail([turn({ ...RUNNING, latestStage: undefined })], nameFor, T + MIN);
    expect(noStage?.text).toBe("달무리봇 · 작업 중");
    expect(noStage?.lead.stage).toBeUndefined();
  });

  it("받음 · 깨움 · 가져감 · 승인 필요 · 일시 정지", () => {
    expect(activityRail([turn()], nameFor, T + 10 * SEC)?.text).toBe("달무리봇 · 받음");

    const bell = (failed: boolean) => (runId: string) =>
      runId === turn().runId ? { lastAtMs: T + SEC, failed, count: 1 } : null;
    expect(activityRail([turn()], nameFor, T + 10 * SEC, { doorbellFor: bell(false) })?.text).toBe(
      "달무리봇 · 깨움"
    );
    // 깨우는 신호가 닿지 않았으면 그것은 깨움이 아니다.
    expect(activityRail([turn()], nameFor, T + 10 * SEC, { doorbellFor: bell(true) })?.text).toBe(
      "달무리봇 · 받음"
    );

    expect(activityRail([turn(CLAIMED)], nameFor, T + MIN)?.text).toBe("달무리봇 · 가져감");
    const approval = activityRail([turn(APPROVAL)], nameFor, T + MIN);
    expect(approval?.text).toBe("달무리봇 · 승인 필요");
    expect(approval).toMatchObject({ needsHuman: true, active: false });
    expect(
      activityRail([turn({ phase: "paused", status: "paused", startedAtMs: T })], nameFor, T + MIN)
        ?.text
    ).toBe("달무리봇 · 일시 정지");
  });

  it("점이 도는 조건(active): 작업 중, 그리고 소식이 끊기지 않은 가져감만", () => {
    expect(activityRail([turn(RUNNING)], nameFor, T + MIN)?.active).toBe(true);
    expect(activityRail([turn(CLAIMED)], nameFor, T + MIN)?.active).toBe(true);
    // 가져간 뒤 소식이 끊겼으면 아무도 일하지 않는 줄이 일하는 것처럼 보이지 않는다.
    expect(activityRail([turn({ ...CLAIMED, leaseState: "stale" })], nameFor, T + MIN)?.active).toBe(
      false
    );
    expect(activityRail([turn()], nameFor, T + 10 * SEC)?.active).toBe(false);
    expect(activityRail([turn(APPROVAL)], nameFor, T + MIN)?.active).toBe(false);
  });

  it("줄은 항상 이끄는 에이전트의 이름으로 시작한다(표면이 이름만 따로 칠한다)", () => {
    const dup: AgentNameLookup = () => ({ name: "달무리봇", handle: "@dalmuri-bot" });
    for (const [lookup, turns] of [
      [nameFor, [turn(RUNNING)]],
      [dup, [turn(RUNNING)]],
      [nameFor, [turn(CLAIMED), turn({ ...CLAIMED, id: "0199aa11-2222-7000-8000-0000000000a9", agentMemberId: B })]],
    ] as const) {
      const rail = activityRail(turns, lookup, T + MIN)!;
      expect(rail.text.startsWith(rail.leadLabel)).toBe(true);
      expect(rail.text.slice(rail.leadLabel.length)).toMatch(/^( · | \+\d+$)/);
    }
  });

  it("같은 이름이 둘이면 핸들이 붙는다(이름만으로는 누구인지 모른다)", () => {
    const dup: AgentNameLookup = () => ({ name: "달무리봇", handle: "@dalmuri-bot" });
    expect(activityRail([turn(RUNNING)], dup, T + MIN)?.text).toBe(
      "달무리봇(@dalmuri-bot) · 작업 중 · 설계 문서 읽는 중"
    );
  });

  it("이름을 모르는 에이전트는 이름을 지어내지 않는다", () => {
    const unknown: AgentNameLookup = () => ({ name: "  " });
    expect(activityRail([turn(RUNNING)], unknown, T + MIN)?.text).toBe(
      "에이전트 · 작업 중 · 설계 문서 읽는 중"
    );
  });
});

describe("여러 에이전트는 한 줄로 합친다", () => {
  const a = () => turn({ ...RUNNING, id: "0199aa11-2222-7000-8000-0000000000a1" });
  const b = () =>
    turn({
      ...RUNNING,
      id: "0199aa11-2222-7000-8000-0000000000a2",
      agentMemberId: B,
      startedAtMs: T + MIN,
      latestStage: "표 정리하는 중",
    });
  const c = () =>
    turn({
      ...CLAIMED,
      id: "0199aa11-2222-7000-8000-0000000000a3",
      agentMemberId: C,
    });

  it("둘이면 「이름 +1」, 셋이면 「이름 +2」이고, 합친 줄에는 단계가 없다", () => {
    const two = activityRail([a(), b()], nameFor, T + 2 * MIN);
    expect(two?.text).toBe("달무리봇 +1");
    expect(two?.extra).toBe(1);
    expect(two?.agents).toHaveLength(2);

    const three = activityRail([a(), b(), c()], nameFor, T + 2 * MIN);
    expect(three?.text).toBe("달무리봇 +2");
    expect(three?.extra).toBe(2);
    expect(three?.text).not.toContain("설계 문서");
  });

  it("줄을 이끄는 쪽: 승인 필요 > 작업 중 > 가져감, 같으면 먼저 시작한 쪽", () => {
    // 입력 순서와 무관하다.
    expect(activityRail([b(), a()], nameFor, T + 2 * MIN)?.lead.memberId).toBe(A);
    expect(activityRail([c(), b(), a()], nameFor, T + 2 * MIN)?.agents.map((x) => x.memberId)).toEqual(
      [A, B, C]
    );
    // 늦게 시작했어도 사람을 기다리는 에이전트가 줄을 이끈다.
    const waiting = turn({ ...APPROVAL, id: "0199aa11-2222-7000-8000-0000000000a4", agentMemberId: B, startedAtMs: T + 5 * MIN });
    const lead = activityRail([a(), waiting], nameFor, T + 6 * MIN);
    // 합친 줄도 사람을 기다리는 쪽의 낱말을 남긴다(색 하나로만 전하지 않는다, M5).
    expect(lead?.text).toBe("모래시계봇 · 승인 필요 +1");
    expect(lead?.needsHuman).toBe(true);
    // 합친 줄에서도 사람이 할 일이 있다는 사실은 사라지지 않는다.
    expect(lead?.label).toContain("승인을 기다려요");
  });

  it("합친 줄의 낱말은 이끄는 쪽이 사람을 기다릴 때만 선다: 작업 중·가져감만 모이면 이름과 수뿐이다", () => {
    expect(activityRail([a(), c()], nameFor, T + 2 * MIN)?.text).toBe("달무리봇 +1");
    const waiting = turn({ ...APPROVAL, id: "0199aa11-2222-7000-8000-0000000000a4", agentMemberId: B, startedAtMs: T + 5 * MIN });
    const paused = turn({ ...APPROVAL, phase: "paused", status: "paused", id: "0199aa11-2222-7000-8000-0000000000a5", agentMemberId: C });
    expect(activityRail([a(), waiting, paused], nameFor, T + 6 * MIN)?.text).toBe("모래시계봇 · 승인 필요 +2");
    // 일시 정지는 줄을 이끌 수는 있어도(작업 중보다 앞선다) 「사람이 할 일이 있다」(`needsHuman`)가 아니라 낱말이 남지 않는다.
    const withPaused = activityRail([a(), paused], nameFor, T + 6 * MIN);
    expect(withPaused?.lead.memberId).toBe(C);
    expect(withPaused?.needsHuman).toBe(false);
    expect(withPaused?.text).toBe("구름봇 +1");
    // 합친 줄의 글에는 초 단위 숫자가 없다.
    expect(activityRail([a(), waiting], nameFor, T + 6 * MIN)?.text).not.toMatch(/\d+\s*초/);
  });

  it("보조기술 이름은 모든 에이전트의 상태를 말하고 숫자가 없다", () => {
    const rail = activityRail([a(), b(), c()], nameFor, T + 2 * MIN)!;
    expect(rail.label).toContain("달무리봇 에이전트가 작업 중이에요.");
    expect(rail.label).toContain("모래시계봇 에이전트가 작업 중이에요.");
    expect(rail.label).toContain("구름봇 에이전트가 일을 가져갔어요.");
    expect(rail.label).not.toMatch(/\d/);
  });
});

describe("끝나면 사라진다", () => {
  const ended = ["succeeded", "failed", "cancelled", "timed_out"] as const satisfies readonly AgentRunPhase[];

  it("끝난 phase는 열린 턴이 아니라 입력에 오지 않고, 레일은 null이다", () => {
    for (const phase of ended) {
      expect(signalFromProgress(progress({ phase, status: phase })), phase).toBeNull();
    }
    expect(activityRail([], nameFor, T)).toBeNull();
  });

  it("작업 중이던 run이 끝나면 레일이 비고, 한 에이전트가 남으면 합침도 풀린다", () => {
    const a = turn({ ...RUNNING, id: "0199aa11-2222-7000-8000-0000000000a1" });
    const b = turn({
      ...RUNNING,
      id: "0199aa11-2222-7000-8000-0000000000a2",
      agentMemberId: B,
      latestStage: "표 정리하는 중",
    });
    expect(activityRail([a, b], nameFor, T + MIN)?.text).toBe("달무리봇 +1");
    expect(activityRail([b], nameFor, T + MIN)?.text).toBe("모래시계봇 · 작업 중 · 표 정리하는 중");
    expect(activityRail([], nameFor, T + MIN)).toBeNull();
  });
});

describe("「아직 받지 않았어요」 유예를 넘은 run은 레일에서 빠진다(예외 줄이 말한다)", () => {
  it("유예 안에서는 「받음」, 마감부터는 레일에서 빠진다(경계 ±1ms)", () => {
    const queued = turn();
    expect(activityRail([queued], nameFor, T + UNCOLLECTED_AFTER_MS - 1)?.text).toBe("달무리봇 · 받음");
    expect(activityRail([queued], nameFor, T + UNCOLLECTED_AFTER_MS)).toBeNull();
    expect(activityRail([queued], nameFor, T + UNCOLLECTED_AFTER_MS + 1)).toBeNull();
  });

  it("다른 에이전트가 일하는 중이면 그 줄만 남는다(합치지 않는다)", () => {
    const stuck = turn({ id: "0199aa11-2222-7000-8000-0000000000a5", agentMemberId: B });
    const working = turn(RUNNING);
    const rail = activityRail([stuck, working], nameFor, T + 10 * MIN);
    expect(rail?.text).toBe("달무리봇 · 작업 중 · 설계 문서 읽는 중");
    expect(rail?.extra).toBe(0);
  });

  it("루틴 박자를 알면 예상 확인 시각까지 「받음」으로 남는다", () => {
    const routineFor = () => ({ typicalMinutes: 15, expectedCheckAtMs: T + 14 * MIN });
    const queued = turn();
    expect(activityRail([queued], nameFor, T + 10 * MIN, { routineFor })?.text).toBe("달무리봇 · 받음");
    expect(activityRail([queued], nameFor, T + 14 * MIN, { routineFor })).toBeNull();
  });

  it("예상 확인 시각이 5분보다 빠르면 그 시각이 이긴다(기본 유예를 기다리지 않는다)", () => {
    const routineFor = () => ({ typicalMinutes: 1, expectedCheckAtMs: T + 90 * SEC });
    const queued = turn();
    expect(activityRail([queued], nameFor, T + 90 * SEC - 1, { routineFor })?.text).toBe("달무리봇 · 받음");
    expect(activityRail([queued], nameFor, T + 90 * SEC, { routineFor })).toBeNull();
    // 박자를 모르면 같은 시각에도 아직 「받음」이다.
    expect(activityRail([queued], nameFor, T + 90 * SEC)?.text).toBe("달무리봇 · 받음");
  });

  it("사람이 부르지 않은 시스템 작업(환영)은 몇 시간이 지나도 레일에 남는다", () => {
    const welcome = turn({ triggerMessageId: undefined, system: true });
    expect(activityRail([welcome], nameFor, T + 17 * HOUR)?.text).toBe("달무리봇 · 받음");
  });
});

describe("팝오버의 1분 단위 근거", () => {
  it("작업 중 「n분째」, 가져감 「n분 전에 가져감」, 소식 끊김, 받음 「n분째 기다려요」", () => {
    const working = activityRail([turn(RUNNING)], nameFor, T + 12 * MIN + 30 * SEC);
    expect(working?.lead.detail).toBe("12분째");
    const claimed = activityRail([turn(CLAIMED)], nameFor, T + 3 * MIN + 30 * SEC);
    expect(claimed?.lead.detail).toBe("3분 전에 가져감");
    const stale = activityRail(
      [turn({ ...CLAIMED, leaseState: "stale" })],
      nameFor,
      T + 34 * MIN
    );
    expect(stale?.lead.detail).toBe("가져간 뒤 34분째 소식이 없어요");
    const received = activityRail([turn()], nameFor, T + 90 * SEC);
    expect(received?.lead.detail).toBe("1분째 기다려요");
  });

  it("1분이 안 되면 근거가 없다(초를 말하지 않는다)", () => {
    for (const extra of [RUNNING, CLAIMED, {}] as Partial<AgentRunProgress>[]) {
      expect(activityRail([turn(extra)], nameFor, T + 59 * SEC)?.lead.detail, JSON.stringify(extra)).toBeUndefined();
    }
  });
});

describe("초 단위 숫자가 없다", () => {
  const phases: Partial<AgentRunProgress>[] = [
    {},
    CLAIMED,
    { ...CLAIMED, leaseState: "stale" },
    RUNNING,
    APPROVAL,
  ];
  const offsets = [0, 1 * SEC, 5 * SEC, 59 * SEC, 61 * SEC, 119 * SEC, 125 * SEC, 3601 * SEC, 90 * MIN];

  it("어떤 국면·경과에서도 줄·낱말·근거·보조기술 이름에 「n초」가 없다", () => {
    let railsSeen = 0;
    let detailsSeen = 0;
    for (const extra of phases) {
      for (const dt of offsets) {
        const rail = activityRail([turn(extra)], nameFor, T + dt, {
          // 유예를 크게 줘서 받음 상태가 시험 내내 레일에 남게 한다.
          graceMs: 24 * HOUR,
        });
        if (rail === null) continue;
        railsSeen += 1;
        const where = `${JSON.stringify(extra)} +${dt}ms`;
        const texts = [
          rail.text,
          rail.label,
          ...rail.agents.flatMap((agent) => [agent.word, agent.stage ?? "", agent.detail ?? ""]),
        ];
        for (const text of texts) {
          expect(text, where).not.toMatch(/\d+\s*초/);
          expect(text, where).not.toMatch(/\d+\s*s\b/);
        }
        if (rail.lead.detail !== undefined) detailsSeen += 1;
      }
    }
    // 빈 반복이 아니라는 증거: 줄이 여러 번 만들어졌고, 근거 문장(분 단위)이 실제로 나온 경우가 있다.
    expect(railsSeen).toBeGreaterThanOrEqual(30);
    expect(detailsSeen).toBeGreaterThanOrEqual(10);
  });
});
