import type {
  AgentRunActivityTally,
  AgentRunLedger,
  AgentRunLedgerEvent,
} from "../../lib/api";
import type { MessageKey } from "../../i18n/generated/messages";
import type { MessageService } from "../../i18n/types";
import { workPlanProgress, type WorkPlanProgress } from "../work/workPlan";
import {
  foldWorkTimeline,
  type WorkTimelineRow,
  type WorkTimelineStatus,
  type WorkToolKind,
} from "./workTimeline";

// =============================================================================
// 「에이전트 보고」 칸의 재료 (#4657, A1-U2). 에이전트가 `oort_run_event`로 스스로 알린 활동(`activities[]`)과
// 계획(`plan[]`)을 코어 타임라인 행 모델(`workTimeline`) 위의 행으로 옮긴다. 새 행 모델을 만들지 않는다:
// 이 파일이 만드는 것은 `source: "agent"` 행이고, 칸 가르기·묶음 접기는 `workTimeline`이 그대로 맡는다.
// 폰 시트(#4658)가 같은 함수를 부른다.
//
// ## 지키는 것 (ADR-0200 증보 7 7-7)
//
// 1. **에이전트 자기 보고다.** 라벨·계획 글은 믿지 않는 일반 텍스트이고, 서버가 잰 줄(`tool_call`)과 한
//    칸에 섞지 않는다(`workTimelineSections`가 출처로 가른다). 합계(`activityTally`)도 oort가 센 값이 아니다.
// 2. **끝난 run의 `in_progress` 활동은 진행 중으로 그리지 않는다.** 서버는 상태를 바꾸지 않는다(원장은
//    사실의 기록이다). 읽는 쪽이 `unclosed`(끝 보고 없음)로 그린다. 묶음·반복에도 들어가지 않는다.
// 3. **「모름」은 0이 아니다.** `activityTally` 부재 = 이 서버는 `include=activity`를 모른다(보고가 없다는
//    뜻이 아니다). 빈 배열만이 「물었고 끝난 활동이 없다」다.
// 4. **같은 id의 뒤 행이 앞 행을 대체한다**(제자리 행). 행의 id는 에이전트가 붙인 활동 id(`agent|activity|a1`)라
//    상태가 바뀌어도 자리와 열쇠가 같다. 자리는 그 활동의 **첫 보고 시각**(`startedAtMs`)이 정한다: 마지막
//    갱신 시각(`createdAtMs`)으로 줄을 세우면 활동이 갱신될 때마다 줄이 아래로 내려간다.
// 5. **계획은 행이 아니다.** 서버가 최신 계획 하나만 주고 첫 보고 시각을 모르니 타임라인에 자리를 못 잡는다.
//    계획 블록(`WorkPlanProgress`)으로 따로 선다: 합계는 작업 세션 독(#4578)과 같은 함수(`workPlanProgress`)다.
// =============================================================================

// ---- 종류 --------------------------------------------------------------------

/**
 * 서버가 먼저 늘릴 수 있는 문자열(`AgentRunActivity.kind`)을 우리 종류로. **`Map`이어야 한다**: 객체 조회는
 * `constructor`·`toString` 같은 낱말에 함수를 돌려준다. 모르는 낱말은 「그 밖」이다(없는 종류를 짓지 않는다).
 */
const ACTIVITY_KIND: ReadonlyMap<string, WorkToolKind> = new Map<string, WorkToolKind>([
  ["run", "run"],
  ["edit", "edit"],
  ["read", "read"],
  ["search", "search"],
  ["web", "web"],
  ["other", "other"],
  ["delegate", "delegate"],
]);

export function activityToolKind(kind: string): WorkToolKind {
  return ACTIVITY_KIND.get(kind) ?? "other";
}

/** 합계·요약에서 종류가 서는 순서(서버 `activityTally`의 순서와 같다). */
export const ACTIVITY_KIND_ORDER: readonly WorkToolKind[] = [
  "run",
  "edit",
  "read",
  "search",
  "web",
  "other",
  "delegate",
];

