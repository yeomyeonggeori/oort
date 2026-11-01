import type {
  AgentRunLedger,
  AgentRunLedgerEvent,
  AgentRunToolTally,
} from "../../lib/api";
import type { MessageKey } from "../../i18n/generated/messages";
import type { MessageService } from "../../i18n/types";
import { clockLabel } from "./runLedger";

// =============================================================================
// 작업 타임라인 행 모델 v0 (#4654, A1-U1). 레일·독·패널이 같은 행을 읽고, 웹 v1(#4657)과 폰
// 시트(#4658)가 이 위에 선다. 이 파일이 갖는 것: 행의 모양, 줄이는 규칙, 출처별로 가르는 규칙,
// 서버 합계 읽기, 그리고 그 행을 문장으로 만드는 함수. 화면은 **그리기만** 한다.
//
// ## 계약 (뒤 슬라이스가 지킬 것)
//
// 1. **행 = {id, source, kind, label, status, atMs, count}** (+ 선택 칸). 한 행은 출처가 하나다.
//
// 2. **출처는 셋이고 한 칸에 섞지 않는다.**
//      oort      서버가 직접 잰 사실(`tool_call` 호출 기록 등). 믿어도 되는 측정.
//      agent     에이전트가 스스로 보고한 것(`stage`·`activity`·`plan`). 믿지 않는 일반 텍스트.
//      computer  내 컴퓨터의 작업 세션(하네스)이 보낸 것.
//    `workTimelineSections`가 출처마다 칸(section) 하나로 가르고, 줄이는 규칙은 **같은 출처 안에서만**
//    돈다: 에이전트가 보고한 「읽기 12」와 oort가 잰 「읽기 3」은 절대 「읽기 15」가 되지 않는다.
//    ADR-0200 증보 2026-10-15 T4·증보 7 7-1·7-7(「서버가 잰 줄과 한 칸에 섞지 않아요」)의 코드화다.
//
// 3. **`label`의 뜻은 출처가 정한다.** 화면은 `workTimelineRowCopy`만 부른다.
//      oort       서버가 정한 닫힌 이름(`oort_run_event`). 사전을 거쳐야 낱말이 된다(모르는 이름은 그대로).
//      agent·computer  그들이 쓴 **신뢰하지 않는 일반 텍스트**. 항상 텍스트 노드로 그리고(마크업·ICU로
//                 해석하지 않는다), 길이를 한 번 더 자른다. 없으면 `toolKind` 낱말을 쓴다.
//
// 4. **줄이는 규칙 둘** (`foldWorkTimeline`, 같은 출처 안의 **연속한** 행만):
//      묶음   읽기·검색(`WORK_BUNDLED_TOOL_KINDS`)은 한 줄로 가라앉는다 — 「읽기 12 · 검색 3」.
//             묶음 행은 `parts: [{toolKind, n}]`에 종류별 수를 따로 들고 `count`는 그 합이다.
//             편집·실행·위임·웹·그 밖은 **개별 줄**이다(웹·그 밖의 묶음 여부는 #4657이 정한다).
//      반복   같은 oort 도구가 성공으로 이어지면 한 줄에 `count`만 늘린다 — 「진행 알리기 · 12번」.
//    **실패(`status === "failed"`)는 종류와 무관하게 개별 줄이고 묶음·반복을 끊는다**(실패는 올라오고
//    읽기는 가라앉는다). 진행 중(`running`) 행도 접지 않는다: 끝나면 그때 가라앉는다(그 움직임을
//    제자리에서 어떻게 그릴지는 #4657의 몫이다).
//
// 5. **같은 id의 뒤 행이 앞 행을 대체한다**(제자리 행). 원장은 추가 전용이라 읽는 쪽이 접는다: `id`는
//    읽을 때마다 같아야 하므로 `ordinal`(200행 상한이 흔든다)을 쓰지 않는다. oort 행의 id는
//    `oort|tool|<도구>|<시각>(|<n>)`, 활동 행(#4657)은 `agent|activity|<에이전트가 붙인 id>`로 둔다.
//    접힌 행의 id는 **첫 행의 id**라서 줄이 늘어도 자리가 그대로다.
//
// 6. **「모름」은 0이 아니다.** 서버가 `include=tools`에 답하지 않았으면(`toolTally` 부재) 합계는
//    `null`이고 `supported`는 false다: 호출이 0번이라는 뜻이 아니다. 빈 합계(`[]`)만이 「물었고 없다」다.
//
// ## 지금 만드는 행 (v0)
//   oort 출처의 `tool_call` 호출 행만 `oortToolRows`가 만든다. 에이전트 보고(`stage`·`activity`·`plan`)와
//   내 컴퓨터는 **출처·종류·문구가 이미 정해져 있고** 생산자는 #4657·#4658이 더한다 — 그 행을 만들어
//   `workTimelineSections`에 넘기면 칸·배지·접기가 그대로 동작한다. 수명주기·승인·깨움·끝 줄은 기존
//   `ledgerRows`(기록 칸)가 그대로 맡는다.
// =============================================================================

