import { describe, expect, it } from "vitest";
import { agentRunLedgerFromWire } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import { ledgerRows } from "./runLedger";
import {
  foldWorkTimeline,
  KNOWN_OORT_FAILURE_CODES,
  KNOWN_OORT_TOOL_NAMES,
  oortToolRows,
  workTimelineRowCopy,
  workTimelineSections,
  workTimelineSourceLabel,
  workTimelineSourceNote,
  workToolDurationText,
  workToolRecord,
  workToolSummaryText,
  workToolTally,
  type WorkTimelineRow,
} from "./workTimeline";

// =============================================================================
// 작업 타임라인 행 모델 v0 (#4654). 계약은 `workTimeline.ts` 머리 주석이다. 이 시험이 잠그는 것:
// 파서가 `tool_call`을 아는 것, 「모름」과 「0」을 가르는 것, 접는 규칙(반복·묶음·실패), 출처가
// 한 칸에 섞이지 않는 것, 그리고 모든 문장이 사전을 거치는 것.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

const copyKo = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });
const copyEn = createMessageCopy({ messageLocale: "en-US" });

function wire(events: unknown[], extra: Record<string, unknown> = {}) {
  return agentRunLedgerFromWire({ runId: RUN, events, ...extra });
}

function call(
  n: number,
  tool: string,
  code = "ok",
  durationMs = 12,
  extra: Record<string, unknown> = {}
) {
  return { ordinal: n, kind: "tool_call", tool, code, durationMs, createdAtMs: T + n * 1000, ...extra };
}

/** 합성 행. 에이전트 보고·내 컴퓨터는 아직 생산자가 없어 이 모양으로 모델을 잰다(#4657·#4658이 생산자를 더한다). */
function row(
  over: Partial<WorkTimelineRow> & Pick<WorkTimelineRow, "id" | "source">
): WorkTimelineRow {
  return { kind: "tool", label: null, status: "done", atMs: T, count: 1, ...over };
}

const partsText = (r: WorkTimelineRow) => r.parts?.map((p) => `${p.toolKind}${p.n}`).join(",") ?? null;

describe("원장 파서: tool_call (ADR-0200 증보 2026-10-15 T4)", () => {
  it("tool_call을 아는 종류로 읽고 도구·시간·결과·합계를 싣는다", () => {
    const ledger = wire(
      [
        { ordinal: 1, kind: "queued", createdAtMs: T },
        call(2, "oort_job_start"),
        call(3, "oort_run_event", "conflict", 40),
      ],
      {
        toolTally: [
          { tool: "oort_job_start", ok: 1, error: 0, durationMsSum: 12 },
          { tool: "oort_run_event", ok: 0, error: 1, durationMsSum: 40 },
        ],
        toolCallRowsCapped: false,
      }
    );
    expect(ledger.events.map((e) => e.kind)).toEqual(["queued", "tool_call", "tool_call"]);
    expect(ledger.events[1]).toMatchObject({ tool: "oort_job_start", durationMs: 12, code: "ok" });
    expect(ledger.events[1]?.rawKind).toBeUndefined();
    expect(ledger.events[2]).toMatchObject({ tool: "oort_run_event", durationMs: 40, code: "conflict" });
    expect(ledger.toolTally).toHaveLength(2);
    expect(ledger.toolCallRowsCapped).toBe(false);
  });

  it("닫힌 모양이 아닌 tool·durationMs·합계는 버리고, 다른 종류 행의 칸은 읽지 않고, 원장은 거부하지 않는다", () => {
    const ledger = wire(
      [
        call(1, "OORT Run Event"),
        call(2, "oort_run_event", "ok", 600_001),
        { ordinal: 3, kind: "stage", stage: "단계", tool: "oort_run_event", durationMs: 5, createdAtMs: T },
      ],
      { toolTally: [{ tool: "oort_run_event", ok: -1, error: 0, durationMsSum: 0 }], toolCallRowsCapped: true }
    );
    expect(ledger.events[0]).toMatchObject({ kind: "tool_call" });
    expect(ledger.events[0]?.tool).toBeUndefined();
    expect(ledger.events[1]?.durationMs).toBeUndefined();
    expect(ledger.events[2]).not.toHaveProperty("tool");
    expect(ledger.events[2]).not.toHaveProperty("durationMs");
    // 합계가 틀리면 전체를 「없음」으로: 일부만 남기면 합계가 조용히 줄어든다.
    expect(ledger.toolTally).toBeUndefined();
    expect(ledger.toolCallRowsCapped).toBeUndefined();
  });

  it("합계가 없으면 「모름」이고 빈 합계만 「호출 없음」이다: 0으로 지어내지 않는다", () => {
    expect(workToolRecord(wire([{ ordinal: 1, kind: "queued", createdAtMs: T }]))).toMatchObject({
      supported: false,
      tally: null,
      rows: [],
      listedCalls: 0,
      capped: false,
    });
    expect(workToolRecord(wire([], { toolTally: [], toolCallRowsCapped: false }))).toMatchObject({
      supported: true,
      tally: { calls: 0, failed: 0 },
      rows: [],
    });
    expect(workToolRecord(undefined).supported).toBe(false);
    expect(workToolTally(undefined)).toBeNull();
    expect(
      workToolTally([
        { tool: "oort_job_renew", ok: 7, error: 2, durationMsSum: 90 },
        { tool: "oort_run_event", ok: 3, error: 0, durationMsSum: 20 },
      ])
    ).toEqual({ calls: 12, failed: 2 });
  });

  it("기록 칸(ledgerRows)에는 tool_call이 서지 않는다: 서버가 잰 호출은 oort 기록 칸이 맡는다", () => {
    const { events } = wire([
      { ordinal: 1, kind: "queued", createdAtMs: T },
      call(2, "oort_job_start"),
      { ordinal: 3, kind: "claimed", createdAtMs: T + 9000 },
    ]);
    expect(ledgerRows(events).map((r) => r.kind)).toEqual(["queued", "claimed"]);
  });
});