// ---- 생산: 원장 → 에이전트 보고 행 ---------------------------------------------------

/**
 * 원장의 `activity` 행을 에이전트 출처의 행으로. 서버가 id별 최신 한 줄만 주지만 같은 id가 겹쳐 오면 **더 늦게
 * 갱신된 쪽**이 이긴다(같은 열쇠가 두 줄이 되지 않는다). 순서는 첫 보고 시각, 같으면 받은 순서다.
 *
 * `open`이 거짓이면(끝난 run) `in_progress`는 `unclosed`다. 서버가 아는 상태 낱말이 아닌 값도 「끝났다」고
 * 단정하지 않는다: 열린 run이면 진행 중, 끝난 run이면 끝 보고 없음이다.
 */
export function agentActivityRows(
  events: readonly AgentRunLedgerEvent[],
  open: boolean
): WorkTimelineRow[] {
  const newest = new Map<string, { event: AgentRunLedgerEvent; index: number }>();
  events.forEach((event, index) => {
    const activity = event.kind === "activity" ? event.activity : undefined;
    if (activity === undefined) return;
    const prev = newest.get(activity.id);
    if (prev === undefined || event.createdAtMs >= prev.event.createdAtMs) {
      newest.set(activity.id, { event, index });
    }
  });
  return [...newest.values()]
    .sort(
      (a, b) =>
        (a.event.activity?.startedAtMs ?? 0) - (b.event.activity?.startedAtMs ?? 0) || a.index - b.index
    )
    .flatMap(({ event }): WorkTimelineRow[] => {
      const activity = event.activity;
      if (activity === undefined) return [];
      const status: WorkTimelineStatus =
        activity.status === "failed"
          ? "failed"
          : activity.status === "completed"
            ? "done"
            : open
              ? "running"
              : "unclosed";
      return [
        {
          id: `agent|activity|${activity.id}`,
          source: "agent",
          kind: "tool",
          toolKind: activityToolKind(activity.kind),
          label: activity.label ?? null,
          status,
          atMs: activity.startedAtMs,
          count: activity.n,
        },
      ];
    });
}

/** 종류별로 끝난(`completed`+`failed`) 단위 합. 서버의 `activityTally`를 우리 종류로 옮긴 것이다. */
export interface WorkActivityTally {
  toolKind: WorkToolKind;
  completed: number;
  failed: number;
}

/** 같은 종류 낱말이 둘로 오면 더한다(서버가 낱말을 먼저 늘려 둘이 「그 밖」으로 접힐 수 있다). */
function tallyKinds(tally: readonly AgentRunActivityTally[]): WorkActivityTally[] {
  const totals = new Map<WorkToolKind, { completed: number; failed: number }>();
  for (const entry of tally) {
    const toolKind = activityToolKind(entry.kind);
    const prev = totals.get(toolKind) ?? { completed: 0, failed: 0 };
    totals.set(toolKind, {
      completed: prev.completed + entry.completed,
      failed: prev.failed + entry.failed,
    });
  }
  return ACTIVITY_KIND_ORDER.flatMap((toolKind) => {
    const total = totals.get(toolKind);
    return total === undefined ? [] : [{ toolKind, ...total }];
  });
}

export interface WorkActivityRecord {
  /**
   * 서버가 `activity`에 답했는가. 합계가 오거나 활동·계획 행이 하나라도 있으면 true. false면 이 서버는
   * `include=activity`를 모른다: 에이전트가 아무것도 알리지 않았다는 뜻이 아니다.
   */
  supported: boolean;
  /** 에이전트 출처의 활동 행, 접은 뒤. */
  rows: WorkTimelineRow[];
  /** 최신 계획의 합계. 계획이 없거나 비었으면 null(빈 계획은 어디에도 「0단계」로 그려지지 않는다). */
  plan: WorkPlanProgress | null;
  /** 끝난 활동의 종류별 합계(행 상한을 넘은 것까지). 모르면 null. */
  tally: readonly WorkActivityTally[] | null;
  /** 합계가 보이는 끝난 활동보다 커서 일부는 합계로만 남았다. */
  trimmed: boolean;
}

