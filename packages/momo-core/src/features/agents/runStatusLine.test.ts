import { describe, expect, it } from "vitest";
import {
  agentRunLedgerFromWire,
  type AgentRunLedgerEvent,
  type AgentRunProgress,
} from "../../lib/api";
import {
  DOORBELL_FAILED_TEXT,
  DOORBELL_SENT_TEXT,
  LEDGER_UNKNOWN_TEXT,
  ledgerRows,
} from "./runLedger";
import {
  doorbellFactOf,
  runsByTriggerMessage,
  runStatusLine,
  runStatusText,
  wantsDoorbellFact,
} from "./runStatusLine";

const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
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

function ev(kind: AgentRunLedgerEvent["kind"], atMs: number, code?: string): AgentRunLedgerEvent {
  return { ordinal: 1, kind, createdAtMs: atMs, ...(code ? { code } : {}) };
}

describe("보낸 메시지 아래 상태 줄 (#3824)", () => {
  it("받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 → 결과 순으로 자란다", () => {
    const bell = doorbellFactOf([ev("queued", T), ev("doorbell_rung", T + 300, "leading_ok")]);
    const queued = runStatusLine(progress(), null, T + 400);
    expect(runStatusText(queued)).toBe("받았어요 · 방금 들어왔어요");

    const woken = runStatusLine(progress(), bell, T + 2 * SEC);
    expect(runStatusText(woken)).toBe("받았어요 → 깨우는 신호 보냄 · 2초째 기다려요");

    const claimed = runStatusLine(
      progress({ phase: "claimed", leaseState: "live", claimedAtMs: T + 5 * SEC }),
      bell,
      T + 6 * SEC
    );
    expect(claimed.steps.map((s) => s.key)).toEqual(["received", "woken", "claimed"]);

    const running = runStatusLine(
      progress({
        phase: "running",
        status: "running",
        leaseState: "live",
        claimedAtMs: T + 5 * SEC,
        startedAtMs: T + 6 * SEC,
        lastEventAtMs: T + 11 * MIN,
      }),
      bell,
      T + 12 * MIN + 6 * SEC
    );
    expect(runStatusText(running)).toBe(
      "받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 · 12분째 · 마지막 보고 1분 전"
    );

    const done = runStatusLine(
      progress({
        phase: "succeeded",
        status: "succeeded",
        claimedAtMs: T + 5 * SEC,
        startedAtMs: T + 6 * SEC,
        finishedAtMs: T + 3 * MIN + 12 * SEC,
      }),
      bell,
      T + 99 * MIN
    );
    expect(runStatusText(done)).toBe("받았어요 → 깨우는 신호 보냄 → 가져감 → 완료 · 3분 12초 걸림");
    expect(done.ended).toBe(true);
  });

  it("옛 서버(깨우는 신호 행 없음)에서는 그 단계를 빼고 잇는다", () => {
    const line = runStatusLine(
      progress({ phase: "running", status: "running", leaseState: "live", claimedAtMs: T, startedAtMs: T, lastEventAtMs: T }),
      doorbellFactOf([ev("queued", T), ev("claimed", T)]),
      T + 2 * MIN
    );
    expect(line.steps.map((s) => s.text)).toEqual(["받았어요", "가져감", "작업 중"]);
  });

  it("닿지 않은 신호는 닿지 않았다고 말한다", () => {
    const line = runStatusLine(
      progress(),
      doorbellFactOf([ev("doorbell_rung", T + 1, "leading_ok"), ev("doorbell_rung", T + 2, "trailing_failed")]),
      T + 3 * SEC
    );
    expect(line.steps[1]?.text).toBe("깨우는 신호가 닿지 않음");
  });

  it("승인 필요는 사람의 일이고 아무도 안 가져간 채 끝난 run에는 가져감이 없다", () => {
    const waiting = runStatusLine(
      progress({ phase: "awaiting_approval", status: "awaiting_approval", claimedAtMs: T, startedAtMs: T }),
      null,
      T + MIN
    );
    expect(waiting.needsHuman).toBe(true);
    expect(waiting.steps.at(-1)?.text).toBe("승인 필요");
    const expired = runStatusLine(
      progress({ phase: "timed_out", status: "timed_out", endReason: "unclaimed_expired", finishedAtMs: T + 30 * MIN }),
      null,
      T + 99 * MIN
    );
    expect(runStatusText(expired)).toBe("받았어요 → 시간 초과 · 30분 걸림 · 아무도 가져가지 않아 끝냈어요");
  });

  it("메시지마다 run을 모으고, 원장은 시작 전 run에만 묻는다", () => {
    const a = progress({ id: "b", createdAtMs: T + 2 });
    const b = progress({ id: "a", createdAtMs: T + 1 });
    const c = progress({ id: "c", triggerMessageId: undefined });
    const map = runsByTriggerMessage([a, b, c]);
    expect(map.get(MSG)?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(map.size).toBe(1);
    expect(wantsDoorbellFact({ phase: "queued" })).toBe(true);
    expect(wantsDoorbellFact({ phase: "claimed" })).toBe(true);
    expect(wantsDoorbellFact({ phase: "running" })).toBe(false);
  });
});

describe("원장: 깨우는 신호와 모르는 종류 (#3824)", () => {
  it("연속한 깨우는 신호는 한 줄로 접고 횟수를 붙인다", () => {
    const rows = ledgerRows([
      ev("queued", T),
      ev("doorbell_rung", T + 1, "leading_ok"),
      ev("doorbell_rung", T + 2, "trailing_ok"),
      ev("doorbell_rung", T + 3, "urgent_ok"),
      ev("doorbell_rung", T + 4, "trailing_failed"),
      ev("claimed", T + 5),
    ]);
    expect(rows.map((r) => [r.text, r.count ?? 1, r.tone])).toEqual([
      ["요청이 들어왔어요", 1, "neutral"],
      [DOORBELL_SENT_TEXT, 3, "neutral"],
      [DOORBELL_FAILED_TEXT, 1, "neutral"],
      ["에이전트가 일을 가져갔어요", 1, "neutral"],
    ]);
  });

  it("모르는 종류가 와도 원장 전체가 거부되지 않고 아는 줄은 그대로 그려진다", () => {
    const ledger = agentRunLedgerFromWire({
      runId: RUN.toUpperCase(),
      events: [
        { ordinal: 1, kind: "queued", createdAtMs: T },
        { ordinal: 2, kind: "tool_call", code: "ok", createdAtMs: T + 1 },
        { ordinal: 3, kind: "tool_call", code: "ok", createdAtMs: T + 2 },
        { ordinal: 4, kind: "claimed", createdAtMs: T + 3 },
      ],
    });
    expect(ledger.events.map((e) => e.kind)).toEqual(["queued", "unknown", "unknown", "claimed"]);
    expect(ledger.events[1]?.rawKind).toBe("tool_call");
    const rows = ledgerRows(ledger.events);
    expect(rows.map((r) => r.text)).toEqual([
      "요청이 들어왔어요",
      LEDGER_UNKNOWN_TEXT,
      "에이전트가 일을 가져갔어요",
    ]);
    expect(rows[1]?.count).toBe(2);
  });

  it("행의 모양 자체가 틀리면 여전히 거부한다", () => {
    expect(() =>
      agentRunLedgerFromWire({ runId: RUN, events: [{ ordinal: 1, kind: "queued" }] })
    ).toThrow();
  });

  it("timed_out + woken_not_collected 행을 받아들이고 끝 사유 문장을 만든다 (ADR-0200 증보 3 E6)", () => {
    const ledger = agentRunLedgerFromWire({
      runId: RUN,
      events: [
        { ordinal: 1, kind: "queued", createdAtMs: T },
        { ordinal: 2, kind: "doorbell_rung", code: "leading_ok", createdAtMs: T + 1 },
        { ordinal: 3, kind: "timed_out", code: "woken_not_collected", createdAtMs: T + 30 * MIN },
      ],
    });
    expect(ledger.events.map((e) => e.kind)).toEqual(["queued", "doorbell_rung", "timed_out"]);
    expect(ledger.events[2]?.code).toBe("woken_not_collected");
    expect(ledger.events[2]?.rawKind).toBeUndefined();
  });

  it("doorbell_rung을 아는 종류로 읽는다", () => {
    const ledger = agentRunLedgerFromWire({
      runId: RUN,
      events: [{ ordinal: 1, kind: "doorbell_rung", code: "leading_ok", createdAtMs: T }],
    });
    expect(ledger.events[0]?.kind).toBe("doorbell_rung");
    expect(ledger.events[0]?.rawKind).toBeUndefined();
  });
});
