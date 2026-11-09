import { describe, expect, it } from "vitest";
import type { SessionStatus } from "./sessionList";
import {
  NO_PANE_SIGNAL,
  PANE_SIGNALS,
  afterPersonInput,
  applyPaneSignalEvent,
  PANE_MARK_LABEL,
  attentionCopy,
  attentionLine,
  attentionTransitions,
  derivePaneMark,
  derivePaneStatus,
  paneStatusSource,
  sharedPaneState,
  nextWaitingPane,
  parsePaneSignal,
  parsePaneSignalEvent,
  shouldNotifyAttention,
  waitingLine,
  type PaneSignal,
  type PaneSignalEvent,
  type PaneSignalState,
  type PaneStatusInput,
} from "./paneStatus";

const live = (signal: PaneSignal | null): PaneStatusInput => ({
  phase: "running",
  exitCode: null,
  exitSignal: null,
  signal,
});

describe("derivePaneStatus (#2776, 제안서 §3.4)", () => {
  it("살아 있는 칸은 하네스 신호를 따른다", () => {
    expect(derivePaneStatus(live("ready"))).toBe("idle");
    expect(derivePaneStatus(live("working"))).toBe("running");
    expect(derivePaneStatus(live("waiting-permission"))).toBe("waiting");
    expect(derivePaneStatus(live("waiting-input"))).toBe("waiting");
    expect(derivePaneStatus(live("turn-done"))).toBe("done");
  });

  it("신호가 없으면(셸 칸) 생명주기만: 살아 있으면 실행 중", () => {
    expect(derivePaneStatus(live(null))).toBe("running");
    expect(derivePaneStatus({ phase: "starting", exitCode: null, exitSignal: null, signal: null })).toBe("idle");
  });

  it("끝난 프로세스는 마지막 신호와 무관하게 끝남·멈춤이다", () => {
    const exited = (code: number | null, sig: string | null, signal: PaneSignal | null) =>
      derivePaneStatus({ phase: "exited", exitCode: code, exitSignal: sig, signal });
    expect(exited(0, null, "waiting-permission")).toBe("done");
    expect(exited(1, null, "turn-done")).toBe("stopped");
    expect(exited(null, "9", "working")).toBe("stopped");
    expect(derivePaneStatus({ phase: "failed", exitCode: null, exitSignal: null, signal: "ready" })).toBe(
      "stopped"
    );
  });

  it("닫힌 목록 밖의 신호는 받지 않는다", () => {
    for (const s of PANE_SIGNALS) expect(parsePaneSignal(s)).toBe(s);
    for (const bad of ["Stop", "permission_prompt", "", "waiting", null, 3, { kind: "working" }]) {
      expect(parsePaneSignal(bad)).toBeNull();
    }
  });

  it("바닥 띠 문구는 기다리는 이유만 말한다", () => {
    expect(waitingLine("waiting-permission")).toBe("실행 허락을 기다려요");
    expect(waitingLine("waiting-input")).toBe("답을 기다려요");
    expect(waitingLine("turn-done")).toBeNull();
    expect(waitingLine(null)).toBeNull();
  });
});

