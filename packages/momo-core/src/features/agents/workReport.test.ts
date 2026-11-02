import { describe, expect, it } from "vitest";
import { agentRunLedgerFromWire } from "../../lib/api";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit/i18n";
import {
  agentActivityRows,
  runReportChipText,
  runReportDurationText,
  runReportSummary,
  workActivityRecord,
  workActivityTallyText,
} from "./workReport";
import {
  foldWorkTimeline,
  lastRunningRowId,
  workTimelineRowCopy,
  workTimelineSections,
  type WorkTimelineRow,
} from "./workTimeline";

// =============================================================================
// 에이전트 보고(ADR-0200 증보 7, #4657)의 코어: 원장 읽기 → 행 → 접기 → 계획 → 요약. 문장은 한국어 사전으로
// 읽는다. 사보타주 표는 인계 파일에 있다.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;
const MIN = 60_000;
// 사전을 못 찾거나 인자가 맞지 않으면 조용히 되돌아가지 않고 던진다(`createMessageCopy`).
const fmt = createMessageCopy({ messageLocale: "ko-KR", catalog: ko });

function activity(
  ordinal: number,
  id: string,
  over: Partial<{ kind: string; label: string; status: string; n: number; startedAtMs: number }> = {},
  createdAtMs = T + ordinal * 1000
) {
  return {
    ordinal,
    kind: "activity",
    createdAtMs,
    activity: { id, kind: "edit", status: "completed", n: 1, startedAtMs: T + ordinal * 1000, ...over },
  };
}

function ledger(events: unknown[], extra: Record<string, unknown> = {}) {
  return agentRunLedgerFromWire({ runId: RUN, events, ...extra });
}

describe("에이전트 활동·계획 읽기", () => {
  it("활동·계획 행과 합계를 읽고, 본문이 틀린 행은 그 행만 모르는 종류로 내린다", () => {
    const parsed = ledger(
      [
        activity(1, "a1", { kind: "read", label: "문서 읽기", n: 12 }),
        activity(2, "a/1"), // 식별자 모양이 틀림
        { ordinal: 3, kind: "activity", createdAtMs: T }, // 본문 없음
        activity(4, "a4", { status: "" }), // 상태 없음
        { ordinal: 5, kind: "plan", createdAtMs: T, plan: [{ text: "읽기", status: "completed" }, { text: "" , status: "pending" }] }, // 한 단계가 틀림
        { ordinal: 6, kind: "plan", createdAtMs: T + 1, plan: [{ text: "읽기", status: "completed" }] },
        // 다른 종류 행에 실려 온 활동 칸은 읽지 않는다.
        { ordinal: 7, kind: "stage", stage: "단계", createdAtMs: T, activity: { id: "z", kind: "run", status: "completed", n: 1, startedAtMs: T } },
      ],
      {
        activityTally: [{ kind: "read", completed: 12, failed: 0 }],
        activityRowsTrimmed: true,
      }
    );
    expect(parsed.events.map((event) => event.kind)).toEqual([
      "activity", "unknown", "unknown", "unknown", "unknown", "plan", "stage",
    ]);
    expect(parsed.events[0]?.activity).toEqual({ id: "a1", kind: "read", label: "문서 읽기", status: "completed", n: 12, startedAtMs: T + 1000 });
    expect(parsed.events[1]?.rawKind).toBe("activity");
    expect(parsed.events[5]?.plan).toEqual([{ text: "읽기", status: "completed" }]);
    expect(parsed.events[6]?.activity).toBeUndefined();
    expect(parsed.activityTally).toEqual([{ kind: "read", completed: 12, failed: 0 }]);
    expect(parsed.activityRowsTrimmed).toBe(true);
    // 합계가 하나라도 틀리면 전체를 없음으로 두고, 그 응답의 줄은 그대로 읽는다.
    const broken = ledger([activity(1, "a1")], { activityTally: [{ kind: "read", completed: -1, failed: 0 }], activityRowsTrimmed: true });
    expect(broken.activityTally).toBeUndefined();
    expect(broken.activityRowsTrimmed).toBeUndefined();
    expect(broken.events).toHaveLength(1);
  });
});

