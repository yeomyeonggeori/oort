import { describe, expect, it } from "vitest";
import type { AgentRunLedgerEvent, AgentRunProgress } from "../../lib/api";
import * as workLog from "./workLog";
import * as turnCopy from "./turnCopy";
import * as runLedger from "./runLedger";
import {
  clockLabel,
  ledgerRows,
  queueAhead,
  RUN_LEDGER_KEPT_SENTENCE,
  RUN_LEDGER_LIMIT_SENTENCE,
  RUN_LIST_DONE_LIMIT,
  runEmptyState,
  runList,
} from "./runLedger";

const T = 1_800_000_000_000;
const MIN = 60_000;
const CH = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";
const OTHER_AGENT = "00000000-0000-7000-8000-000000000302";

function ev(extra: Partial<AgentRunLedgerEvent> & Pick<AgentRunLedgerEvent, "kind">): AgentRunLedgerEvent {
  return { ordinal: 1, createdAtMs: T, ...extra };
}

function run(id: string, extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  return {
    id,
    channelId: CH,
    agentMemberId: AGENT,
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

describe("원장 → 기록 줄 (ADR-0200 D2)", () => {
  it("11분 뒤 수령되고 승인을 기다리다 만료된 run이 줄로 남는다", () => {
    const rows = ledgerRows([
      ev({ kind: "queued", createdAtMs: T }),
      ev({ kind: "claimed", createdAtMs: T + 11 * MIN }),
      ev({ kind: "started", createdAtMs: T + 11 * MIN + 5_000 }),
      ev({ kind: "stage", stage: "채널 이름 확인", createdAtMs: T + 12 * MIN }),
      ev({ kind: "approval_requested", approvalId: "AP1", createdAtMs: T + 13 * MIN }),
      ev({ kind: "approval_decided", code: "expired", approvalId: "AP1", createdAtMs: T + 73 * MIN }),
      ev({ kind: "timed_out", code: "approval_expired", createdAtMs: T + 73 * MIN }),
    ]);
    expect(rows.map((r) => r.text)).toEqual([
      "요청이 들어왔어요",
      "에이전트가 일을 가져갔어요",
      "작업을 시작했어요",
      "채널 이름 확인",
      "승인을 요청했어요",
      "승인이 만료됐어요",
      "시간이 초과됐어요",
    ]);
    expect(rows[6]?.reason).toBe("승인을 기다리다 만료됐어요");
    expect(rows[4]?.approvalId).toBe("AP1");
  });

  it("서버가 준 순서를 믿지 않고 시각으로 정렬하되 같은 시각은 받은 순서를 지킨다", () => {
    const rows = ledgerRows([
      ev({ kind: "stage", stage: "나중", createdAtMs: T + 2 }),
      ev({ kind: "stage", stage: "먼저 A", createdAtMs: T }),
      ev({ kind: "stage", stage: "먼저 B", createdAtMs: T }),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["먼저 A", "먼저 B", "나중"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("에이전트가 쓴 단계는 일반 텍스트이고 길면 자른다", () => {
    const [row] = ledgerRows([
      ev({ kind: "stage", stage: `<img src=x onerror=alert(1)> ${"가".repeat(200)}` }),
    ]);
    expect(row?.text.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(row?.text.length).toBeLessThanOrEqual(81);
    const [empty] = ledgerRows([ev({ kind: "stage" })]);
    expect(empty?.text).toBe("단계를 보고했어요");
  });

  it("모르는 종료 코드는 사유 문장을 만들어 내지 않는다", () => {
    const [row] = ledgerRows([ev({ kind: "failed", code: "never_seen_before" })]);
    expect(row).toMatchObject({ text: "실패했어요", tone: "end" });
    expect(row?.reason).toBeUndefined();
  });

  it("승인 결정의 닫힌 코드마다 한 문장", () => {
    const text = (code: string) =>
      ledgerRows([ev({ kind: "approval_decided", code })])[0]?.text;
    expect(text("approved")).toBe("승인됐어요");
    expect(text("rejected")).toBe("거절됐어요");
    expect(text("cancelled")).toBe("승인 요청이 취소됐어요");
    expect(text("something_new")).toBe("승인 결정이 기록됐어요");
  });

  it("시각은 HH:MM, 오늘이 아니면 날짜가 붙는다", () => {
    const at = new Date(2026, 9, 13, 9, 5).getTime();
    expect(clockLabel(at)).toBe("09:05");
    expect(clockLabel(at, new Date(2026, 9, 13, 23, 0).getTime())).toBe("09:05");
    expect(clockLabel(at, new Date(2026, 9, 14, 9, 6).getTime())).toBe("10/13 09:05");
  });
});

describe("여러 run: 진행 중은 병렬, 대기열은 순서, 끝난 일은 최근 순", () => {
  it("구역과 순서", () => {
    const entries = runList(
      [
        run("done-old", { phase: "succeeded", status: "succeeded", finishedAtMs: T - 5 * MIN }),
        run("q2", { queuePosition: 2, createdAtMs: T + 2 }),
        run("run-b", { phase: "running", status: "running", startedAtMs: T + MIN }),
        run("q1", { queuePosition: 1, createdAtMs: T + 3 }),
        run("run-a", { phase: "awaiting_approval", status: "awaiting_approval", startedAtMs: T }),
        run("claimed", { phase: "claimed", claimedAtMs: T + 2 * MIN }),
        run("done-new", { phase: "failed", status: "failed", finishedAtMs: T }),
        run("other-agent", { agentMemberId: OTHER_AGENT, queuePosition: 1 }),
      ],
      AGENT.toUpperCase()
    );
    expect(entries.map((e) => `${e.section}:${e.runId}`)).toEqual([
      "active:run-a",
      "active:run-b",
      "active:claimed",
      "queue:q1",
      "queue:q2",
      "done:done-new",
      "done:done-old",
    ]);
  });

  it("끝난 일은 최근 몇 건만", () => {
    const rows = Array.from({ length: RUN_LIST_DONE_LIMIT + 4 }, (_, i) =>
      run(`d${i}`, { phase: "succeeded", status: "succeeded", finishedAtMs: T + i })
    );
    expect(runList(rows, AGENT)).toHaveLength(RUN_LIST_DONE_LIMIT);
  });
});

describe("대기열 앞의 일 (ADR-0200 D3)", () => {
  it("내가 멤버인 채널의 일은 이름이 있고, 나머지는 건수만이다", () => {
    const ahead = queueAhead({
      aheadTotal: 5,
      ahead: [
        { runId: "r1", channelId: CH },
        { runId: "r2", channelId: CH },
      ],
    });
    expect(ahead.visible).toHaveLength(2);
    expect(ahead.hiddenCount).toBe(3);
  });

  it("합계를 모르는 서버는 숨은 건수를 지어내지 않는다", () => {
    expect(queueAhead({ ahead: [] })).toEqual({ visible: [], hiddenCount: 0 });
    expect(
      queueAhead({ aheadTotal: 1, ahead: [{ runId: "r1", channelId: CH }] }).hiddenCount
    ).toBe(0);
  });
});

describe("빈 기록 안내는 수령 전과 후가 다르다", () => {
  it("가져가지 않은 run, 가져간 run, 끝난 run, 아직 못 읽음", () => {
    expect(runEmptyState({ phase: "queued" }).headline).toBe("아직 아무도 일을 가져가지 않았어요.");
    expect(runEmptyState({ phase: "claimed" }).headline).toBe("가져갔지만 아직 보고가 없어요.");
    expect(runEmptyState({ phase: "running" }).headline).toBe("가져갔지만 아직 보고가 없어요.");
    expect(runEmptyState({ phase: "succeeded" }).headline).toBe("남은 기록이 없어요.");
    expect(runEmptyState(null).headline).toBe("아직 받은 기록이 없어요.");
  });
});

describe("문장: 해요체이고, 서버 기록에 거짓을 붙이지 않는다", () => {
  const sentences = (mod: Record<string, unknown>) =>
    Object.entries(mod).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    );

  it("패널 문장 상수에 「…합니다」 체가 남지 않는다", () => {
    for (const mod of [workLog, runLedger, turnCopy] as Record<string, unknown>[]) {
      for (const [name, text] of sentences(mod)) {
        // 접근성 이름용 3인칭 서술(`verbFor`)은 함수 안에 있고 상수가 아니다.
        expect({ name, text }).not.toMatchObject({ text: expect.stringMatching(/(습니다|합니다|됩니다)[.]?$/) });
      }
    }
  });

  it("「패널을 닫으면 이 기록은 사라집니다」는 어디에도 없다", () => {
    for (const mod of [workLog, runLedger] as Record<string, unknown>[]) {
      for (const [, text] of sentences(mod)) {
        expect(text).not.toContain("이 기록은 사라집니다");
      }
    }
    expect(RUN_LEDGER_KEPT_SENTENCE).toContain("패널을 닫아도");
  });

  it("한계는 한 문장이다", () => {
    expect(RUN_LEDGER_LIMIT_SENTENCE.split(/(?<=[.])\s/)).toHaveLength(2);
    expect(RUN_LEDGER_LIMIT_SENTENCE).toContain("에이전트가 보낸 만큼만");
    expect(RUN_LEDGER_LIMIT_SENTENCE).not.toContain("실시간");
  });
});