describe("oort 행과 줄이기", () => {
  it("tool_call만 oort 행으로, 시각순으로 옮기고 실패 코드는 그 줄에 남긴다", () => {
    const { events } = wire([
      { ordinal: 1, kind: "stage", stage: "단계", createdAtMs: T },
      call(3, "oort_run_event", "conflict", 40),
      call(2, "oort_job_start"),
      call(4, "oort_run_event", "ok", 5, { createdAtMs: T + 3000 }),
    ]);
    const rows = oortToolRows(events);
    expect(rows.map((r) => [r.label, r.status, r.failureCode ?? null])).toEqual([
      ["oort_job_start", "done", null],
      ["oort_run_event", "failed", "conflict"],
      ["oort_run_event", "done", null],
    ]);
    expect(rows.every((r) => r.source === "oort" && r.kind === "tool" && r.count === 1)).toBe(true);
    // 같은 도구가 같은 밀리초에 두 번이어도 id가 겹치지 않는다.
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it("같은 oort 도구의 성공이 이어지면 한 줄에 횟수만 늘고, 실패는 개별 줄로 서서 반복을 끊는다", () => {
    const { events } = wire([
      call(1, "oort_job_renew"),
      call(2, "oort_job_renew"),
      call(3, "oort_job_renew", "conflict", 9),
      call(4, "oort_job_renew"),
      call(5, "oort_run_event"),
      call(6, "oort_run_event"),
    ]);
    const unfolded = oortToolRows(events);
    const folded = foldWorkTimeline(unfolded);
    expect(folded.map((r) => [r.label, r.count, r.status])).toEqual([
      ["oort_job_renew", 2, "done"],
      ["oort_job_renew", 1, "failed"],
      ["oort_job_renew", 1, "done"],
      ["oort_run_event", 2, "done"],
    ]);
    // 접힌 행의 자리는 첫 행이 정한다(줄이 늘어도 key가 그대로).
    expect(folded[0]?.id).toBe(unfolded[0]?.id);
    // 접힌 행에는 시간이 없고(합계는 서버 합계가 안다), 개별 줄에는 있다.
    expect(folded[0]?.durationMs).toBeUndefined();
    expect(folded[1]?.durationMs).toBe(9);
    // 입력은 바꾸지 않는다.
    expect(unfolded[0]?.count).toBe(1);
  });

  it("읽기·검색은 한 줄로 가라앉고 편집·실행은 개별 줄이며 실패한 읽기는 묶음을 끊는다", () => {
    const folded = foldWorkTimeline([
      row({ id: "a1", source: "agent", toolKind: "read", count: 12, atMs: T }),
      row({ id: "a2", source: "agent", toolKind: "search", count: 3, atMs: T + 1 }),
      row({ id: "a3", source: "agent", toolKind: "edit", label: "설정 고치기", atMs: T + 2 }),
      row({ id: "a4", source: "agent", toolKind: "read", count: 4, atMs: T + 3 }),
      row({ id: "a5", source: "agent", toolKind: "read", label: "없는 파일", status: "failed", atMs: T + 4 }),
      row({ id: "a6", source: "agent", toolKind: "read", count: 2, atMs: T + 5 }),
      row({ id: "a7", source: "agent", toolKind: "run", label: "테스트 실행", atMs: T + 6 }),
      row({ id: "a8", source: "agent", toolKind: "run", label: "테스트 실행", atMs: T + 7 }),
    ]);
    expect(folded.map((r) => [r.id, r.count, partsText(r)])).toEqual([
      ["a1", 15, "read12,search3"],
      ["a3", 1, null],
      ["a4", 4, "read4"],
      ["a5", 1, null],
      ["a6", 2, "read2"],
      ["a7", 1, null],
      ["a8", 1, null],
    ]);
    expect(folded[3]).toMatchObject({ status: "failed", label: "없는 파일" });
    // 호출자가 `parts`를 미리 채워 넘긴 행도 같다: 실패·진행 중인 묶음 행은 앞 묶음에 합쳐지지 않는다.
    const prefilled = (id: string, status: WorkTimelineRow["status"]) =>
      row({ id, source: "agent", status, count: 4, parts: [{ toolKind: "read", n: 4 }] });
    expect(
      foldWorkTimeline([prefilled("p1", "done"), prefilled("p2", "failed"), prefilled("p3", "running")]).map(
        (r) => [r.id, r.count, r.status]
      )
    ).toEqual([
      ["p1", 4, "done"],
      ["p2", 4, "failed"],
      ["p3", 4, "running"],
    ]);
    expect(foldWorkTimeline([prefilled("q1", "done"), prefilled("q2", "done")]).map((r) => [r.id, r.count])).toEqual([
      ["q1", 8],
    ]);
    expect(workTimelineRowCopy(folded[0] as WorkTimelineRow, copyKo).label).toBe("읽기 12 · 검색 3");
    expect(workTimelineRowCopy(folded[2] as WorkTimelineRow, copyKo).label).toBe("읽기 4");
    expect(workTimelineRowCopy(folded[0] as WorkTimelineRow, copyEn).label).toBe("Read 12 · Search 3");
  });

  it("출처 셋은 한 칸에 섞이지 않는다: 칸마다 한 출처이고 에이전트의 읽기 12와 oort의 읽기 3은 15가 되지 않는다", () => {
    const mixed: WorkTimelineRow[] = [
      row({ id: "o1", source: "oort", toolKind: "read", label: "oort_inbox_read", count: 3 }),
      row({ id: "a1", source: "agent", toolKind: "read", count: 12 }),
      row({ id: "c1", source: "computer", toolKind: "read", count: 5 }),
      row({ id: "a2", source: "agent", toolKind: "search", count: 3 }),
      row({ id: "o2", source: "oort", label: "oort_run_event" }),
    ];
    const sections = workTimelineSections(mixed);
    expect(sections.map((s) => s.source)).toEqual(["oort", "agent", "computer"]);
    for (const section of sections) {
      expect(section.rows.every((r) => r.source === section.source)).toBe(true);
    }
    expect(sections.map((s) => s.rows.map((r) => [r.id, r.count, partsText(r)]))).toEqual([
      [["o1", 3, "read3"], ["o2", 1, null]],
      [["a1", 15, "read12,search3"]],
      [["c1", 5, "read5"]],
    ]);
    // 입력이 섞여 붙어 있어도 서로 다른 출처의 행은 어느 쪽으로도 합쳐지지 않는다.
    const adjacent = foldWorkTimeline([
      row({ id: "x1", source: "oort", toolKind: "read", count: 3 }),
      row({ id: "x2", source: "agent", toolKind: "read", count: 12 }),
    ]);
    expect(adjacent.map((r) => [r.id, r.count])).toEqual([
      ["x1", 3],
      ["x2", 12],
    ]);
    // 행이 없는 출처는 칸이 서지 않는다.
    expect(workTimelineSections([row({ id: "only", source: "agent" })]).map((s) => s.source)).toEqual(["agent"]);
  });
});

describe("문장 (모든 사용자 문구는 사전을 거친다)", () => {
  it("도구 이름은 사전을 거치고, 모르는 이름은 그대로, 에이전트 글은 정리한 텍스트로 낸다", () => {
    const label = (r: WorkTimelineRow) => workTimelineRowCopy(r, copyKo).label;
    expect(label(row({ id: "1", source: "oort", label: "oort_run_event" }))).toBe("진행 알리기");
    expect(label(row({ id: "2", source: "oort", label: "oort_future_tool" }))).toBe("oort_future_tool");
    expect(label(row({ id: "3", source: "oort", label: null }))).toBe("oort 도구");
    expect(label(row({ id: "4", source: "agent", toolKind: "edit", label: "  설정   \n 고치기 " }))).toBe(
      "설정 고치기"
    );
    expect(label(row({ id: "5", source: "agent", toolKind: "run", label: null }))).toBe("명령 실행");
    expect(label(row({ id: "6", source: "agent", label: "가".repeat(200) }))).toBe(`${"가".repeat(80)}…`);
    // 마크업·ICU 문법은 해석하지 않는다. 글자 그대로 돌려주고 호출자가 텍스트 노드로 그린다.
    expect(label(row({ id: "7", source: "agent", label: "<img src=x onerror=1> {name}" }))).toBe(
      "<img src=x onerror=1> {name}"
    );
    // 에이전트가 oort 도구 이름을 글로 썼다고 사전 낱말이 되지 않는다.
    expect(label(row({ id: "8", source: "agent", label: "oort_run_event" }))).toBe("oort_run_event");
  });

  it("서버의 닫힌 도구 목록·실패 코드가 모두 사전 낱말을 갖는다(두 언어)", () => {
    expect([...KNOWN_OORT_TOOL_NAMES].sort()).toEqual(
      [
        "oort_action_claim_secret",
        "oort_action_initiate",
        "oort_action_propose",
        "oort_card_suggest",
        "oort_conversation_read",
        "oort_expression_assemble",
        "oort_inbox_read",
        "oort_job_release",
        "oort_job_renew",
        "oort_job_start",
        "oort_jobs_claim",
        "oort_message_post",
        "oort_ping",
        "oort_run_complete",
        "oort_run_event",
      ].sort()
    );
    for (const copy of [copyKo, copyEn]) {
      for (const tool of KNOWN_OORT_TOOL_NAMES) {
        const text = workTimelineRowCopy(row({ id: tool, source: "oort", label: tool }), copy).label;
        expect(text).not.toBe(tool);
        expect(text).not.toMatch(/oort_/);
      }
      for (const code of KNOWN_OORT_FAILURE_CODES) {
        const { failure } = workTimelineRowCopy(
          row({ id: code, source: "oort", label: "oort_job_renew", status: "failed", failureCode: code }),
          copy
        );
        expect(failure).toEqual(expect.any(String));
        expect(failure).not.toBe(code);
      }
    }
  });

  it("실패는 닫힌 코드만 이유가 되고 모르는 코드는 「실패」만 말한다. 반복 횟수와 시간은 한 줄 안에 따로 있다", () => {
    expect(
      workTimelineRowCopy(
        row({
          id: "f",
          source: "oort",
          label: "oort_job_renew",
          status: "failed",
          failureCode: "conflict",
          durationMs: 40,
        }),
        copyKo
      )
    ).toMatchObject({ statusWord: "실패", failure: "다른 변경과 겹쳤어요", duration: "40ms", repeat: null });
    expect(
      workTimelineRowCopy(
        row({ id: "g", source: "oort", label: "oort_job_renew", status: "failed", failureCode: "brand_new_code" }),
        copyKo
      )
    ).toMatchObject({ statusWord: "실패", failure: null });
    expect(
      workTimelineRowCopy(row({ id: "h", source: "oort", label: "oort_job_renew", count: 12 }), copyKo)
    ).toMatchObject({ repeat: "12번", statusWord: null, failure: null });
    // 묶음은 이름이 이미 수를 말해서 「N번」을 또 붙이지 않는다.
    expect(
      workTimelineRowCopy(
        { ...row({ id: "b", source: "agent", toolKind: "read", count: 12 }), parts: [{ toolKind: "read", n: 12 }] },
        copyKo
      ).repeat
    ).toBeNull();
  });

  it("칸 머리 낱말·합계 문장·걸린 시간은 두 언어에서 같은 값을 말한다", () => {
    expect(workTimelineSourceLabel("oort", copyKo)).toBe("oort 기록");
    expect(workTimelineSourceLabel("agent", copyKo)).toBe("에이전트 보고");
    expect(workTimelineSourceLabel("computer", copyKo)).toBe("내 컴퓨터");
    expect(workTimelineSourceNote("oort", copyKo)).toContain("인자와 내용은 기록하지 않아요");
    expect(workTimelineSourceLabel("agent", copyEn)).toBe("Agent report");

    expect(workToolSummaryText(null, copyKo)).toBeNull();
    expect(workToolSummaryText({ calls: 31, failed: 0 }, copyKo)).toBe("도구 호출 31번");
    expect(workToolSummaryText({ calls: 31, failed: 2 }, copyKo)).toBe("도구 호출 31번 · 실패 2번");
    expect(workToolSummaryText({ calls: 1, failed: 0 }, copyEn)).toBe("1 tool call");
    expect(workToolSummaryText({ calls: 31, failed: 2 }, copyEn)).toBe("31 tool calls · 2 failed");

    expect(workToolDurationText(35, copyKo)).toBe("35ms");
    expect(workToolDurationText(999, copyKo)).toBe("999ms");
    expect(workToolDurationText(1234, copyKo)).toBe("1.2초");
    expect(workToolDurationText(59_960, copyKo)).toBe("1분 0초");
    expect(workToolDurationText(65_000, copyKo)).toBe("1분 5초");
    expect(workToolDurationText(1234, copyEn)).toBe("1.2s");
  });
});