describe("두 길 합치기: hook과 OSC 7501 보고 (#5579)", () => {
  const hook = (signal: PaneSignal): PaneSignalEvent => ({ from: "hook", signal });
  const report = (signal: PaneSignal | null): PaneSignalEvent => ({ from: "report", signal });
  const fold = (events: PaneSignalEvent[]): PaneSignalState => events.reduce(applyPaneSignalEvent, NO_PANE_SIGNAL);

  /** 사건을 차례로 합치며 칸 하나의 판정을 다시 내고, 새로 생긴 알림(상태)을 모은다. */
  const notified = (steps: (PaneSignalEvent | "input")[]): string[] => {
    let state = NO_PANE_SIGNAL;
    let previous = new Map<string, SessionStatus>([["p1", "running"]]);
    const out: string[] = [];
    for (const step of steps) {
      state = step === "input" ? afterPersonInput(state) : applyPaneSignalEvent(state, step);
      const next = new Map<string, SessionStatus>([["p1", derivePaneStatus(live(state.signal))]]);
      for (const t of attentionTransitions(previous, next)) out.push(t.status);
      previous = next;
    }
    return out;
  };

  it("채널 값은 { from, signal } 닫힌 모양만, 맨 문자열은 hook(#2776 모양)", () => {
    expect(parsePaneSignalEvent({ from: "hook", signal: "waiting-permission" })).toEqual(hook("waiting-permission"));
    expect(parsePaneSignalEvent({ from: "report", signal: "turn-done" })).toEqual(report("turn-done"));
    expect(parsePaneSignalEvent({ from: "report", signal: null })).toEqual(report(null));
    expect(parsePaneSignalEvent("working")).toEqual(hook("working"));
    for (const bad of [
      { from: "hook", signal: null },
      { from: "osc", signal: "working" },
      { from: "report", signal: "blocked" },
      { from: "report" },
      { signal: "working" },
      "Stop",
      null,
      3,
      [],
    ]) {
      expect(parsePaneSignalEvent(bad)).toBeNull();
    }
  });

  it("보고가 온 칸은 보고만 따르고, 같은 길에서는 마지막 것이 이긴다", () => {
    expect(fold([hook("ready"), hook("working")])).toEqual({ signal: "working", reports: false });
    expect(fold([hook("working"), report("waiting-permission"), hook("turn-done")])).toEqual({
      signal: "waiting-permission",
      reports: true,
    });
    expect(fold([report("working"), report("turn-done"), report(null)])).toEqual({ signal: null, reports: true });
    expect(fold([report(null), hook("working")])).toEqual({ signal: null, reports: true });
  });

  it("거둔 보고는 생명주기로 돌아간다: 살아 있으면 실행 중, 끝나면 끝남·멈춤", () => {
    const cleared = fold([report("waiting-permission"), report(null)]).signal;
    expect(derivePaneStatus(live(cleared))).toBe("running");
    expect(derivePaneStatus({ phase: "exited", exitCode: 0, exitSignal: null, signal: "waiting-permission" })).toBe("done");
  });

  it("Claude 모양: hook과 보고가 같은 기다림을 겹쳐 말해도 「응답 필요」·「끝남」은 한 번씩", () => {
    // PermissionRequest(hook) → blocked:permission(보고) → 사람이 허락 → working(보고)
    // → 5~6초 늦은 Notification permission_prompt(hook) → done(보고) → Stop(hook)
    expect(
      notified([
        hook("waiting-permission"),
        report("waiting-permission"),
        "input",
        report("working"),
        hook("waiting-permission"),
        hook("working"),
        report("turn-done"),
        hook("turn-done"),
      ])
    ).toEqual(["waiting", "done"]);
    // 보고가 먼저 오고 hook이 뒤따라도 같다.
    expect(notified([report("waiting-permission"), hook("waiting-permission"), report("working"), hook("waiting-permission")])).toEqual([
      "waiting",
    ]);
  });

  it("Codex 모양: 고르는 키에도 기다림은 그대로, 느린 notify에도 「끝남」은 한 번", () => {
    expect(
      notified([
        report("ready"),
        report("working"),
        report("waiting-permission"),
        "input",
        report("working"),
        report("turn-done"),
        "input",
        report("ready"),
        hook("turn-done"),
      ])
    ).toEqual(["waiting", "done"]);
  });

  it("사람의 입력: hook만 있는 칸의 기다림만 푼다", () => {
    expect(afterPersonInput({ signal: "waiting-permission", reports: false })).toEqual({ signal: "working", reports: false });
    expect(afterPersonInput({ signal: "waiting-input", reports: false })).toEqual({ signal: "working", reports: false });
    for (const kept of [
      { signal: "waiting-permission", reports: true },
      { signal: "waiting-input", reports: true },
      { signal: "turn-done", reports: false },
      { signal: "turn-done", reports: true },
      NO_PANE_SIGNAL,
    ] satisfies PaneSignalState[]) {
      expect(afterPersonInput(kept)).toBe(kept);
    }
  });
});

