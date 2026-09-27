import { describe, expect, it } from "vitest";
import type { SessionStatus } from "./sessionList";
import {
  PANE_SIGNALS,
  attentionCopy,
  attentionTransitions,
  derivePaneStatus,
  nextWaitingPane,
  parsePaneSignal,
  shouldNotifyAttention,
  waitingLine,
  type PaneSignal,
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

describe("attentionTransitions: 알림은 상태가 새로 될 때 한 번", () => {
  const m = (entries: [string, SessionStatus][]) => new Map(entries);

  it("나를 기다림·끝남으로 바뀐 칸만", () => {
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

  it("알림 문구는 칸 번호·이름과 이유만", () => {
    expect(attentionCopy("waiting", { index: 3, name: "claude" }, "waiting-permission")).toEqual({
      title: "나를 기다림",
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