export type WorkTimelineSource = "oort" | "agent" | "computer";

/** 칸이 서는 순서(서버가 잰 것이 먼저). 이 목록에 없는 출처는 칸이 되지 못한다. */
export const WORK_TIMELINE_SOURCES: readonly WorkTimelineSource[] = [
  "oort",
  "agent",
  "computer",
];

/** 행이 무엇인가. v0은 `tool`만 만든다(위 「지금 만드는 행」). */
export type WorkTimelineKind =
  | "lifecycle"
  | "stage"
  | "tool"
  | "plan"
  | "approval"
  | "doorbell"
  | "end";

/** `kind === "tool"` 행의 하위 종류: ADR-0200 증보 7 7-1의 닫힌 일곱. */
export type WorkToolKind =
  | "run"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "other"
  | "delegate";

/**
 * `running` 진행 중 · `done` 끝남(성공이라고 단정하지 않는다) · `failed` 실패.
 * 끝난 run의 `in_progress` 활동을 `running`으로 그리지 않는 것은 읽는 쪽 규칙이다(7-7 ②).
 */
export type WorkTimelineStatus = "running" | "done" | "failed";

/** 묶음 행의 종류별 수. */
export interface WorkTimelinePart {
  toolKind: WorkToolKind;
  n: number;
}

export interface WorkTimelineRow {
  /** React 키이자 「같은 id의 뒤 행이 앞 행을 대체」의 열쇠. 위 계약 5. */
  id: string;
  source: WorkTimelineSource;
  kind: WorkTimelineKind;
  /** `kind === "tool"`일 때만. oort의 프로토콜 호출(`oort_run_event` 등)은 일의 종류가 아니라 없다. */
  toolKind?: WorkToolKind;
  /** 위 계약 3. 없으면 null. */
  label: string | null;
  status: WorkTimelineStatus;
  atMs: number;
  /** 묶음 수. 1이면 접지 않은 행이다. 묶음 행에서는 `parts`의 합이다. */
  count: number;
  /** 묶음 행에만(읽기·검색 묶음). 고정 순서 read, search. */
  parts?: readonly WorkTimelinePart[];
  /** 서버가 잰 처리 시간(ms). 접힌 행에는 두지 않는다(합계는 `toolTally`가 안다). */
  durationMs?: number;
  /** `status === "failed"`일 때 서버의 닫힌 실패 코드. 화면은 코드를 그대로 내지 않는다. */
  failureCode?: string;
}

// ---- 생산: 원장 → oort 행 -----------------------------------------------------------

/**
 * 도구 이름 → 일의 종류. 지금 행이 남는 도구(핸들이 가리키는 run의 호출)는 읽기·검색이 아니라
 * 비어 있지만, 서버가 귀속 범위를 넓히면(`oort_inbox_read` 등) 같은 규칙으로 「읽기 N」에 가라앉는다.
 */
const OORT_TOOL_KIND: Readonly<Record<string, WorkToolKind>> = {
  oort_inbox_read: "read",
  oort_conversation_read: "read",
};

/**
 * 원장의 `tool_call` 행을 oort 출처의 행으로 옮긴다. 시각순(같은 시각은 받은 순서)이고 접지 않은
 * 행이다(`foldWorkTimeline`이 접는다). 다른 종류의 원장 행은 건드리지 않는다.
 *
 * `code`가 `ok`가 아니면 실패다. 코드가 아예 없으면 **실패로 짓지 않고** 끝남으로 둔다: 서버 계약상
 * 없을 수 없지만, 없는 값으로 실패를 지어내지도 성공이라고 말하지도 않는다.
 */
