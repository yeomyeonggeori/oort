import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import { agentCardModel, cardKeepsBody } from "./agentCardModel";
import { rowPresentation } from "./rowModel";
import {
  COMPLETION_CHECK_OUTCOME_LABEL,
  COMPLETION_CHECK_TONE,
  COMPLETION_OUTCOME_LABEL,
  COMPLETION_OUTCOME_TONE,
  COMPLETION_REPORT_KIND,
  COMPLETION_REPORT_TITLE,
  completionCheckCounts,
  completionOutcome,
  completionReportCard,
  formatElapsed,
  parseCompletionActions,
  parseCompletionCheckOutcome,
  parseCompletionGates,
  type CompletionCheckOutcome,
  type CompletionReportCard,
} from "./completionReportCard";

// A realistic report the worker would emit at the end of a long setup turn —
// the oort repo build the cursor benchmark measured, in our dialect. It is the
// producer↔consumer pin: the exact props envelope an agent emits must parse
// into a card without any client re-deriving the shape.
const REPORT_PROPS = {
  kind: COMPLETION_REPORT_KIND,
  title: "yeomyeonggeori/oort 환경 셋업 완료",
  summary:
    "oort 모노레포입니다. Rust 서버·TS 코어·웹/폰 클라이언트가 한 트리에 있고, 게이트를 전부 초록으로 맞췄습니다.",
  elapsed_ms: 1_468_000,
  actions: [
    {
      text: "Rust 툴체인을 1.83에서 1.97로 올림",
      note: "워크스페이스가 edition2024를 요구해 고정된 1.83으로는 빌드되지 않았습니다.",
    },
    { text: "compose 스택 기동 후 헬스체크 확인" },
  ],
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass", detail: "896 통과" },
        { label: "린트", outcome: "pass", detail: "경고 0" },
      ],
    },
    {
      surface: "엔진",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "테스트", outcome: "pass", detail: "clippy 경고 0" },
      ],
    },
    {
      surface: "compose",
      checks: [{ label: "실행", outcome: "pass", detail: "healthy" }],
    },
  ],
  // opaque keys the worker also ships — these must never render and must be
  // counted, not shown (the redaction contract, same as every other card).
  run_id: "0199aa11-2222-7000-8000-0000000000b2",
  channel_id: "00000000-0000-7000-8000-000000000201",
  arguments: JSON.stringify({ repo: "yeomyeonggeori/oort" }),
  tool_grant: "grant-opaque",
};

function message(props: Record<string, unknown> = REPORT_PROPS): Message {
  return {
    id: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5b",
    channelId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5c",
    seq: 42,
    hlcTs: 1_760_000_000_000,
    hlcCount: 0,
    authorMemberId: "0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5d",
    // 평범한 에이전트 턴 메시지다 — 새 메시지 타입이 아니다.
    type: "text",
    body: "환경 셋업을 마쳤습니다.",
    createdAtMs: 1_760_000_000_000,
    props,
  };
}

describe("completionReportCard — the kind gate", () => {
  it("only fires on props.kind = completion_report", () => {
    expect(completionReportCard({ summary: "요약만 있음" })).toBeNull();
    expect(completionReportCard({ kind: "resume_offer" })).toBeNull();
    expect(completionReportCard(undefined)).toBeNull();
  });

  it("a kind marker with no content is not a card (falls through to the turn)", () => {
    // `kind` 만 실린 봉투는 리포트가 아니다. 평범한 턴이 처리하도록 null.
    expect(completionReportCard({ kind: COMPLETION_REPORT_KIND })).toBeNull();
    expect(
      completionReportCard({ kind: COMPLETION_REPORT_KIND, actions: [], gates: [] })
    ).toBeNull();
  });

  it("any one of summary / actions / gates is enough to be a card", () => {
    expect(
      completionReportCard({ kind: COMPLETION_REPORT_KIND, summary: "요약" })
    ).not.toBeNull();
    expect(
      completionReportCard({
        kind: COMPLETION_REPORT_KIND,
        actions: [{ text: "한 일" }],
      })
    ).not.toBeNull();
    expect(
      completionReportCard({
        kind: COMPLETION_REPORT_KIND,
        gates: [{ surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] }],
      })
    ).not.toBeNull();
  });
});

