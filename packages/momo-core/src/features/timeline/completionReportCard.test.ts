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
  ELAPSED_SUB_SECOND,
  MAX_COMPLETION_ACTIONS,
  MAX_COMPLETION_CHECKS_PER_ROW,
  MAX_COMPLETION_GATE_ROWS,
  WORKED_ELAPSED_LABEL,
  completionCellChecks,
  completionCheckCounts,
  completionGateColumns,
  completionOutcome,
  completionReportCard,
  completionRowChecks,
  formatElapsed,
  parseCompletionActions,
  parseCompletionCheckOutcome,
  parseCompletionGates,
  type CompletionCheck,
  type CompletionCheckOutcome,
  type CompletionGateRow,
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

  it("parseCompletionGates drops rows with no surface or no cell it can place", () => {
    expect(
      parseCompletionGates([
        { surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] },
        // no surface -> dropped
        { checks: [{ label: "린트", outcome: "pass" }] },
        // checks not an array -> dropped
        { surface: "compose", checks: "healthy" },
        // a cell with no outcome at all (not a string) -> that cell is not a
        // cell; the row's only cell is gone, so the row drops. This is the ONLY
        // way a cell is dropped now — an unreadable outcome STRING is kept as
        // 미상 (M1), never silently removed.
        { surface: "빈", checks: [{ label: "x" }] },
      ])
    ).toEqual([{ surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] }]);
  });

  it("parseCompletionCheckOutcome normalizes synonyms and case, refuses the rest (M1)", () => {
    expect(parseCompletionCheckOutcome("pass")).toBe("pass");
    expect(parseCompletionCheckOutcome("fail")).toBe("fail");
    expect(parseCompletionCheckOutcome("skip")).toBe("skip");
    expect(parseCompletionCheckOutcome("pending")).toBe("pending");
    // failure synonyms must reach `fail`, not vanish next to the passes
    expect(parseCompletionCheckOutcome("failed")).toBe("fail");
    expect(parseCompletionCheckOutcome("error")).toBe("fail");
    expect(parseCompletionCheckOutcome("FAIL")).toBe("fail");
    expect(parseCompletionCheckOutcome("Failure")).toBe("fail");
    // pass synonyms
    expect(parseCompletionCheckOutcome("green")).toBe("pass");
    expect(parseCompletionCheckOutcome("PASSED")).toBe("pass");
    expect(parseCompletionCheckOutcome("ok")).toBe("pass");
    // still no guessing for genuinely unknown vocabulary
    expect(parseCompletionCheckOutcome("bananas")).toBeNull();
    expect(parseCompletionCheckOutcome(1)).toBeNull();
    expect(parseCompletionCheckOutcome("")).toBeNull();
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
      unknown: 0,
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

  it("그 낱말은 상수로 서 있다 — 조사를 아는 자리가 값을 다시 적지 않게 (#1468)", () => {
    // 「1초 미만」은 기간 명사가 아니라 비교 표현이라 「동안」을 받지 못한다.
    // `workSessionFormat` 이 그 경계를 이 상수와의 비교로 알아본다.
    expect(ELAPSED_SUB_SECOND).toBe("1초 미만");
    expect(formatElapsed(0)).toBe(ELAPSED_SUB_SECOND);
  });
});

describe("경과를 이름 붙이는 낱말 (#1468)", () => {
  it("라벨:값 쌍인 자리는 「작업 시간」 하나를 쓴다", () => {
    // 카드의 이 줄과 작업 세션 정보의 그 줄이 같은 측정을 말한다. 세션 쪽이 쓰던
    // 「실행 시간」은 형태가 아니라 어근이 달랐고, 한 화면의 한 숫자를 두 측정처럼
    // 보이게 했다. 술어 자리(「N분 N초 동안 작업」)는 형태가 다르므로 그대로다.
    expect(WORKED_ELAPSED_LABEL).toBe("작업 시간");
  });
});