export interface WorkActivityOptions {
  /** 이 run이 아직 열려 있는가(진행 중 활동을 진행 중으로 그려도 되는가). */
  open: boolean;
  /** 서버가 `running`이라고 말하는가. 계획의 「지금 단계」를 세울 자격이다. */
  working: boolean;
}

/** 원장 응답에서 「에이전트 보고」 칸의 재료를 만든다. 응답이 아직 없으면 「모름」이다. */
export function workActivityRecord(
  ledger: Pick<AgentRunLedger, "events" | "activityTally" | "activityRowsTrimmed"> | undefined,
  options: WorkActivityOptions
): WorkActivityRecord {
  if (ledger === undefined) {
    return { supported: false, rows: [], plan: null, tally: null, trimmed: false };
  }
  const listed = agentActivityRows(ledger.events, options.open);
  const planRow = ledger.events
    .filter((event) => event.kind === "plan" && event.plan !== undefined)
    .reduce<AgentRunLedgerEvent | undefined>(
      (best, event) => (best === undefined || event.createdAtMs >= best.createdAtMs ? event : best),
      undefined
    );
  const plan = workPlanProgress(
    (planRow?.plan ?? []).map((step) => ({
      content: step.text,
      status:
        step.status === "completed" || step.status === "in_progress" ? step.status : "pending",
    })),
    options.working
  );
  return {
    supported: ledger.activityTally !== undefined || listed.length > 0 || planRow !== undefined,
    rows: foldWorkTimeline(listed),
    plan,
    tally: ledger.activityTally === undefined ? null : tallyKinds(ledger.activityTally),
    trimmed: ledger.activityRowsTrimmed === true,
  };
}

// ---- 요약: 끝난 요청의 한 줄 (「13분 · 단계 6 · 명령 12 · 에이전트 보고」) ----------------------

export interface RunReportSummary {
  /** 원장에 남은 `stage` 행 수(서버가 같은 글을 접고 200행 상한이 오래된 것을 지우므로 센 값의 하한이다). */
  stages: number;
  /** 에이전트가 끝냈다고 알린 단위가 많은 종류부터 둘까지(같으면 종류 순서). 그 밖은 패널이 말한다. */
  kinds: readonly { toolKind: WorkToolKind; count: number }[];
}

/** 요약 한 줄이 말하는 종류의 수. 한 줄(24px)에 들어가야 해서 둘까지다. */
export const RUN_REPORT_SUMMARY_KINDS = 2;

/**
 * 끝난 run의 요약 재료. **에이전트가 말한 것만** 센다: 단계는 에이전트가 보고한 `stage` 행, 종류별 수는
 * `activityTally`다. oort가 잰 도구 호출(`tool_call`)은 출처가 달라 한 줄에 섞지 않는다(#4654). 합계를 모르는
 * 서버(`activityTally` 부재)는 종류가 비어 「0」이라고 말하지 않고 그 칸을 뺀다.
 */
export function runReportSummary(
  ledger: Pick<AgentRunLedger, "events" | "activityTally"> | undefined
): RunReportSummary {
  if (ledger === undefined) return { stages: 0, kinds: [] };
  const kinds = tallyKinds(ledger.activityTally ?? [])
    .map(({ toolKind, completed, failed }) => ({ toolKind, count: completed + failed }))
    .filter((entry) => entry.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        ACTIVITY_KIND_ORDER.indexOf(a.toolKind) - ACTIVITY_KIND_ORDER.indexOf(b.toolKind)
    )
    .slice(0, RUN_REPORT_SUMMARY_KINDS);
  return { stages: ledger.events.filter((event) => event.kind === "stage").length, kinds };
}