describe("attentionTransitions: 알림은 상태가 새로 될 때 한 번", () => {
  const m = (entries: [string, SessionStatus][]) => new Map(entries);

  it("응답 필요·끝남으로 바뀐 칸만", () => {
    const prev = m([
      ["a", "running"],
      ["b", "running"],
      ["c", "running"],
      ["d", "waiting"],
    ]);
    const next = m([
      ["a", "waiting"],
      ["b", "done"],
      ["c", "stopped"],
      ["d", "waiting"],
    ]);
    expect(attentionTransitions(prev, next)).toEqual([
      { paneId: "a", status: "waiting" },
      { paneId: "b", status: "done" },
    ]);
  });

  it("같은 판정을 다시 계산해도 다시 알리지 않는다", () => {
    const s = m([["a", "waiting"]]);
    expect(attentionTransitions(s, s)).toEqual([]);
    expect(attentionTransitions(s, m([["a", "waiting"]]))).toEqual([]);
  });

  it("기다림 → 끝남은 새 알림이다", () => {
    expect(attentionTransitions(m([["a", "waiting"]]), m([["a", "done"]]))).toEqual([
      { paneId: "a", status: "done" },
    ]);
  });

  it("보고 있는 칸은 OS 알림을 띄우지 않는다", () => {
    expect(shouldNotifyAttention({ windowFocused: true, paneInView: true })).toBe(false);
    expect(shouldNotifyAttention({ windowFocused: false, paneInView: true })).toBe(true);
    expect(shouldNotifyAttention({ windowFocused: true, paneInView: false })).toBe(true);
  });

  it("알림 일시 중지 중에는 어느 칸도 OS 알림을 띄우지 않는다 (#4197)", () => {
    // 창이 뒤에 있고 칸이 안 보여서 평소라면 뜰 자리다(위 단정의 true 두 줄과 같은 입력).
    expect(shouldNotifyAttention({ windowFocused: false, paneInView: false })).toBe(true);
    expect(shouldNotifyAttention({ windowFocused: false, paneInView: false, paused: true })).toBe(false);
    expect(shouldNotifyAttention({ windowFocused: false, paneInView: true, paused: true })).toBe(false);
    expect(shouldNotifyAttention({ windowFocused: true, paneInView: false, paused: true })).toBe(false);
    // 못 읽은 규칙(비어 있음)이나 꺼진 규칙은 막지 않는다.
    expect(shouldNotifyAttention({ windowFocused: false, paneInView: false, paused: false })).toBe(true);
  });

  it("알림 문구는 칸 번호·이름과 이유만", () => {
    expect(attentionCopy("waiting", { index: 3, name: "claude" }, "waiting-permission")).toEqual({
      title: "응답 필요",
      body: "3번 칸 · claude: 실행 허락을 기다려요",
    });
    expect(attentionCopy("done", { index: 1, name: "codex" }, "turn-done")).toEqual({
      title: "끝남",
      body: "1번 칸 · codex: 작업이 끝났어요",
    });
  });
});

describe("nextWaitingPane (⌃⇧J)", () => {
  const ids = ["p1", "p2", "p3", "p4"];
  const status: Record<string, SessionStatus> = { p1: "waiting", p2: "running", p3: "waiting", p4: "done" };
  const of = (id: string) => status[id];

  it("지금 칸 다음부터 한 바퀴", () => {
    expect(nextWaitingPane(ids, of, "p1")).toBe("p3");
    expect(nextWaitingPane(ids, of, "p3")).toBe("p1");
    expect(nextWaitingPane(ids, of, "p4")).toBe("p1");
    expect(nextWaitingPane(ids, of, null)).toBe("p1");
  });

  it("지금 칸만 기다리면 그 칸, 없으면 null", () => {
    expect(nextWaitingPane(ids, (id) => (id === "p2" ? "waiting" : "running"), "p2")).toBe("p2");
    expect(nextWaitingPane(ids, () => "running", "p1")).toBeNull();
    expect(nextWaitingPane([], of, null)).toBeNull();
  });
});

