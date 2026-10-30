import { describe, expect, it } from "vitest";
import type { AgentRunProgress, Message } from "../../lib/api";
import { UNCOLLECTED_AFTER_MS, UNCOLLECTED_WORD } from "./runWaiting";
import type { AgentNameLookup, AgentNameParts } from "./turnCopy";
import {
  answerMessageFor,
  CHIP_WORD_ANSWERED,
  CHIP_WORD_FAILED,
  CHIP_WORD_UNCOLLECTED,
  indexAnswers,
  runAnswerMap,
  TRIGGER_CHIP_FACES,
  triggerChip,
} from "./triggerChip";

// =============================================================================
// 트리거 메시지 칩의 모델 (#4619 B): run들 → 칩 하나, 급한 순서, 「답함」의 목적지, 초 단위 없음.
// =============================================================================

const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";
const TRIGGER = "00000000-0000-7000-8000-0000000a0001";
const T = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const NAMES: Record<string, AgentNameParts> = {
  [A]: { name: "달무리봇" },
  [B]: { name: "모래시계봇" },
};
const nameFor: AgentNameLookup = (id) => NAMES[id] ?? { name: "" };

let counter = 0;
function run(extra: Partial<AgentRunProgress> = {}): AgentRunProgress {
  counter += 1;
  return {
    id: `0199aa11-2222-7000-8000-${String(counter).padStart(12, "0")}`,
    channelId: "00000000-0000-7000-8000-000000000201",
    agentMemberId: A,
    triggerMessageId: TRIGGER,
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

const RUNNING = { phase: "running", status: "running", leaseState: "live", startedAtMs: T } as const;
const DONE = { phase: "succeeded", status: "succeeded", finishedAtMs: T + MIN } as const;
const FAILED = { phase: "failed", status: "failed", endReason: "agent_error", finishedAtMs: T + MIN } as const;

describe("run 하나 → 칩", () => {
  const NOW = T + 30 * SEC;
  const cases: {
    name: string;
    extra: Partial<AgentRunProgress>;
    now?: number;
    kind: string;
    word: string;
    mark: string;
    tone: string;
  }[] = [
    { name: "대기(유예 안)", extra: {}, kind: "received", word: "받음", mark: "none", tone: "muted" },
    { name: "가져감", extra: { phase: "claimed", leaseState: "live" }, kind: "claimed", word: "가져감", mark: "none", tone: "muted" },
    { name: "작업 중", extra: RUNNING, kind: "working", word: "작업 중", mark: "dot", tone: "working" },
    {
      name: "승인 필요",
      extra: { phase: "awaiting_approval", status: "awaiting_approval" },
      kind: "approval",
      word: "승인 필요",
      mark: "none",
      tone: "warn",
    },
    {
      name: "일시 정지",
      extra: { phase: "paused", status: "paused" },
      kind: "approval",
      word: "일시 정지",
      mark: "none",
      tone: "warn",
    },
    { name: "완료", extra: DONE, kind: "answered", word: CHIP_WORD_ANSWERED, mark: "check", tone: "ok" },
    { name: "실패", extra: FAILED, kind: "failed", word: CHIP_WORD_FAILED, mark: "cross", tone: "danger" },
    // 서버가 일을 끝내지 못한 것(시간 초과·신호 소실)은 오류가 아니다(ADR-0132): 경고 톤·느낌표이고 위험 톤·가위표가 아니다.
    {
      name: "소식 끊겨 끝남(신호 소실)",
      extra: { phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" },
      kind: "timed_out",
      word: "신호 소실",
      mark: "clock",
      tone: "warn",
    },
    {
      name: "승인을 기다리다 만료",
      extra: { phase: "timed_out", status: "timed_out", endReason: "approval_expired" },
      kind: "expired",
      word: "만료",
      mark: "clock",
      tone: "warn",
    },
    {
      name: "종료 사유 없는 시간 초과",
      extra: { phase: "timed_out", status: "timed_out" },
      kind: "timed_out",
      word: "시간 초과",
      mark: "clock",
      tone: "warn",
    },
    {
      name: "유예를 넘은 대기",
      extra: {},
      now: T + UNCOLLECTED_AFTER_MS,
      kind: "uncollected",
      word: CHIP_WORD_UNCOLLECTED,
      mark: "alert",
      tone: "warn",
    },
    {
      name: "아무도 가져가지 않아 끝남",
      extra: { phase: "timed_out", status: "timed_out", endReason: "unclaimed_expired" },
      kind: "uncollected",
      word: UNCOLLECTED_WORD,
      mark: "alert",
      tone: "warn",
    },
    {
      name: "깨웠지만 가져가지 않아 끝남",
      extra: { phase: "timed_out", status: "timed_out", endReason: "woken_not_collected" },
      kind: "uncollected",
      word: UNCOLLECTED_WORD,
      mark: "alert",
      tone: "warn",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const chip = triggerChip([run(c.extra)], nameFor, c.now ?? NOW);
      expect(chip).toMatchObject({ kind: c.kind, word: c.word, mark: c.mark, tone: c.tone });
    });
  }

  it("유예 경계 ±1ms: 마감 1ms 전은 「받음」, 마감부터 「아직 받지 않았어요」", () => {
    expect(triggerChip([run()], nameFor, T + UNCOLLECTED_AFTER_MS - 1)?.word).toBe("받음");
    expect(triggerChip([run()], nameFor, T + UNCOLLECTED_AFTER_MS)?.word).toBe(UNCOLLECTED_WORD);
    expect(triggerChip([run()], nameFor, T + UNCOLLECTED_AFTER_MS + 1)?.word).toBe(UNCOLLECTED_WORD);
  });

  it("루틴 박자를 알면 예상 확인 시각 전에는 「받음」으로 남는다", () => {
    const routineFor = () => ({ typicalMinutes: 15, expectedCheckAtMs: T + 14 * MIN });
    expect(triggerChip([run()], nameFor, T + 10 * MIN, { routineFor })?.word).toBe("받음");
    expect(triggerChip([run()], nameFor, T + 14 * MIN, { routineFor })?.word).toBe(UNCOLLECTED_WORD);
  });

  it("취소는 사람이 직접 한 일이라 칩이 없다", () => {
    expect(
      triggerChip(
        [run({ phase: "cancelled", status: "cancelled", endReason: "cancelled_by_member" })],
        nameFor,
        NOW
      )
    ).toBeNull();
    expect(triggerChip([], nameFor, NOW)).toBeNull();
  });
});

describe("한 메시지가 여러 에이전트를 불렀을 때: 가장 급한 하나", () => {
  const NOW = T + 30 * SEC;
  const pick = (runs: AgentRunProgress[], now = NOW) => triggerChip(runs, nameFor, now);

  it("실패 > 시간 초과 > 아직 받지 않았어요 > 승인 필요 > 작업 중 > 가져감 > 받음 > 답함", () => {
    expect(pick([run(DONE), run(FAILED)])?.kind).toBe("failed");
    expect(pick([run(FAILED), run({ agentMemberId: B })], T + 10 * MIN)?.kind).toBe("failed");
    // 시간 초과(가져간 뒤 서버가 끝냄)는 실패보다 약하고 아직 받지 않았어요보다 강하다.
    const TIMED = { phase: "timed_out", status: "timed_out", endReason: "lease_abandoned" } as const;
    expect(pick([run(TIMED), run({ ...FAILED, agentMemberId: B })])?.kind).toBe("failed");
    expect(pick([run(TIMED), run({ agentMemberId: B })], T + 10 * MIN)?.kind).toBe("timed_out");
    expect(pick([run(RUNNING), run({ agentMemberId: B })], T + 10 * MIN)?.kind).toBe("uncollected");
    expect(
      pick([run(RUNNING), run({ phase: "awaiting_approval", status: "awaiting_approval", agentMemberId: B })])?.kind
    ).toBe("approval");
    expect(pick([run(DONE), run(RUNNING)])?.kind).toBe("working");
    expect(pick([run({ phase: "claimed", leaseState: "live" }), run({ agentMemberId: B })])?.kind).toBe("claimed");
    expect(pick([run(), run(DONE)])?.kind).toBe("received");
  });

  it("하나라도 아직 일하는 중이면 「답함」이 아니다", () => {
    expect(pick([run(DONE), run({ ...RUNNING, agentMemberId: B })])?.word).toBe("작업 중");
    expect(pick([run(DONE), run({ ...DONE, agentMemberId: B })])?.word).toBe("답함");
  });

  it("취소된 run은 세지 않는다: 남은 것이 칩이 되고, 전부 취소면 칩이 없다", () => {
    const cancelled = (agentMemberId: string) =>
      run({ phase: "cancelled", status: "cancelled", agentMemberId });
    expect(pick([cancelled(A), run({ ...DONE, agentMemberId: B })])?.kind).toBe("answered");
    expect(pick([cancelled(A), cancelled(B)])).toBeNull();
  });

  it("보조기술 문장: 한 에이전트면 그 이름, 여럿이면 「이름 외 N명」", () => {
    expect(pick([run(RUNNING)])?.label).toBe("달무리봇 에이전트가 작업 중이에요.");
    expect(pick([run(RUNNING), run({ ...RUNNING, agentMemberId: B })])?.label).toBe(
      "달무리봇 외 1명 에이전트가 작업 중이에요."
    );
    expect(pick([run(DONE)])?.label).toBe("달무리봇 에이전트가 답했어요.");
    expect(pick([run(FAILED)])?.label).toBe("달무리봇 에이전트의 실행이 실패했어요.");
    expect(pick([run()], T + 10 * MIN)?.label).toBe("달무리봇 에이전트가 요청을 가져가지 않았어요.");
    expect(pick([run({ phase: "claimed", leaseState: "live" })])?.label).toBe(
      "달무리봇 에이전트가 일을 가져갔어요. 아직 보고는 없어요."
    );
  });
});

describe("「답함 ✓」의 목적지", () => {
  it("답 메시지를 알면 칩이 그 id와 seq를 들고, 모르면 들지 않는다(눌리지 않는 칩)", () => {
    const done = run(DONE);
    const known = triggerChip([done], nameFor, T + HOUR, {
      answerFor: () => ({ id: "answer-1", seq: 42 }),
    });
    expect(known).toMatchObject({ kind: "answered", answer: { id: "answer-1", seq: 42 } });
    const unknown = triggerChip([done], nameFor, T + HOUR, { answerFor: () => undefined });
    expect(unknown?.kind).toBe("answered");
    expect(unknown?.answer).toBeUndefined();
    expect(triggerChip([done], nameFor, T + HOUR)?.answer).toBeUndefined();
  });

  it("「답함」이 아닌 칩은 답을 들지 않는다", () => {
    const chip = triggerChip([run(DONE), run(RUNNING)], nameFor, T + HOUR, {
      answerFor: () => ({ id: "answer-1", seq: 42 }),
    });
    expect(chip?.kind).toBe("working");
    expect(chip?.answer).toBeUndefined();
  });

  it("여러 에이전트가 답했으면 답을 아는 첫 run의 답을 쓴다", () => {
    const first = run({ ...DONE, agentMemberId: A });
    const second = run({ ...DONE, agentMemberId: B });
    const chip = triggerChip([first, second], nameFor, T + HOUR, {
      answerFor: (r) => (r.id === second.id ? { id: "answer-b", seq: 7 } : undefined),
    });
    expect(chip?.answer).toEqual({ id: "answer-b", seq: 7 });
  });
});

describe("칩이 입을 수 있는 낱말 전부(폭을 고정하는 표면이 읽는다)", () => {
  it("모든 칩 상태의 낱말·표지가 목록에 있다", () => {
    const states: Partial<AgentRunProgress>[] = [
      {},
      { phase: "claimed", leaseState: "live" },
      RUNNING,
      { phase: "awaiting_approval", status: "awaiting_approval" },
      { phase: "paused", status: "paused" },
      DONE,
      FAILED,
    ];
    const faces = TRIGGER_CHIP_FACES.map((f) => `${f.word}|${f.mark}`);
    for (const extra of states) {
      const chip = triggerChip([run(extra)], nameFor, T + 30 * SEC);
      expect(faces, JSON.stringify(extra)).toContain(`${chip!.word}|${chip!.mark}`);
    }
    // 「아직 받지 않았어요」도 같은 목록에 있다.
    const stuck = triggerChip([run()], nameFor, T + 10 * MIN);
    expect(faces).toContain(`${stuck!.word}|${stuck!.mark}`);
    expect(new Set(faces).size).toBe(faces.length);
  });
});

describe("초 단위 숫자가 없다", () => {
  it("어떤 상태·경과에서도 칩의 낱말과 문장에 「n초」가 없다", () => {
    const rows: Partial<AgentRunProgress>[] = [
      {},
      { phase: "claimed", leaseState: "live", claimedAtMs: T },
      RUNNING,
      DONE,
      FAILED,
      { phase: "awaiting_approval", status: "awaiting_approval" },
    ];
    let seen = 0;
    for (const extra of rows) {
      for (const dt of [0, 5 * SEC, 59 * SEC, 61 * SEC, 125 * SEC, 3601 * SEC, 17 * HOUR]) {
        const chip = triggerChip([run(extra)], nameFor, T + dt);
        if (chip === null) continue;
        seen += 1;
        expect(`${chip.word} ${chip.label}`, `${JSON.stringify(extra)} +${dt}ms`).not.toMatch(
          /\d+\s*초/
        );
      }
    }
    expect(seen).toBeGreaterThanOrEqual(30);
  });
});

describe("답 메시지 색인", () => {
  function message(extra: Partial<Message> & { id: string }): Message {
    return {
      channelId: "00000000-0000-7000-8000-000000000201",
      seq: 1,
      hlcTs: 1,
      hlcCount: 0,
      authorMemberId: A,
      type: "text",
      body: "답이에요",
      createdAtMs: T,
      ...extra,
    };
  }
  const RUN_ID = "0199aa11-2222-7000-8000-0000000000f1";
  const target = { id: RUN_ID, agentMemberId: A, triggerMessageId: TRIGGER } as const;

  it("정산된 턴 기록(props.run_id)은 run id가 정확히 맞는다", () => {
    const index = indexAnswers([
      message({
        id: "turn-record",
        props: { schema: "momo.agent_gateway.timeline.v0", run_id: RUN_ID.toUpperCase() },
      }),
    ]);
    expect(answerMessageFor(index, target)?.id).toBe("turn-record");
  });

  it("에이전트가 트리거를 인용해 쓴 첫 글(replyToId)을 답으로 본다", () => {
    const index = indexAnswers([
      message({ id: "first", seq: 2, replyToId: TRIGGER }),
      message({ id: "second", seq: 3, replyToId: TRIGGER }),
    ]);
    expect(answerMessageFor(index, target)?.id).toBe("first");
  });

  it("다른 에이전트의 인용·삭제된 글·글이 아닌 행·인용 없는 글은 답이 아니다", () => {
    const index = indexAnswers([
      message({ id: "other-agent", authorMemberId: B, replyToId: TRIGGER }),
      message({ id: "deleted", replyToId: TRIGGER, state: "deleted" }),
      message({ id: "tool", type: "tool_call", replyToId: TRIGGER }),
      message({ id: "no-quote" }),
      message({ id: "other-trigger", replyToId: "00000000-0000-7000-8000-0000000a0002" }),
    ]);
    expect(answerMessageFor(index, target)).toBeUndefined();
  });

  it("승인 만료·멈춤 알림은 답이 아니다: props.answers_message_id로 가리켜도 찾지 않는다", () => {
    const index = indexAnswers([
      message({ id: "notice", props: { answers_message_id: TRIGGER } }),
    ]);
    expect(answerMessageFor(index, target)).toBeUndefined();
  });

  it("정확한 턴 기록이 인용보다 앞선다", () => {
    const index = indexAnswers([
      message({ id: "quote", seq: 2, replyToId: TRIGGER }),
      message({
        id: "record",
        seq: 3,
        props: { schema: "momo.agent_gateway.timeline.v0", run_id: RUN_ID },
      }),
    ]);
    expect(answerMessageFor(index, target)?.id).toBe("record");
  });

  it("트리거가 없는 run(환영·작업)은 인용으로 찾을 수 없다", () => {
    const index = indexAnswers([message({ id: "quote", replyToId: TRIGGER })]);
    expect(
      answerMessageFor(index, { id: RUN_ID, agentMemberId: A })
    ).toBeUndefined();
  });
});

describe("목록이 넘기는 답 지도", () => {
  const RUN_OK = "0199aa11-2222-7000-8000-0000000000e1";
  const RUN_OPEN = "0199aa11-2222-7000-8000-0000000000e2";
  const RUN_LOST = "0199aa11-2222-7000-8000-0000000000e3";
  const quote = (id: string, seq: number, extra: Partial<Message> = {}): Message => ({
    id,
    channelId: "00000000-0000-7000-8000-000000000201",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: A,
    type: "text",
    body: "답이에요",
    createdAtMs: T,
    replyToId: TRIGGER,
    ...extra,
  });

  it("끝난(succeeded) run 중 답을 이을 수 있는 것만 지도에 있고 키는 소문자 run id다", () => {
    const messages = [quote("answer-1", 7)];
    const map = runAnswerMap(
      [
        { id: RUN_OK.toUpperCase(), phase: "succeeded", agentMemberId: A, triggerMessageId: TRIGGER },
        // 아직 열린 run: 답이 이미 와 있어도(진행 중 보고 글) 「답함」이 아니다.
        { id: RUN_OPEN, phase: "running", agentMemberId: A, triggerMessageId: TRIGGER },
        // 끝났지만 이을 길이 없는 run(다른 트리거).
        { id: RUN_LOST, phase: "succeeded", agentMemberId: A, triggerMessageId: "00000000-0000-7000-8000-0000000a0099" },
      ],
      messages
    );
    expect([...map.keys()]).toEqual([RUN_OK]);
    expect(map.get(RUN_OK)).toEqual({ id: "answer-1", seq: 7 });
  });
});

describe("요청 묶음 칩", () => {
  it("실패 > 만료 > 거부 > 시간 초과 순으로 고르고 직접 취소는 세지 않는다", () => {
    const cases = [
      { ...run(FAILED), expected: "failed" },
      {
        ...run({
          phase: "timed_out",
          status: "timed_out",
          endReason: "approval_expired",
        }),
        expected: "expired",
      },
      {
        ...run({
          phase: "cancelled",
          status: "cancelled",
          endReason: "approval_rejected",
        }),
        expected: "declined",
      },
      {
        ...run({ phase: "timed_out", status: "timed_out" }),
        expected: "timed_out",
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const remaining = cases.slice(i).reverse();
      expect(triggerChip(remaining, nameFor, T)?.kind).toBe(cases[i]!.expected);
    }
    expect(
      triggerChip(
        [
          run({
            phase: "cancelled",
            status: "cancelled",
            endReason: "human_cancelled",
          }),
        ],
        nameFor,
        T
      )
    ).toBeNull();
  });

  it("묶음의 끝과 말로 답함을 구분하고 생각·실행은 상위 낱말 작업 중으로 읽는다", () => {
    const done = run(DONE);
    expect(triggerChip([done], nameFor, T)?.word).toBe("답함");
    expect(
      triggerChip(
        [
          {
            ...done,
            bundle: { status: "approved", result: { status: "succeeded" } },
          },
        ],
        nameFor,
        T
      )?.word
    ).toBe("끝");
    const bundled = { ...done, bundle: { status: "approved", result: { status: "succeeded" } } };
    const destination = { id: "approval-card", seq: 12 };
    const textAnswer = { id: "text-answer", seq: 13 };
    const routed = triggerChip([bundled], nameFor, T, { answerFor: () => textAnswer, bundleTargetFor: () => destination });
    expect(routed?.answer).toEqual(destination);
    expect(routed?.bundleTarget).toEqual(destination);
    expect(triggerChip([bundled], nameFor, T, { answerFor: () => textAnswer })?.answer).toBeUndefined();
    for (const status of [undefined, "approved"]) {
      expect(
        triggerChip(
          [
            {
              ...run(RUNNING),
              bundle: { status, action_type: "tool_call", code: "running" },
            },
          ],
          nameFor,
          T
        )
      ).toMatchObject({ kind: "working", word: "작업 중" });
    }
    expect(
      triggerChip([run(RUNNING)], nameFor, T, {
        bundleFor: () => ({ status: "expired" }),
      })
    ).toMatchObject({ kind: "expired", word: "만료", tone: "warn" });
    expect(
      triggerChip(
        [{ ...run(RUNNING), bundle: { status: "pending" } }],
        nameFor,
        T
      )
    ).toMatchObject({ kind: "approval", word: "승인 필요" });
    for (const bundle of [{}, { status: "pending" }]) {
      expect(
        triggerChip(
          [
            {
              ...run({
                phase: "timed_out",
                status: "timed_out",
                endReason: "lease_abandoned",
              }),
              bundle,
            },
          ],
          nameFor,
          T
        )
      ).toMatchObject({ kind: "timed_out", word: "신호 소실" });
    }
  });

  it("고정 폭 측정 얼굴에 끝·답함·거부·만료가 모두 있고 거부는 실패와 다른 모양이다", () => {
    for (const word of ["끝", "답함", "거부", "만료", "승인 필요"])
      expect(TRIGGER_CHIP_FACES.some((face) => face.word === word)).toBe(true);
    const declined = triggerChip(
      [
        run({
          phase: "cancelled",
          status: "cancelled",
          endReason: "approval_rejected",
        }),
      ],
      nameFor,
      T
    )!;
    const failed = triggerChip([run(FAILED)], nameFor, T)!;
    expect(declined.tone).toBe("muted");
    expect(declined.mark).not.toBe(failed.mark);
  });
});