describe("에이전트 활동 행 (제자리 행)", () => {
  it("자리는 첫 보고 시각이 정하고, 같은 id는 늦게 갱신된 쪽이 이기며, 끝난 run의 진행 중은 끝 보고 없음이다", () => {
    const events = ledger([
      // a2가 먼저 시작했고 나중에 갱신됐다: 갱신 시각이 아니라 시작 시각이 줄의 자리다.
      activity(1, "a2", { status: "in_progress", startedAtMs: T + 1000 }, T + 9000),
      activity(2, "a1", { status: "completed", startedAtMs: T + 2000 }, T + 3000),
      // 같은 id가 겹쳐 오면 늦게 갱신된 쪽
      activity(3, "a1", { status: "failed", startedAtMs: T + 2000 }, T + 4000),
      activity(4, "a3", { status: "in_progress", kind: "constructor", startedAtMs: T + 5000 }),
      activity(5, "a4", { status: "queued_by_a_newer_server", startedAtMs: T + 6000 }),
    ]).events;

    const open = agentActivityRows(events, true);
    expect(open.map((row) => [row.id, row.status])).toEqual([
      ["agent|activity|a2", "running"],
      ["agent|activity|a1", "failed"],
      ["agent|activity|a3", "running"],
      ["agent|activity|a4", "running"],
    ]);
    // 모르는 종류 낱말은 「그 밖」이다(객체 조회였다면 `constructor`가 함수를 돌려줬다).
    expect(open.find((row) => row.id.endsWith("a3"))?.toolKind).toBe("other");
    // 끝난 run: 진행 중이던 것은 끝났다고도 지금 한다고도 말하지 않는다. 실패는 그대로다.
    const ended = agentActivityRows(events, false);
    expect(ended.map((row) => row.status)).toEqual(["unclosed", "failed", "unclosed", "unclosed"]);
    expect(workTimelineRowCopy(ended[0] as WorkTimelineRow, fmt).statusWord).toBe("끝 보고 없음");
    // 같은 활동이 다시 읽혀도(상태만 바뀌어도) 줄의 열쇠와 자리가 같다.
    const later = agentActivityRows(
      ledger([activity(1, "a2", { status: "completed", startedAtMs: T + 1000 }, T + 20_000), activity(2, "a1", { status: "failed", startedAtMs: T + 2000 })]).events,
      true
    );
    expect(later.map((row) => row.id)).toEqual(["agent|activity|a2", "agent|activity|a1"]);
    // 진행 중인 마지막 행 하나만 점을 받는다.
    expect(lastRunningRowId(open)).toBe("agent|activity|a4");
    expect(lastRunningRowId(ended)).toBeNull();
  });
});