// design-review #5584 H1: 프로그램이 턴 실패(OSC 7501 `error`)를 보고한 칸은 성공 모양으로 그리지 않는다.
describe("실패한 턴: 「끝남」의 수명, 「실패」의 모양 (#5584 H1)", () => {
  const exited = (code: number, signal: PaneSignal | null): PaneStatusInput => ({
    phase: "exited",
    exitCode: code,
    exitSignal: null,
    signal,
  });

  it("상태는 「끝남」(정렬·묶기·알림 수명), 표지는 「실패」", () => {
    expect(PANE_SIGNALS).toContain("turn-failed");
    expect(parsePaneSignalEvent({ from: "report", signal: "turn-failed" })).toEqual({ from: "report", signal: "turn-failed" });
    expect(derivePaneStatus(live("turn-failed"))).toBe("done");
    expect(derivePaneMark(live("turn-failed"))).toBe("failed");
    expect(derivePaneMark(live("turn-done"))).toBe("done");
    expect(PANE_MARK_LABEL.failed).toBe("실패");
    expect(PANE_MARK_LABEL.failed).not.toBe(PANE_MARK_LABEL.done);
    // 다른 신호의 표지는 상태 그대로다.
    for (const signal of PANE_SIGNALS.filter((s) => s !== "turn-failed")) {
      expect(derivePaneMark(live(signal))).toBe(derivePaneStatus(live(signal)));
    }
  });

  it("생명주기가 이긴다: 끝난 프로세스는 마지막 신호가 실패였어도 실패 표지가 아니다", () => {
    expect(derivePaneMark(exited(0, "turn-failed"))).toBe("done");
    expect(derivePaneMark(exited(1, "turn-failed"))).toBe("stopped");
  });

  it("알림 문구: 제목 「실패」, 본문은 무슨 일이 있었는지. 성공의 말이 아니다", () => {
    const copy = attentionCopy("failed", { index: 3, name: "빌드 스크립트 정리" }, "turn-failed");
    expect(copy).toEqual({ title: "실패", body: "3번 칸 · 빌드 스크립트 정리: 오류로 끝났어요" });
    const done = attentionCopy("done", { index: 3, name: "빌드 스크립트 정리" }, "turn-done");
    expect(copy.title).not.toBe(done.title);
    expect(copy.body).not.toContain("작업이 끝났어요");
    expect(attentionLine("failed", "turn-failed")).toBe("오류로 끝났어요");
    expect(attentionLine("done", "turn-done")).toBe("작업이 끝났어요");
    expect(attentionLine("waiting", "waiting-input")).toBe("답을 기다려요");
  });

  it("「끝남」 뒤의 「실패」는 새 전이다(실패가 끝남의 알림에 묻히지 않는다), 같은 실패는 한 번", () => {
    const m = (entries: [string, string][]) => new Map(entries) as Map<string, never>;
    expect(attentionTransitions(m([["p1", "running"]]), m([["p1", "failed"]]))).toEqual([{ paneId: "p1", status: "failed" }]);
    expect(attentionTransitions(m([["p1", "done"]]), m([["p1", "failed"]]))).toEqual([{ paneId: "p1", status: "failed" }]);
    expect(attentionTransitions(m([["p1", "failed"]]), m([["p1", "failed"]]))).toEqual([]);
  });

  it("공유 요약은 실패를 「끝남」으로 싣지 않는다: 서버 목록에 실패가 없어 「대기」", () => {
    expect(sharedPaneState(live("turn-failed"))).toBe("idle");
    expect(sharedPaneState(live("turn-done"))).toBe("done");
    expect(sharedPaneState(exited(0, "turn-failed"))).toBe("done");
    for (const signal of PANE_SIGNALS.filter((s) => s !== "turn-failed")) {
      expect(sharedPaneState(live(signal))).toBe(derivePaneStatus(live(signal)));
    }
  });
});

describe("출처 한 줄 (#5584 M2, ADR-0220 「에이전트 보고」)", () => {
  it("그 프로그램이 알린 상태일 때만, 이름에 맞는 조사로", () => {
    expect(paneStatusSource(live("waiting-permission"), "Codex")).toBe("Codex가 알린 상태예요");
    expect(paneStatusSource(live("turn-failed"), "Claude Code")).toBe("Claude Code가 알린 상태예요");
    expect(paneStatusSource(live("working"), "Grok")).toBe("Grok이 알린 상태예요");
    // 신호가 없거나(생명주기만) 끝난 칸에는 붙이지 않는다.
    expect(paneStatusSource(live(null), "Codex")).toBeNull();
    expect(paneStatusSource({ phase: "exited", exitCode: 0, exitSignal: null, signal: "turn-done" }, "Codex")).toBeNull();
  });
});