describe("completionReportCard — parsing the full envelope", () => {
  const card = completionReportCard(REPORT_PROPS) as CompletionReportCard;

  it("reads title, summary, elapsed and marks the run clean", () => {
    expect(card.kind).toBe("completion_report");
    expect(card.title).toBe("yeomyeonggeori/oort 환경 셋업 완료");
    expect(card.summary).toContain("oort 모노레포입니다");
    expect(card.elapsedMs).toBe(1_468_000);
    expect(card.outcome).toBe("clean");
  });

  it("reads the action bullets with their reasons", () => {
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].text).toBe("Rust 툴체인을 1.83에서 1.97로 올림");
    expect(card.actions[0].note).toContain("edition2024");
    // a bullet without a reason keeps note absent, never an empty string
    expect(card.actions[1].note).toBeUndefined();
  });

  it("reads the surface x gate table", () => {
    expect(card.gates.map((g) => g.surface)).toEqual(["웹", "엔진", "compose"]);
    expect(card.gates[0].checks[0]).toEqual({
      label: "테스트",
      outcome: "pass",
      detail: "896 통과",
    });
    // detail is optional: an absent detail stays absent, no invented number
    expect(card.gates[1].checks[0]).toEqual({ label: "빌드", outcome: "pass" });
  });

  it("falls back to the default title when the agent sent none", () => {
    const bare = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      summary: "제목 없이",
    }) as CompletionReportCard;
    expect(bare.title).toBe(COMPLETION_REPORT_TITLE);
  });
});

describe("completionReportCard — the redaction contract", () => {
  const card = completionReportCard(REPORT_PROPS) as CompletionReportCard;

  it("counts opaque keys as withheld and never renders them", () => {
    // arguments + tool_grant are opaque. run_id + channel_id are internal ids
    // on the parsed allowlist. Only the two opaque keys are withheld.
    expect(card.detail.withheld).toBe(2);
  });

  it("never surfaces actions / gates / elapsed_ms as disclosure rows", () => {
    // They are drawn on the face of the card, so they are neither rows nor
    // withheld — the allowlist entry keeps the honest count honest.
    const labels = card.detail.rows.map((r) => r.label);
    expect(labels).not.toContain("actions");
    expect(labels).not.toContain("gates");
  });
});

describe("completionReportCard — honesty on failures and silence", () => {
  it("a failed check makes the whole card attention, not the passing ones", () => {
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates: [
        {
          surface: "웹",
          checks: [
            { label: "테스트", outcome: "pass" },
            { label: "린트", outcome: "fail", detail: "경고 3" },
          ],
        },
      ],
    }) as CompletionReportCard;
    expect(card.outcome).toBe("attention");
  });

  it("skip and pending never promote the card to attention (ADR-0132)", () => {
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates: [
        {
          surface: "웹",
          checks: [
            { label: "테스트", outcome: "pass" },
            { label: "실행", outcome: "skip" },
            { label: "빌드", outcome: "pending" },
          ],
        },
      ],
    }) as CompletionReportCard;
    expect(card.outcome).toBe("clean");
  });
});

describe("parse helpers drop malformed entries without failing the card", () => {
  it("parseCompletionActions keeps only entries with text", () => {
    expect(
      parseCompletionActions([
        { text: "좋음", note: "이유" },
        { note: "글자 없음" },
        "문자열",
        null,
        42,
        { text: "" },
      ])
    ).toEqual([{ text: "좋음", note: "이유" }]);
    expect(parseCompletionActions("배열 아님")).toEqual([]);
    expect(parseCompletionActions(undefined)).toEqual([]);
  });

  it("parseCompletionGates drops rows with no surface or no valid cell", () => {
    expect(
      parseCompletionGates([
        { surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] },
        // unknown outcome string -> that cell is dropped, leaving no cells -> row dropped
        { surface: "엔진", checks: [{ label: "빌드", outcome: "green" }] },
        // no surface -> dropped
        { checks: [{ label: "린트", outcome: "pass" }] },
        // checks not an array -> dropped
        { surface: "compose", checks: "healthy" },
      ])
    ).toEqual([{ surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] }]);
  });

  it("parseCompletionCheckOutcome refuses unknown strings (no guessing)", () => {
    expect(parseCompletionCheckOutcome("pass")).toBe("pass");
    expect(parseCompletionCheckOutcome("fail")).toBe("fail");
    expect(parseCompletionCheckOutcome("skip")).toBe("skip");
    expect(parseCompletionCheckOutcome("pending")).toBe("pending");
    expect(parseCompletionCheckOutcome("green")).toBeNull();
    expect(parseCompletionCheckOutcome(1)).toBeNull();
  });

  it("a negative elapsed is dropped rather than drawn (clock skew)", () => {
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      summary: "요약",
      elapsed_ms: -5,
    }) as CompletionReportCard;
    expect(card.elapsedMs).toBeUndefined();
  });
});

