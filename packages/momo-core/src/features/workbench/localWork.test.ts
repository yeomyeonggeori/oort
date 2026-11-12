import { describe, expect, it } from "vitest";
import {
  LOCAL_WORK_CLEAR,
  RESTART_QUIET_MS,
  localWorkVerdict,
  restartGateStep,
  type LocalWorkFacts,
  type RestartGate,
} from "./localWork";
import type { PaneSignal, PaneStatusInput } from "./paneStatus";

// 업데이트 뒤 자동 다시 시작의 문(#5661, owner 2026-11-11). 가짜 시계: `now`는 인자다.

const T0 = Date.UTC(2026, 10, 11, 3, 0, 0);

const pane = (signal: PaneSignal | null, phase: PaneStatusInput["phase"] = "running"): PaneStatusInput => ({
  phase,
  exitCode: phase === "exited" ? 0 : null,
  exitSignal: null,
  signal,
});

const facts = (over: Partial<LocalWorkFacts> = {}): LocalWorkFacts => ({
  panes: [],
  workHost: { running: false },
  hostSessions: null,
  ...over,
});

/** 판정을 차례로 문에 더한다: [시각, 사실]. */
function run(steps: [number, LocalWorkFacts][]): RestartGate[] {
  let gate: RestartGate | null = null;
  return steps.map(([at, f]) => (gate = restartGateStep(gate, localWorkVerdict(f), at)));
}

describe("다시 시작의 문", () => {
  it("로컬 작업이 없으면 설치가 끝난 그 판정에서 곧바로 다시 시작한다(쉬는 시간을 기다리지 않는다)", () => {
    const idleHarness = facts({ panes: [pane("ready"), pane("turn-done"), pane(null, "exited")] });
    expect(localWorkVerdict(idleHarness)).toEqual(LOCAL_WORK_CLEAR);
    expect(run([[T0, idleHarness]])).toEqual([{ kind: "go" }]);
    // 데몬이 돌아도 이 맥 세션이 일시 중지(주차)·끝남뿐이면 끊길 것이 없다.
    const parked = facts({ workHost: { running: true }, hostSessions: [{ status: "idle" }, { status: "ended" }] });
    expect(run([[T0, parked]])).toEqual([{ kind: "go" }]);
  });

  it("실행 중이면 기다린다: 일하는 하네스 칸, 살아 있는 셸 칸(모름), 뜨는 중인 칸, 도는 작업 세션", () => {
    expect(localWorkVerdict(facts({ panes: [pane("working")] }))).toEqual({ kind: "busy", panes: 1, sessions: 0, unknown: false });
    // 셸 칸은 쉬는지 명령을 돌리는지 알려 주는 신호가 없다: 늘 「실행 중」이라 기다린다.
    expect(localWorkVerdict(facts({ panes: [pane(null)] }))).toEqual({ kind: "busy", panes: 1, sessions: 0, unknown: false });
    expect(localWorkVerdict(facts({ panes: [pane(null, "starting")] }))).toEqual({ kind: "busy", panes: 1, sessions: 0, unknown: false });
    const session = facts({ workHost: { running: true }, hostSessions: [{ status: "running" }, { status: "idle" }] });
    expect(localWorkVerdict(session)).toEqual({ kind: "busy", panes: 0, sessions: 1, unknown: false });
    expect(run([[T0, session]])[0]?.kind).toBe("hold");
  });

  it("응답을 기다리는 칸(허락·답)도 기다린다", () => {
    const waiting = facts({ panes: [pane("waiting-permission"), pane("waiting-input"), pane("ready")] });
    expect(localWorkVerdict(waiting)).toEqual({ kind: "busy", panes: 2, sessions: 0, unknown: false });
    expect(run([[T0, waiting]])[0]?.kind).toBe("hold");
  });

  it("모르면 끊지 않는다: 데몬 상태를 못 읽음, 데몬은 도는데 세션 목록을 못 읽음", () => {
    expect(localWorkVerdict(facts({ workHost: null }))).toEqual({ kind: "busy", panes: 0, sessions: 0, unknown: true });
    expect(localWorkVerdict(facts({ workHost: { running: true }, hostSessions: null }))).toEqual({
      kind: "busy",
      panes: 0,
      sessions: 0,
      unknown: true,
    });
    expect(run([[T0, facts({ workHost: null })]])[0]?.kind).toBe("hold");
  });

  it("작업이 끝난 뒤 쉬는 상태가 2분 이어진 새 판정에서 다시 시작하고, 그 사이 다시 일하면 처음부터 잰다", () => {
    const busy = facts({ panes: [pane("working")] });
    const rest = facts({ panes: [pane("turn-done")] });
    const gates = run([
      [T0, busy],
      [T0 + 5_000, rest],
      [T0 + 5_000 + RESTART_QUIET_MS - 1, rest],
      [T0 + 60_000, busy], // 다음 턴을 받았다: 다시 기다린다
      [T0 + 65_000, rest],
      [T0 + 65_000 + RESTART_QUIET_MS - 1, rest],
      [T0 + 65_000 + RESTART_QUIET_MS, rest],
      [T0 + 65_000 + RESTART_QUIET_MS + 1_000, busy], // 카운트다운 중에 칸이 일을 시작했다
    ]);
    expect(gates.map((g) => g.kind)).toEqual(["hold", "settling", "settling", "hold", "settling", "settling", "go", "hold"]);
    expect(gates[4]).toEqual({ kind: "settling", quietSince: T0 + 65_000 });
  });
});