describe("묶음 접기 (에이전트 보고 칸)", () => {
  it("끝난 읽기·검색은 「읽기 12 · 검색 3」으로 가라앉고, 진행 중·실패·끝 보고 없음은 개별 줄이며 출처를 넘어 합치지 않는다", () => {
    const record = workActivityRecord(
      ledger([
        activity(1, "r1", { kind: "read", n: 9, startedAtMs: T + 1000 }),
        activity(2, "r2", { kind: "read", n: 3, startedAtMs: T + 2000 }),
        activity(3, "s1", { kind: "search", n: 3, startedAtMs: T + 3000 }),
        activity(4, "e1", { kind: "edit", label: "리포트 고치기", status: "in_progress", startedAtMs: T + 4000 }),
        activity(5, "r3", { kind: "read", n: 4, startedAtMs: T + 5000 }),
        activity(6, "r4", { kind: "read", n: 2, status: "failed", startedAtMs: T + 6000 }),
        activity(7, "r5", { kind: "read", n: 1, startedAtMs: T + 7000 }),
      ]),
      { open: true, working: true }
    );
    expect(record.rows.map((row) => [row.id, row.status, row.parts?.map((part) => `${part.toolKind}${part.n}`) ?? row.count])).toEqual([
      ["agent|activity|r1", "done", ["read12", "search3"]], // 읽기 9+3, 검색 3
      ["agent|activity|e1", "running", 1],
      ["agent|activity|r3", "done", ["read4"]],
      ["agent|activity|r4", "failed", 2],
      ["agent|activity|r5", "done", ["read1"]],
    ]);
    expect(workTimelineRowCopy(record.rows[0] as WorkTimelineRow, fmt).label).toBe("읽기 12 · 검색 3");
    expect(workTimelineRowCopy(record.rows[1] as WorkTimelineRow, fmt).label).toBe("리포트 고치기");
    // 끝난 run에서 끝 보고 없는 읽기는 앞뒤 묶음에 합쳐지지 않는다.
    const ended = foldWorkTimeline(
      agentActivityRows(
        ledger([
          activity(1, "r1", { kind: "read", n: 2, startedAtMs: T + 1000 }),
          activity(2, "r2", { kind: "read", n: 5, status: "in_progress", startedAtMs: T + 2000 }),
          activity(3, "r3", { kind: "read", n: 2, startedAtMs: T + 3000 }),
        ]).events,
        false
      )
    );
    expect(ended.map((row) => row.status)).toEqual(["done", "unclosed", "done"]);
    // 끝 보고 없는 줄은 묶음(parts)도 반복도 아니다: 「읽기 5」로 끝났다고 말하지 않는다.
    expect(ended.map((row) => row.parts !== undefined)).toEqual([true, false, true]);
    expect(ended[1]?.count).toBe(5);
    // oort가 잰 같은 종류 행과는 칸이 갈려 합쳐지지 않는다.
    const sections = workTimelineSections([
      { id: "o1", source: "oort", kind: "tool", toolKind: "read", label: "oort_inbox_read", status: "done", atMs: T, count: 3 },
      ...record.rows,
    ]);
    expect(sections.map((section) => section.source)).toEqual(["oort", "agent"]);
    expect(sections[0]?.rows[0]?.parts?.[0]?.n).toBe(3);
  });
});

describe("계획 진척과 합계", () => {
  it("가장 새 계획이 이기고 서버가 돈다고 할 때만 지금 단계가 서며, 모르는 상태는 대기·빈 계획은 없음이다", () => {
    const events = [
      { ordinal: 1, kind: "plan", createdAtMs: T, plan: [{ text: "읽기", status: "in_progress" }] },
      {
        ordinal: 2,
        kind: "plan",
        createdAtMs: T + 5000,
        plan: [
          { text: "문서 읽기", status: "completed" },
          { text: "표 정리", status: "in_progress" },
          { text: "요약", status: "pending" },
          { text: "검토", status: "reviewing" },
        ],
      },
    ];
    const working = workActivityRecord(ledger(events), { open: true, working: true });
    expect(working.plan).toMatchObject({ total: 4, done: 1, remaining: 3, hasCurrent: true, live: true });
    expect(working.plan?.steps.map((step) => step.state)).toEqual(["done", "current", "pending", "pending"]);
    // 멈춘(끝난) run의 in_progress는 지금 단계가 아니라 대기다.
    const ended = workActivityRecord(ledger(events), { open: false, working: false });
    expect(ended.plan?.hasCurrent).toBe(false);
    expect(ended.plan?.live).toBe(false);
    // 에이전트가 계획을 비우면(`[]`) 「0단계」를 그리지 않는다. 그래도 서버는 이 종류를 안다.
    const cleared = workActivityRecord(ledger([{ ordinal: 1, kind: "plan", createdAtMs: T, plan: [] }]), { open: true, working: true });
    expect(cleared.plan).toBeNull();
    expect(cleared.supported).toBe(true);
  });

  it("합계가 없으면 「모름」이고 0이 아니다. 빈 합계는 「끝난 활동 없음」이며 상한 문장은 합계가 더 클 때다", () => {
    const unknown = workActivityRecord(ledger([{ ordinal: 1, kind: "queued", createdAtMs: T }]), { open: true, working: false });
    expect(unknown).toMatchObject({ supported: false, tally: null, plan: null, rows: [] });
    expect(workActivityTallyText(unknown.tally, fmt)).toBeNull();
    const empty = workActivityRecord(ledger([], { activityTally: [] }), { open: false, working: false });
    expect(empty.supported).toBe(true);
    expect(workActivityTallyText(empty.tally, fmt)).toBeNull();
    const counted = workActivityRecord(
      ledger([activity(1, "a1")], {
        activityTally: [
          { kind: "read", completed: 30, failed: 0 },
          { kind: "run", completed: 11, failed: 1 },
          { kind: "constructor", completed: 2, failed: 0 },
        ],
        activityRowsTrimmed: true,
      }),
      { open: false, working: false }
    );
    expect(counted.trimmed).toBe(true);
    // 서버 순서(명령 → 편집 → 읽기 …)로 서고 모르는 낱말은 「기타」다.
    expect(workActivityTallyText(counted.tally, fmt)).toBe("끝낸 활동 합계 · 명령 12 · 읽기 30 · 기타 2");
  });
});