describe("completionCheckCounts", () => {
  it("tallies every outcome across the table", () => {
    const gates = [
      {
        surface: "웹",
        checks: [
          { label: "a", outcome: "pass" as CompletionCheckOutcome },
          { label: "b", outcome: "fail" as CompletionCheckOutcome },
        ],
      },
      {
        surface: "엔진",
        checks: [
          { label: "c", outcome: "pass" as CompletionCheckOutcome },
          { label: "d", outcome: "skip" as CompletionCheckOutcome },
          { label: "e", outcome: "pending" as CompletionCheckOutcome },
        ],
      },
    ];
    expect(completionCheckCounts(gates)).toEqual({
      pass: 2,
      fail: 1,
      skip: 1,
      pending: 1,
    });
    expect(completionOutcome(gates)).toBe("attention");
  });
});

describe("formatElapsed", () => {
  it("shows the two most significant units", () => {
    expect(formatElapsed(1_468_000)).toBe("24분 28초");
    expect(formatElapsed(3_780_000)).toBe("1시간 3분");
    expect(formatElapsed(45_000)).toBe("45초");
    expect(formatElapsed(3_600_000)).toBe("1시간");
  });

  it("does not invent precision it was not given", () => {
    expect(formatElapsed(0)).toBe("1초 미만");
    expect(formatElapsed(400)).toBe("1초 미만");
    expect(formatElapsed(-1)).toBe("");
    expect(formatElapsed(Number.NaN)).toBe("");
  });
});

describe("tone and label tables stay total", () => {
  const outcomes: CompletionCheckOutcome[] = ["pass", "fail", "skip", "pending"];

  it("every check outcome has a label and a tone role", () => {
    for (const outcome of outcomes) {
      expect(COMPLETION_CHECK_OUTCOME_LABEL[outcome]).toBeTruthy();
      expect(COMPLETION_CHECK_TONE[outcome]).toBeTruthy();
    }
  });

  it("only fail wears danger; skip and pending never do", () => {
    expect(COMPLETION_CHECK_TONE.fail).toBe("danger");
    expect(COMPLETION_CHECK_TONE.skip).not.toBe("danger");
    expect(COMPLETION_CHECK_TONE.pending).not.toBe("danger");
    // the header calls a person (warn) rather than shouting failure (danger)
    expect(COMPLETION_OUTCOME_TONE.attention).toBe("warn");
    expect(COMPLETION_OUTCOME_TONE.clean).toBe("ok");
    expect(COMPLETION_OUTCOME_LABEL.attention).toBe("확인 필요");
  });
});

describe("agentCardModel dispatch — the reuse of the turn family", () => {
  it("a plain turn message with a completion_report kind becomes the card", () => {
    const card = agentCardModel(message());
    expect(card?.kind).toBe("completion_report");
  });

  it("does not require a new message type", () => {
    // The message is `type: "text"`, not a new enum value — the whole point of
    // the reuse (schema_v0 unchanged).
    expect(message().type).toBe("text");
  });

  it("a plain agent sentence without the kind stays a plain turn", () => {
    const card = agentCardModel(message({ usage: { model: "gpt-5" } }));
    expect(card?.kind).toBe("turn");
  });

  it("a deleted row never produces a card", () => {
    expect(agentCardModel({ ...message(), state: "deleted" })).toBeNull();
  });

  it("the report card does not repeat the plain body above it", () => {
    const card = agentCardModel(message()) as CompletionReportCard;
    expect(cardKeepsBody(card)).toBe(false);
  });

  it("rowPresentation renders it as a card, body suppressed", () => {
    const row = rowPresentation(message());
    expect(row.card?.kind).toBe("completion_report");
    expect(row.keepsBody).toBe(false);
    expect(row.artifact).toBeNull();
  });
});