export function oortToolRows(
  events: readonly AgentRunLedgerEvent[]
): WorkTimelineRow[] {
  const seen = new Map<string, number>();
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "tool_call")
    .sort((a, b) => a.event.createdAtMs - b.event.createdAtMs || a.index - b.index)
    .map(({ event }): WorkTimelineRow => {
      const tool = event.tool ?? null;
      const base = `oort|tool|${tool ?? "unknown"}|${event.createdAtMs}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const failed = event.code !== undefined && event.code !== "ok";
      const toolKind = tool === null ? undefined : OORT_TOOL_KIND[tool];
      return {
        id: n === 1 ? base : `${base}|${n}`,
        source: "oort",
        kind: "tool",
        ...(toolKind === undefined ? {} : { toolKind }),
        label: tool,
        status: failed ? "failed" : "done",
        atMs: event.createdAtMs,
        count: 1,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(failed && event.code !== undefined ? { failureCode: event.code } : {}),
      };
    });
}

// ---- 줄이기와 가르기 ----------------------------------------------------------------

/** 한 줄로 가라앉는 종류. 위 계약 4. */
export const WORK_BUNDLED_TOOL_KINDS: ReadonlySet<WorkToolKind> = new Set<WorkToolKind>([
  "read",
  "search",
]);

/** 묶음 안에서 종류가 서는 순서(「읽기 12 · 검색 3」). */
const BUNDLE_ORDER: readonly WorkToolKind[] = ["read", "search"];

/** 끝난(`done`) 읽기·검색만 묶음 후보다. 실패는 개별 줄이고 진행 중 행은 아직 가라앉지 않는다. */
function isBundleCandidate(row: WorkTimelineRow): boolean {
  return (
    row.kind === "tool" &&
    row.status === "done" &&
    row.toolKind !== undefined &&
    WORK_BUNDLED_TOOL_KINDS.has(row.toolKind)
  );
}

function partsOf(row: WorkTimelineRow): readonly WorkTimelinePart[] {
  if (row.parts !== undefined) return row.parts;
  return row.toolKind === undefined ? [] : [{ toolKind: row.toolKind, n: row.count }];
}

function mergeParts(
  a: readonly WorkTimelinePart[],
  b: readonly WorkTimelinePart[]
): WorkTimelinePart[] {
  const totals = new Map<WorkToolKind, number>();
  for (const part of [...a, ...b]) {
    totals.set(part.toolKind, (totals.get(part.toolKind) ?? 0) + part.n);
  }
  return BUNDLE_ORDER.filter((kind) => totals.has(kind)).map((toolKind) => ({
    toolKind,
    n: totals.get(toolKind) as number,
  }));
}

function withoutDuration(row: WorkTimelineRow): WorkTimelineRow {
  const copy = { ...row };
  delete copy.durationMs;
  return copy;
}

/** 읽기·검색 한 줄을 묶음 모양으로(n=1이어도 「읽기 1」). 레이블은 묶음에서 사라진다. */
function asBundle(row: WorkTimelineRow): WorkTimelineRow {
  if (row.parts !== undefined) return row;
  return { ...withoutDuration(row), label: null, parts: partsOf(row) };
}

function isRepeatable(row: WorkTimelineRow): boolean {
  return (
    row.kind === "tool" &&
    row.toolKind === undefined &&
    row.parts === undefined &&
    row.status === "done" &&
    row.label !== null
  );
}

/**
 * 줄이는 규칙(위 계약 4). **같은 출처의 연속한 행**만 합치고, 실패와 진행 중 행은 합치지 않으며,
 * 입력은 바꾸지 않는다. 출처가 다른 행 사이에서는 **어느 쪽이든 합치지 않는다**(섞인 입력도 안전).
 */
export function foldWorkTimeline(
  rows: readonly WorkTimelineRow[]
): WorkTimelineRow[] {
  const out: WorkTimelineRow[] = [];
  for (const raw of rows) {
    const row = isBundleCandidate(raw) ? asBundle(raw) : raw;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.source === row.source) {
      // 호출자가 `parts`를 미리 채워 넘긴 행도 같은 규칙을 지킨다: 끝난 묶음끼리만 잇는다. 실패·진행
      // 중인 행은 묶음에 합쳐지지 않고 개별 줄로 서서 앞뒤 묶음을 끊는다(계약 4).
      if (
        row.parts !== undefined &&
        prev.parts !== undefined &&
        row.status === "done" &&
        prev.status === "done"
      ) {
        const parts = mergeParts(prev.parts, row.parts);
        out[out.length - 1] = {
          ...prev,
          parts,
          count: parts.reduce((sum, part) => sum + part.n, 0),
        };
        continue;
      }
      if (isRepeatable(prev) && isRepeatable(row) && prev.label === row.label) {
        out[out.length - 1] = { ...withoutDuration(prev), count: prev.count + row.count };
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

export interface WorkTimelineSection {
  source: WorkTimelineSource;
  /** 같은 출처의 행만. 접은 뒤다. */
  rows: WorkTimelineRow[];
}

/**
 * 행을 **출처마다 한 칸**으로 가른다(위 계약 2). 순서는 `WORK_TIMELINE_SOURCES`, 비는 출처는 칸이
 * 없다. 접기는 칸 안에서 돌므로 다른 출처의 행이 사이에 끼어도 같은 출처의 연속한 줄은 이어서
 * 접힌다: 칸이 갈리는 순간 「연속」은 그 칸의 연속이다.
 */
export function workTimelineSections(
  rows: readonly WorkTimelineRow[]
): WorkTimelineSection[] {
  return WORK_TIMELINE_SOURCES.flatMap((source) => {
    const own = rows.filter((row) => row.source === source);
    return own.length === 0 ? [] : [{ source, rows: foldWorkTimeline(own) }];
  });
}

// ---- 서버 합계와 「oort 기록」 칸의 재료 -----------------------------------------------

export interface WorkTimelineTally {
  /** 기록된 모든 호출(행 상한 100을 넘은 것까지). `ok`+`error`의 합이다. */
  calls: number;
  failed: number;
}

/** 합계가 없으면(`toolTally` 부재) null: 「0번」이 아니라 「모름」이다(위 계약 6). */
export function workToolTally(
  tally: readonly AgentRunToolTally[] | undefined
): WorkTimelineTally | null {
  if (tally === undefined) return null;
  let calls = 0;
  let failed = 0;
  for (const row of tally) {
    calls += row.ok + row.error;
    failed += row.error;
  }
  return { calls, failed };
}

export interface WorkToolRecord {
  /**
   * 서버가 `tools`에 답했는가. 합계가 오거나 호출 행이 하나라도 있으면 true. false면 이 서버는
   * `tools`를 모른다(구 서버·400으로 물러선 읽기): 호출이 없다는 뜻이 아니다.
   */
  supported: boolean;
  tally: WorkTimelineTally | null;
  /** oort 출처의 호출 행, 접은 뒤. */
  rows: WorkTimelineRow[];
  /** 줄로 서 있는 호출 수(접기 전). 상한 문장의 숫자다. */
  listedCalls: number;
  /** 호출이 행 상한 너머까지 세어졌다(합계가 행보다 많다). */
  capped: boolean;
}

/** 원장 응답에서 「oort 기록」 칸의 재료를 만든다. 응답이 아직 없으면 「모름」이다. */
export function workToolRecord(
  ledger: Pick<AgentRunLedger, "events" | "toolTally" | "toolCallRowsCapped"> | undefined
): WorkToolRecord {
  if (ledger === undefined) {
    return { supported: false, tally: null, rows: [], listedCalls: 0, capped: false };
  }
  const listed = oortToolRows(ledger.events);
  return {
    supported: ledger.toolTally !== undefined || listed.length > 0,
    tally: workToolTally(ledger.toolTally),
    rows: foldWorkTimeline(listed),
    listedCalls: listed.length,
    capped: ledger.toolCallRowsCapped === true,
  };
}

// ---- 문장: 모든 사용자 문구는 사전을 거친다 --------------------------------------------

type Format = MessageService["formatMessage"];

type ToolWordKey = Extract<MessageKey, `timeline.workTool.${string}`>;
type FailureWordKey = Extract<MessageKey, `timeline.workRecord.failure${string}`>;
type KindWordKey = Extract<MessageKey, `timeline.workRecord.kind${string}`>;

/** 서버의 닫힌 도구 목록(`momo_mcp::TOOL_CATALOG`)을 사전 키로. 시험이 이 표의 빈틈을 잡는다. */
const TOOL_WORD: Readonly<Record<string, ToolWordKey>> = {
  oort_ping: "timeline.workTool.ping",
  oort_inbox_read: "timeline.workTool.inboxRead",
  oort_conversation_read: "timeline.workTool.conversationRead",
  oort_message_post: "timeline.workTool.messagePost",
  oort_jobs_claim: "timeline.workTool.jobsClaim",
  oort_job_start: "timeline.workTool.jobStart",
  oort_job_renew: "timeline.workTool.jobRenew",
  oort_job_release: "timeline.workTool.jobRelease",
  oort_run_event: "timeline.workTool.runEvent",
  oort_run_complete: "timeline.workTool.runComplete",
  oort_action_propose: "timeline.workTool.actionPropose",
  oort_action_initiate: "timeline.workTool.actionInitiate",
  oort_card_suggest: "timeline.workTool.cardSuggest",
  oort_action_claim_secret: "timeline.workTool.actionClaimSecret",
  oort_expression_assemble: "timeline.workTool.expressionAssemble",
};

/** 시험이 서버 목록과 이 표를 맞춰 보는 자리. */
export const KNOWN_OORT_TOOL_NAMES: readonly string[] = Object.keys(TOOL_WORD);

/** 서버의 닫힌 실패 코드(ADR-0200 증보 2026-10-15 T1, `ToolFailure` 7종). 모르는 코드는 낱말 없이 「실패」만. */
const FAILURE_WORD: Readonly<Record<string, FailureWordKey>> = {
  invalid_arguments: "timeline.workRecord.failureInvalidArguments",
  not_authorized: "timeline.workRecord.failureNotAuthorized",
  unavailable: "timeline.workRecord.failureUnavailable",
  conflict: "timeline.workRecord.failureConflict",
  already_claimed: "timeline.workRecord.failureAlreadyClaimed",
  claim_expired: "timeline.workRecord.failureClaimExpired",
  internal: "timeline.workRecord.failureInternal",
};

export const KNOWN_OORT_FAILURE_CODES: readonly string[] = Object.keys(FAILURE_WORD);

const KIND_WORD: Readonly<Record<WorkToolKind, KindWordKey>> = {
  run: "timeline.workRecord.kindRun",
  edit: "timeline.workRecord.kindEdit",
  read: "timeline.workRecord.kindRead",
  search: "timeline.workRecord.kindSearch",
  web: "timeline.workRecord.kindWeb",
  other: "timeline.workRecord.kindOther",
  delegate: "timeline.workRecord.kindDelegate",
};

/** 에이전트·하네스가 쓴 글을 화면에서 한 번 더 자르는 상한(서버도 라벨은 40자, 단계는 80자로 자른다). */
const MAX_REPORTED_LABEL_CHARS = 80;

/** 공백을 한 칸으로 줄이고 상한에서 자른다. 마크업으로 해석하지 않는다: 호출자가 텍스트 노드로 그린다. */
function reportedText(label: string | null): string | null {
  const text = (label ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length <= MAX_REPORTED_LABEL_CHARS
    ? text
    : `${chars.slice(0, MAX_REPORTED_LABEL_CHARS).join("")}…`;
}

export function workTimelineSourceLabel(source: WorkTimelineSource, formatMessage: Format): string {
  switch (source) {
    case "oort":
      return formatMessage("timeline.workRecord.sourceOort");
    case "agent":
      return formatMessage("timeline.workRecord.sourceAgent");
    case "computer":
      return formatMessage("timeline.workRecord.sourceComputer");
  }
}

/** 칸 머리 밑의 한 줄: 이 칸의 내용을 누가 말하는가. 믿음의 정도를 칸이 직접 말한다. */
export function workTimelineSourceNote(source: WorkTimelineSource, formatMessage: Format): string {
  switch (source) {
    case "oort":
      return formatMessage("timeline.workRecord.noteOort");
    case "agent":
      return formatMessage("timeline.workRecord.noteAgent");
    case "computer":
      return formatMessage("timeline.workRecord.noteComputer");
  }
}

/** 걸린 시간: 1초 밑은 ms, 1분 밑은 초(소수 한 자리), 그 위는 분·초. 서버 상한은 600초다. */
export function workToolDurationText(ms: number, formatMessage: Format): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 1000) return formatMessage("timeline.workRecord.durationMs", { ms: safe });
  // 59.95초부터는 반올림이 「60초」가 되므로 분·초로 넘긴다.
  if (safe < 59_950) {
    return formatMessage("timeline.workRecord.durationSeconds", {
      seconds: Math.round(safe / 100) / 10,
    });
  }
  const totalSeconds = Math.round(safe / 1000);
  return formatMessage("timeline.workRecord.durationMinutes", {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  });
}

function bundleLabel(parts: readonly WorkTimelinePart[], formatMessage: Format): string {
  const read = parts.find((part) => part.toolKind === "read")?.n;
  const search = parts.find((part) => part.toolKind === "search")?.n;
  if (read !== undefined && search !== undefined) {
    return formatMessage("timeline.workRecord.bundleReadSearch", { read, search });
  }
  if (read !== undefined) return formatMessage("timeline.workRecord.bundleRead", { read });
  if (search !== undefined) return formatMessage("timeline.workRecord.bundleSearch", { search });
  return formatMessage("timeline.workRecord.kindOther");
}

export interface WorkTimelineRowCopy {
  /** 줄의 이름. 묶음이면 「읽기 12 · 검색 3」. 에이전트·하네스 글은 일반 텍스트이니 텍스트로만 그린다. */
  label: string;
  /** 접힌 반복 행의 「12번」. 묶음은 이름이 이미 수를 말해서 없다. */
  repeat: string | null;
  /** 서버가 잰 처리 시간. 접힌 행에는 없다. */
  duration: string | null;
  /** 실패 이유 한 줄. 닫힌 코드만 낱말이 되고 모르는 코드는 null이다(코드를 그대로 내지 않는다). */
  failure: string | null;
  /** 실패·진행 중만 낱말이 있다. 끝남은 조용하다. */
  statusWord: string | null;
  /** 줄 옆의 때(「14:05」, 오늘이 아니면 날짜가 붙는다). */
  time: string;
}

/** 한 행을 문장으로. `nowMs`는 오늘이 아닌 줄에 날짜를 붙이는 기준이다. */
export function workTimelineRowCopy(
  row: WorkTimelineRow,
  formatMessage: Format,
  nowMs: number = row.atMs
): WorkTimelineRowCopy {
  let label: string;
  if (row.parts !== undefined) {
    label = bundleLabel(row.parts, formatMessage);
  } else if (row.source === "oort") {
    const key = row.label === null ? undefined : TOOL_WORD[row.label];
    label =
      key !== undefined
        ? formatMessage(key)
        : // 서버가 클라이언트보다 먼저 늘린 닫힌 이름은 그대로 보인다(모양이 `^oort_[a-z_]+$`로 닫혀 있다).
          (row.label ?? formatMessage("timeline.workTool.unknown"));
  } else {
    label =
      reportedText(row.label) ??
      formatMessage(KIND_WORD[row.toolKind ?? "other"]);
  }
  const failureKey = row.failureCode === undefined ? undefined : FAILURE_WORD[row.failureCode];
  return {
    label,
    repeat:
      row.parts === undefined && row.count >= 2
        ? formatMessage("timeline.workRecord.repeat", { count: row.count })
        : null,
    duration:
      row.durationMs === undefined ? null : workToolDurationText(row.durationMs, formatMessage),
    failure: row.status === "failed" && failureKey !== undefined ? formatMessage(failureKey) : null,
    statusWord:
      row.status === "failed"
        ? formatMessage("timeline.workRecord.statusFailed")
        : row.status === "running"
          ? formatMessage("timeline.workRecord.statusRunning")
          : null,
    time: clockLabel(row.atMs, nowMs),
  };
}

/** 「도구 호출 31번 · 실패 2번」. 합계를 모르면(구 서버) null. 합계는 행 상한을 넘은 호출까지 센 값이다. */
export function workToolSummaryText(
  tally: WorkTimelineTally | null,
  formatMessage: Format
): string | null {
  if (tally === null) return null;
  return tally.failed > 0
    ? formatMessage("timeline.workRecord.summaryFailed", { calls: tally.calls, failed: tally.failed })
    : formatMessage("timeline.workRecord.summary", { calls: tally.calls });
}