describe("tone and label tables stay total", () => {
  const outcomes: CompletionCheckOutcome[] = [
    "pass",
    "fail",
    "skip",
    "pending",
    "unknown",
  ];

  it("every check outcome has a label and a tone role", () => {
    for (const outcome of outcomes) {
      expect(COMPLETION_CHECK_OUTCOME_LABEL[outcome]).toBeTruthy();
      expect(COMPLETION_CHECK_TONE[outcome]).toBeTruthy();
    }
  });

  it("only fail wears danger; skip, pending and unknown never do", () => {
    expect(COMPLETION_CHECK_TONE.fail).toBe("danger");
    expect(COMPLETION_CHECK_TONE.skip).not.toBe("danger");
    expect(COMPLETION_CHECK_TONE.pending).not.toBe("danger");
    // an unread cell is not guessed to be a failure (M1) — warn calls a person
    expect(COMPLETION_CHECK_TONE.unknown).not.toBe("danger");
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

// =============================================================================
// H1 — 매트릭스가 중복 라벨 칸을 접어 실패를 숨기지 않는다.
//
// 웹 표는 표면×라벨 매트릭스라, 한 표면에 같은 라벨 두 칸(통과 「896 통과」 +
// 실패 「1 실패」)이 오면 예전 코드가 `find` 로 첫 칸만 그려 초록만 남고 실패가
// 사라졌다. 판정을 코어로 올려(`completionGateColumns`/`completionCellChecks`) 웹
// 표가 폰·집계와 **같은 칸 집합**을 그리는지를 여기서 순수하게 잰다 — 이 클라에는
// 렌더 하네스가 없기 때문이다(웹/폰 소스 대조는 각 클라 테스트가 별도로 한다).
// =============================================================================

/** 한 줄을 매트릭스(열×셀)로 재구성해 평평하게 편 것. 웹 표가 그리는 칸 집합이다. */
function reconstructAsMatrix(gates: readonly CompletionGateRow[]): CompletionCheck[] {
  const columns = completionGateColumns(gates);
  const out: CompletionCheck[] = [];
  for (const row of gates) {
    for (const col of columns) out.push(...completionCellChecks(row, col));
  }
  return out;
}

/** 순서 무관 다중집합 비교(정렬 후 JSON). */
function sortedJson(checks: readonly CompletionCheck[]): string[] {
  return checks.map((c) => JSON.stringify(c)).sort();
}

describe("H1 — 웹 매트릭스가 중복 라벨의 실패를 접지 않는다", () => {
  const dupGates = parseCompletionGates([
    {
      surface: "웹",
      checks: [
        { label: "빌드", outcome: "pass", detail: "896 통과" },
        { label: "빌드", outcome: "fail", detail: "1 실패" },
      ],
    },
  ]);

  it("파서는 중복 라벨 두 칸을 모두 살린다 (버리지 않는다)", () => {
    expect(dupGates[0].checks).toHaveLength(2);
  });

  it("열은 라벨 합집합이라 중복 라벨을 한 번만 세운다", () => {
    expect(completionGateColumns(dupGates)).toEqual(["빌드"]);
  });

  it("한 셀이 두 칸을 모두 돌려주고, 실패가 맨 앞이다 (초록에 접히지 않는다)", () => {
    const cell = completionCellChecks(dupGates[0], "빌드");
    expect(cell).toHaveLength(2);
    // 최악 톤이 먼저 — 실패가 통과 앞에 서서 절대 사라지지 않는다.
    expect(cell[0].outcome).toBe("fail");
    // red proof: 웹 표가 그릴 칸들 안에 실패 칸이 실제로 존재한다.
    expect(cell.some((c) => c.outcome === "fail")).toBe(true);
  });

  it("웹 매트릭스·폰 목록·집계가 같은 칸 집합을 그린다 (3표면 일치)", () => {
    const flat = dupGates.flatMap((row) => row.checks); // 폰이 그리는 칸(표면별 목록)
    const matrix = reconstructAsMatrix(dupGates); // 웹 표가 그리는 칸
    // 다중집합이 같다 — 웹이 하나라도 접거나 중복시키지 않는다.
    expect(sortedJson(matrix)).toEqual(sortedJson(flat));
    // 집계(칩·표 밑 한 줄)도 같은 칸을 센다.
    expect(completionCheckCounts(dupGates)).toMatchObject({ pass: 1, fail: 1 });
    // 그리고 카드 머리는 실패가 있으므로 attention 이다.
    expect(completionOutcome(dupGates)).toBe("attention");
  });

  it("폰의 평평한 목록도 겹친 라벨의 실패를 통과 앞에 세운다 (폰 패리티)", () => {
    // completionRowChecks: 서로 다른 라벨은 처음 쓴 순서를 지키고, 겹친 라벨만
    // 그 안에서 최악 톤 먼저. 웹 셀이 쌓는 순서와 같다.
    const ordered = completionRowChecks(dupGates[0]);
    expect(ordered.map((c) => c.outcome)).toEqual(["fail", "pass"]);
  });

  it("겹치지 않는 흔한 경우엔 폰 순서를 바꾸지 않는다", () => {
    const row: CompletionGateRow = {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass" },
        { label: "린트", outcome: "pass" },
        { label: "빌드", outcome: "fail" },
      ],
    };
    // 라벨이 겹치지 않으면 에이전트가 쓴 순서 그대로다 — 실패를 위로 끌어올리지
    // 않는다(웹 열 순서와 같은 규율).
    expect(completionRowChecks(row).map((c) => c.label)).toEqual([
      "테스트",
      "린트",
      "빌드",
    ]);
  });
});

describe("M1 — 실패 동의어·어휘 밖 결과가 표에서 사라지지 않는다", () => {
  it("실패 동의어(대소문자 무관)가 통과 옆에서 버려지지 않고 attention 을 세운다", () => {
    // 수리 전이라면 `passed`·`FAILED` 둘 다 어휘 밖이라 버려져 줄이 통째로
    // 사라지고 카드가 clean(혹은 null)이었다. 이제 정규화되어 실패가 남는다.
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates: [
        {
          surface: "웹",
          checks: [
            { label: "테스트", outcome: "passed", detail: "896 통과" },
            { label: "린트", outcome: "FAILED", detail: "3 경고" },
          ],
        },
      ],
    }) as CompletionReportCard;
    expect(card.gates[0].checks.map((c) => c.outcome)).toEqual(["pass", "fail"]);
    expect(card.outcome).toBe("attention");
  });

  it("매핑 불가 결과는 버리지 않고 미상 결과로 표에 남는다 (추측으로 pass 금지)", () => {
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates: [
        {
          surface: "웹",
          checks: [{ label: "보안", outcome: "quarantined", detail: "검토 대기" }],
        },
      ],
    }) as CompletionReportCard;
    const check = card.gates[0].checks[0];
    expect(check.outcome).toBe("unknown");
    // 세부는 보존한다 — 카드가 못 읽은 것은 결과 낱말이지 세부가 아니다.
    expect(check.detail).toBe("검토 대기");
    // 미상은 실패가 아니므로 머리를 뒤집지 않지만, 집계에 잡혀 스스로 드러난다.
    expect(card.outcome).toBe("clean");
    expect(completionCheckCounts(card.gates).unknown).toBe(1);
  });
});