// ---- 문장: 모든 사용자 문구는 사전을 거친다 -----------------------------------------------

type Format = MessageService["formatMessage"];

const SUMMARY_KIND_WORD: Readonly<Record<WorkToolKind, Extract<MessageKey, `timeline.workSummary.kind${string}`>>> = {
  run: "timeline.workSummary.kindRun",
  edit: "timeline.workSummary.kindEdit",
  read: "timeline.workSummary.kindRead",
  search: "timeline.workSummary.kindSearch",
  web: "timeline.workSummary.kindWeb",
  other: "timeline.workSummary.kindOther",
  delegate: "timeline.workSummary.kindDelegate",
};

/**
 * 걸린 시간: 분 단위뿐이다(초 단위 숫자 없음). 1분 밑은 「1분 미만」, 한 시간부터는 「2시간 5분」. 초를 말하지 않는
 * 이유는 끝난 일의 요약이 시계가 아니라서다(읽는 사람이 쓸 데가 없는 숫자이고 `RequestThoughtLine`의 옛 요약도
 * 같은 규칙이었다).
 */
export function runReportDurationText(durationMs: number, formatMessage: Format): string {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return formatMessage("timeline.workSummary.durationShort");
  if (minutes < 60) return formatMessage("timeline.workSummary.duration", { minutes });
  return formatMessage("timeline.workSummary.durationHours", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/**
 * 「13분 · 단계 6 · 명령 12 · 에이전트 보고」를 **몸과 꼬리표로 나눠** 준다. 꼬리표 「에이전트 보고」는 앞의 숫자가 누구의
 * 말인지를 말하는 출처라서, 좁은 칸에서 몸이 잘려도 꼬리표는 남아야 한다(#5174 L6): 화면이 둘을 따로 그린다.
 * 꼬리표는 에이전트 보고 숫자(단계·종류)가 하나라도 있을 때만 있다: 걸린 시간은 서버 시계의 사실이고, 그 뒤의 숫자는
 * 에이전트가 한 말이다. 숫자가 없으면 시간만 남는다(꼬리표가 말할 대상이 없다).
 */
export function runReportChipParts(
  durationMs: number,
  summary: RunReportSummary,
  formatMessage: Format
): { body: string; tail: string | null } {
  const parts = [runReportDurationText(durationMs, formatMessage)];
  if (summary.stages > 0) {
    parts.push(formatMessage("timeline.workSummary.stages", { count: summary.stages }));
  }
  for (const entry of summary.kinds) {
    parts.push(formatMessage(SUMMARY_KIND_WORD[entry.toolKind], { count: entry.count }));
  }
  const reported = summary.stages > 0 || summary.kinds.length > 0;
  return {
    body: parts.join(" · "),
    tail: reported ? formatMessage("timeline.workSummary.agentReported") : null,
  };
}

/** 「13분 · 단계 6 · 명령 12 · 에이전트 보고」. 몸과 꼬리표를 한 줄로 이은 글(접근성 이름·폰이 읽는다). */
export function runReportChipText(
  durationMs: number,
  summary: RunReportSummary,
  formatMessage: Format
): string {
  const { body, tail } = runReportChipParts(durationMs, summary, formatMessage);
  return tail === null ? body : `${body} · ${tail}`;
}

/** 칸 아래의 합계 한 줄: 「끝난 활동 합계 · 명령 12 · 읽기 30」. 끝난 활동이 없으면 null. */
export function workActivityTallyText(
  tally: readonly WorkActivityTally[] | null,
  formatMessage: Format
): string | null {
  if (tally === null) return null;
  const parts = tally
    .filter((entry) => entry.completed + entry.failed > 0)
    .map((entry) =>
      formatMessage(SUMMARY_KIND_WORD[entry.toolKind], { count: entry.completed + entry.failed })
    );
  return parts.length === 0
    ? null
    : formatMessage("timeline.workReport.tally", { parts: parts.join(" · ") });
}
