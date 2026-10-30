import type { Approval, Message } from "../../lib/api";
import { agentRequestBundle } from "../timeline/agentCardModel";
import { approvalItem } from "../inbox/model";
import { runPhaseLabel } from "./runPhase";
import { describe, expect, it } from "vitest";
import type { AgentRunPhase, AgentRunProgress } from "../../lib/api";
import { activityRail } from "./activityRail";
import { runException, UNCLAIMED_END_REASONS } from "./runException";
import { serverFactsOf, signalFromProgress } from "./runPhase";
import { RUN_STATUS_WOKEN_FAILED } from "./runStatusLine";
import {
  isUncollected,
  queuedWaitCopy,
  runStateWord,
  UNCOLLECTED_AFTER_MS,
  UNCOLLECTED_WORD,
  type RoutineHint,
} from "./runWaiting";
import { CHIP_WORD_UNCOLLECTED, triggerChip } from "./triggerChip";

// =============================================================================
// 같은 run을 부르는 표면들의 판정과 낱말 (#4619 planner 결정 1: 유예 하나로·낱말 하나로).
//
// 한 run은 한 화면에 여러 자리에서 동시에 말해진다:
//   홈 카드·작업 패널   `queuedWaitCopy` / `runStateWord`   (#4285, 폰도 같은 함수)
//   대화 아래 예외 줄   `runException`
//   메시지 머리의 칩    `triggerChip`
//   입력창 레일         `activityRail`  (유예를 넘은 run을 레일에서 뺀다)
// 각 모듈의 단위 시험은 서로를 보지 않아서 한쪽 판정·낱말만 바뀌어도 모두 초록이다(이 시험이 생기기 전에
// 실제로 그랬다: 줄·칩은 2분·「못 가져감」, 카드는 5분·「아직 받지 않았어요」). 여기서는 **같은 run 하나를 같은
// 시각에** 네 자리에 넣어 판정과 낱말을 함께 붙든다. 시각·박자(없음/늦음/빠름)·phase·종료 코드를 전수로 돈다.
//
// 규칙:
//   1. 예외 줄이 「아직 받지 않았어요」이면 칩도 같은 낱말이다(열려 있든 서버가 그래서 끝냈든).
//   2. 칩이 「아직 받지 않았어요」이면 예외 줄이 있다(줄 없이 칩만 서면 행동이 갈 곳이 없다).
//   3. 예외 줄이 「실패」이면 칩도 같은 낱말이다.
//   4. 열린 대기 run은 같은 시각에 카드·줄·칩이 **같은 판정**을 내리고 **같은 낱말**을 쓴다.
//   5. 같은 시각에 레일은 그 run을 정확히 그때 뺀다(줄·칩이 이어받는다).
//   6. 깨우는 신호가 닿지 않은 줄의 칩은 아직 진행 낱말이다(경보 낱말이 아니다).
//   7. 예외 줄이 시간 초과·신호 소실이면 칩도 같은 낱말·경고 톤이다(서버가 일을 끝내지 못한 것은 오류가 아니다, ADR-0132).
//      1단계는 칩만 「실패」(위험 톤)로 말해 같은 행의 줄(경고 톤)과 모순이었다 — design-review r1 H2.
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
// 기본 유예 경계, 두 박자(늦음 14분·빠름 90초) 경계 앞뒤를 모두 지나도록 잡는다.
const OFFSETS = [
  0,
  10 * SEC,
  90 * SEC - 1,
  90 * SEC,
  2 * MIN,
  UNCOLLECTED_AFTER_MS - 1,
  UNCOLLECTED_AFTER_MS,
  14 * MIN - 1,
  14 * MIN,
  HOUR,
  17 * HOUR,
];
const LATE: RoutineHint = { typicalMinutes: 15, expectedCheckAtMs: T + 14 * MIN };
const SOON: RoutineHint = { typicalMinutes: 1, expectedCheckAtMs: T + 90 * SEC };
const ROUTINES: (RoutineHint | undefined)[] = [undefined, LATE, SOON];