describe("M2 — summary 없는 완료 리포트는 본문을 접지 않는다", () => {
  it("게이트만 있고 summary 가 없으면 body 를 위에 남긴다", () => {
    // message() 의 body 는 "환경 셋업을 마쳤습니다." — summary 가 없으면 이 문장이
    // 카드의 유일한 문장이므로 접으면 웹·폰에서 사라진다.
    const card = agentCardModel(
      message({
        kind: COMPLETION_REPORT_KIND,
        title: "환경 셋업",
        gates: [{ surface: "웹", checks: [{ label: "테스트", outcome: "pass" }] }],
      })
    ) as CompletionReportCard;
    expect(card.summary).toBeUndefined();
    expect(cardKeepsBody(card)).toBe(true);
  });

  it("summary 가 있으면 본문은 접힌다 (한 문장을 두 번 그리지 않는다)", () => {
    const card = agentCardModel(
      message({ kind: COMPLETION_REPORT_KIND, summary: "요약이 있음" })
    ) as CompletionReportCard;
    expect(cardKeepsBody(card)).toBe(false);
  });
});

describe("M3 — 배열 상한이 DOM 폭발을 막되 개수를 정직 표기한다", () => {
  it("불릿을 상한까지만 그리고 나머지 개수를 남긴다", () => {
    const actions = Array.from({ length: MAX_COMPLETION_ACTIONS + 37 }, (_, i) => ({
      text: `불릿 ${i}`,
    }));
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      actions,
    }) as CompletionReportCard;
    expect(card.actions).toHaveLength(MAX_COMPLETION_ACTIONS);
    expect(card.omitted.actions).toBe(37);
  });

  it("표면(줄)을 상한까지만 그리고 나머지 개수를 남긴다", () => {
    const gates = Array.from({ length: MAX_COMPLETION_GATE_ROWS + 5 }, (_, i) => ({
      surface: `표면 ${i}`,
      checks: [{ label: "테스트", outcome: "pass" }],
    }));
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates,
    }) as CompletionReportCard;
    expect(card.gates).toHaveLength(MAX_COMPLETION_GATE_ROWS);
    expect(card.omitted.gates).toBe(5);
  });

  it("한 줄 안 칸을 상한까지만 그리고 나머지 개수를 남긴다", () => {
    const checks: CompletionCheck[] = Array.from(
      { length: MAX_COMPLETION_CHECKS_PER_ROW + 8 },
      (_, i) => ({ label: `게이트 ${i}`, outcome: "pass" })
    );
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates: [{ surface: "웹", checks }],
    }) as CompletionReportCard;
    expect(card.gates[0].checks).toHaveLength(MAX_COMPLETION_CHECKS_PER_ROW);
    expect(card.omitted.checks).toBe(8);
  });

  it("상한에 걸려 안 그린 꼬리의 실패도 머리 칩을 attention 으로 만든다", () => {
    // outcome 은 자르기 전 전체로 잰다 — 안 그린 실패를 「완료」로 거짓말하지 않는다.
    const gates = [
      ...Array.from({ length: MAX_COMPLETION_GATE_ROWS }, (_, i) => ({
        surface: `표면 ${i}`,
        checks: [{ label: "테스트", outcome: "pass" }],
      })),
      { surface: "꼬리", checks: [{ label: "빌드", outcome: "fail" }] },
    ];
    const card = completionReportCard({
      kind: COMPLETION_REPORT_KIND,
      gates,
    }) as CompletionReportCard;
    expect(card.gates).toHaveLength(MAX_COMPLETION_GATE_ROWS);
    expect(card.omitted.gates).toBe(1);
    expect(card.outcome).toBe("attention");
  });

  it("진짜 리포트(표면 서넛)는 상한에 걸리지 않는다 — 전부 0", () => {
    const card = completionReportCard(REPORT_PROPS) as CompletionReportCard;
    expect(card.omitted).toEqual({ actions: 0, gates: 0, checks: 0 });
  });
});