describe("끝난 요청의 요약 칩", () => {
  it("「13분 · 단계 6 · 명령 12 · 에이전트 보고」: 에이전트가 말한 숫자만 세고 분 단위이며, 숫자가 없으면 시간만 남는다", () => {
    const events = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ ordinal: n, kind: "stage", stage: `단계 ${n}`, createdAtMs: T + n })),
      // oort가 잰 호출은 출처가 달라 요약에 섞이지 않는다.
      ...[7, 8, 9].map((n) => ({ ordinal: n, kind: "tool_call", tool: "oort_run_event", code: "ok", createdAtMs: T + n })),
    ];
    const summary = runReportSummary(
      ledger(events, {
        activityTally: [
          { kind: "run", completed: 11, failed: 1 },
          { kind: "edit", completed: 4, failed: 0 },
          { kind: "read", completed: 40, failed: 0 },
          { kind: "search", completed: 4, failed: 0 },
        ],
      })
    );
    // 많은 쪽 둘(읽기 40·명령 12). 편집·검색 4는 같은 수라 종류 순서지만 둘 안에 못 들었다.
    expect(summary).toEqual({ stages: 6, kinds: [{ toolKind: "read", count: 40 }, { toolKind: "run", count: 12 }] });
    expect(runReportChipText(13 * MIN + 59_000, { stages: 6, kinds: [{ toolKind: "run", count: 12 }] }, fmt)).toBe("13분 · 단계 6 · 명령 12 · 에이전트 보고");
    expect(runReportChipText(13 * MIN, summary, fmt)).toBe("13분 · 단계 6 · 읽기 40 · 명령 12 · 에이전트 보고");
    // 합계를 모르는 서버·알린 것이 없는 일: 꼬리표가 말할 대상이 없으니 시간만 남는다. 0을 말하지 않는다.
    expect(runReportChipText(5 * MIN, runReportSummary(ledger([], {})), fmt)).toBe("5분");
    expect(runReportChipText(40_000, runReportSummary(undefined), fmt)).toBe("1분 미만");
    // 분 단위뿐이다: 초가 말해지지 않고, 한 시간부터는 시간·분이다.
    expect(runReportDurationText(125 * MIN + 30_000, fmt)).toBe("2시간 5분");
    expect(runReportChipText(13 * MIN, summary, fmt)).not.toMatch(/\d+초/);
  });
});