describe("카드·줄·칩·레일이 같은 run을 같은 판정·같은 낱말로 부른다", () => {
  interface Row {
    where: string;
    run: AgentRunProgress;
    now: number;
    routine: RoutineHint | undefined;
    exception: ReturnType<typeof runException>;
    chip: ReturnType<typeof triggerChip>;
  }
  const rows: Row[] = [];
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
            where: `${phase}/${endReason ?? "-"}/+${dt}ms/${
              routine === undefined ? "no-routine" : routine === LATE ? "late" : "soon"
            }`,
            run: r,
            now,
            routine,
            exception: runException(r, now, routine === undefined ? {} : { routine }),
            chip: triggerChip([r], nameFor, now, {
              ...(routine === undefined ? {} : { routineFor: () => routine }),
            }),
          });
        }
      }
    }
  }

  it("전수 반복이 비어 있지 않다(예외 줄이 선 경우·아직 받지 않았어요 칩이 선 경우가 모두 많다)", () => {
    expect(rows.length).toBe(PHASES.length * END_REASONS.length * OFFSETS.length * ROUTINES.length);
    expect(rows.filter((r) => r.exception?.kind === "uncollected").length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.exception?.kind === "failed").length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.chip?.kind === "uncollected").length).toBeGreaterThan(20);
  });

  it("1. 예외 줄이 「아직 받지 않았어요」이면 칩도 같은 낱말이다", () => {
    for (const { where, exception, chip } of rows) {
      if (exception?.kind !== "uncollected") continue;
      expect(chip, where).not.toBeNull();
      expect(chip!.kind, where).toBe("uncollected");
      expect(chip!.word, where).toBe(exception.headline);
      expect(chip!.word, where).toBe(UNCOLLECTED_WORD);
    }
  });

  it("2. 칩이 「아직 받지 않았어요」이면 예외 줄이 있다 — 줄 없이 칩만 서지 않는다", () => {
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

  it("4. 열린 대기 run은 같은 시각에 카드·줄·칩이 같은 판정을 내리고 같은 낱말을 쓴다(박자 없음·늦음·빠름 모두)", () => {
    let checked = 0;
    let uncollected = 0;
    for (const { where, run: r, now, routine, exception, chip } of rows) {
      if (r.phase !== "queued") continue;
      const facts = serverFactsOf(r);
      const card = queuedWaitCopy({ facts, nowMs: now, ...(routine !== undefined ? { routine } : {}) });
      expect(card, where).not.toBeNull();
      checked += 1;
      // 판정: 카드가 「받지 않았어요」이면 줄도 칩도 그렇다(그 반대도).
      const cardSays = card!.uncollected;
      expect(isUncollected(facts, now, routine), where).toBe(cardSays);
      expect(exception?.kind === "uncollected", where).toBe(cardSays);
      expect(chip?.kind === "uncollected", where).toBe(cardSays);
      if (cardSays) {
        uncollected += 1;
        // 낱말: 셋이 글자까지 같다.
        expect(card!.word, where).toBe(UNCOLLECTED_WORD);
        expect(exception!.headline, where).toBe(card!.word);
        expect(chip!.word, where).toBe(card!.word);
        expect(runStateWord(facts, now, routine), where).toBe(card!.word);
      } else {
        // 유예 안에서는 카드가 서버의 낱말(「대기 n번째」 따위) 그대로이고 줄은 없으며 칩은 진행 낱말이다.
        expect(card!.word, where).not.toBe(UNCOLLECTED_WORD);
        expect(exception, where).toBeNull();
        expect(chip!.word, where).not.toBe(UNCOLLECTED_WORD);
      }
    }
    expect(checked).toBe(OFFSETS.length * ROUTINES.length * END_REASONS.length);
    expect(uncollected).toBeGreaterThan(20);
  });

  it("5. 레일은 그 run을 정확히 「아직 받지 않았어요」가 되는 시각에 뺀다", () => {
    let dropped = 0;
    let kept = 0;
    for (const { where, run: r, now, routine } of rows) {
      if (r.phase !== "queued" || r.endReason !== undefined) continue;
      const signal = signalFromProgress(r);
      expect(signal, where).not.toBeNull();
      const rail = activityRail([signal!], nameFor, now, {
        ...(routine !== undefined ? { routineFor: () => routine } : {}),
      });
      const uncollected = isUncollected(serverFactsOf(r), now, routine);
      expect(rail === null, where).toBe(uncollected);
      if (uncollected) dropped += 1;
      else kept += 1;
    }
    expect(dropped).toBeGreaterThan(5);
    expect(kept).toBeGreaterThan(5);
  });

  it("6. 깨우는 신호가 닿지 않은 줄의 칩은 아직 진행 낱말이다 — 경보 낱말은 유예를 넘고서야 선다", () => {
    const r = run({});
    const doorbell = { lastAtMs: T + SEC, failed: true, count: 2 } as const;
    const early = T + MIN;
    const line = runException(r, early, { doorbell });
    expect(line).toMatchObject({ kind: "wake_failed", headline: RUN_STATUS_WOKEN_FAILED });
    const chip = triggerChip([r], nameFor, early);
    expect(chip?.kind).toBe("received");
    expect(chip?.word).not.toBe(UNCOLLECTED_WORD);
    // 유예를 넘으면 줄도 칩도 같은 「아직 받지 않았어요」가 되고, 신호 실패는 줄의 이유로 남는다.
    const late = T + UNCOLLECTED_AFTER_MS;
    expect(runException(r, late, { doorbell })).toMatchObject({
      kind: "uncollected",
      headline: UNCOLLECTED_WORD,
    });
    expect(triggerChip([r], nameFor, late)?.word).toBe(UNCOLLECTED_WORD);
  });

  it("서버가 아무도 가져가지 않아 끝낸 두 코드는 열린 「아직 받지 않았어요」와 칩·줄 모두 같은 낱말이다", () => {
    for (const endReason of UNCLAIMED_END_REASONS) {
      const r = run({ phase: "timed_out", status: "timed_out", endReason });
      const exception = runException(r, T + HOUR);
      const chip = triggerChip([r], nameFor, T + HOUR);
      expect(exception?.headline, endReason).toBe(UNCOLLECTED_WORD);
      expect(chip?.word, endReason).toBe(UNCOLLECTED_WORD);
    }
  });

  it("7. 가져간 뒤의 시간 초과·신호 소실: 칩도 줄과 같은 낱말이고 경고 톤이다(위험 톤은 서버가 failed로 끝낸 것에만)", () => {
    const lost = run({ phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" });
    expect(triggerChip([lost], nameFor, T + HOUR)).toMatchObject({ kind: "timed_out", word: "신호 소실", tone: "warn", mark: "clock" });
    expect(runException(lost, T + HOUR)?.headline).toBe("신호 소실");
    const plain = run({ phase: "timed_out", status: "timed_out" });
    expect(triggerChip([plain], nameFor, T + HOUR)).toMatchObject({ kind: "timed_out", word: "시간 초과", tone: "warn", mark: "clock" });
    expect(runException(plain, T + HOUR)?.headline).toBe("시간 초과");
    // 전수: 줄이 timed_out이면 칩도 같은 낱말·같은 톤 계열(경고)이다. 위험 톤(danger)은 줄이 failed일 때뿐이다.
    let seen = 0;
    for (const { where, exception, chip } of rows) {
      if (exception?.kind === "timed_out") {
        seen += 1;
        expect(chip, where).not.toBeNull();
        expect(chip!.kind, where).toBe("timed_out");
        expect(chip!.word, where).toBe(exception.headline);
        expect(chip!.tone, where).toBe("warn");
      }
      if (chip?.tone === "danger") expect(exception?.kind, where).toBe("failed");
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("줄도 칩도 없는 상태: 취소는 둘 다 없다. 줄 없이 칩만 있는 상태는 진행 중·답함·승인 필요뿐이다", () => {
    for (const { where, exception, chip } of rows) {
      if (exception !== null) continue;
      if (chip === null) continue;
      expect(
        ["received", "claimed", "working", "approval", "answered", "declined", "expired"],
        where
      ).toContain(chip.kind);
    }
    const cancelled = run({ phase: "cancelled", status: "cancelled" });
    expect(runException(cancelled, T + HOUR)).toBeNull();
    expect(triggerChip([cancelled], nameFor, T + HOUR)).toBeNull();
  });
});

it("승인 종결은 카드·칩·인박스·문장이 같은 낱말이고 예외 줄은 없다", () => {
  for (const [status, phase, endReason, word, sentence] of [
    ["rejected", "cancelled", "approval_rejected", "거부", "거부됐어요"],
    [
      "expired",
      "timed_out",
      "approval_expired",
      "만료",
      "승인을 기다리다 만료됐어요",
    ],
  ] as const) {
    const r = run({ phase, status: phase, endReason });
    const message: Message = {
      id: "card",
      channelId: r.channelId,
      authorMemberId: AGENT,
      type: "approval_request",
      seq: 1,
      hlcTs: T,
      hlcCount: 0,
      createdAtMs: T,
      props: { approval_id: "approval", status, action_type: "tool_call" },
    };
    const card = agentRequestBundle(message, { nowMs: T })!;
    const chip = triggerChip([r], nameFor, T)!;
    const approval: Approval = {
      id: "approval",
      workspaceId: "workspace",
      runId: r.id,
      channelId: r.channelId,
      requestedBy: AGENT,
      actionType: "tool_call",
      status,
    };
    const row = approvalItem(
      approval,
      { name: "달무리봇", isAgent: true },
      "실험실",
      T
    );
    expect([
      card.word,
      chip.word,
      row.outcome,
      runPhaseLabel(serverFactsOf(r)),
    ]).toEqual([word, word, word, word]);
    expect(card.sentence).toBe(sentence);
    expect(runException(r, T)).toBeNull();
    // 끝 코드가 아직 run에 없더라도 같은 bundle을 받으면 예외 줄은 서지 않아요.
    const stale = {
      ...run({ phase: "failed", status: "failed" }),
      bundle: { status },
    };
    expect(runException(stale, T)).toBeNull();
    expect(triggerChip([stale], nameFor, T)?.word).toBe(word);
  }
});
