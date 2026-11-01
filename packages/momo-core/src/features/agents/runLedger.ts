import type {
  AgentRunLedgerEvent,
  AgentRunProgress,
} from "../../lib/api";
import { endReasonText, isOpenRunPhase } from "./runPhase";

// =============================================================================
// runLedger: 서버의 run 이벤트 원장(ADR-0200 D2)을 작업 패널의 기록 줄로 옮기는
// 순수 함수와 문장들. 두 클라이언트(웹 패널·폰 시트)가 같은 말을 하도록 core에 둔다.
//
// 원장은 서버가 기억한다. 그래서 이 줄들은 패널을 닫아도, 다른 기기에서 열어도
// 남아 있다. 예전 패널의 「패널을 닫으면 이 기록은 사라집니다」는 클라이언트가
// 프레임을 접어 만든 기록에 대한 말이었고, 서버가 아는 run에게는 거짓이다.
//
// 이 모듈이 절대 하지 않는 말은 둘이다.
//   1. 에이전트가 보내지 않은 것을 안다는 말. 보이는 사고 과정은 에이전트가
//      `stage`로 보고한 만큼이다(`RUN_LEDGER_LIMIT_SENTENCE`).
//   2. 닫힌 코드가 아닌 것을 사유로 쓰는 말. 사유는 `endReasonText`가 아는 코드만
//      문장이 되고, 모르는 코드는 문장 없이 낱말(완료·실패…)만 남는다.
// =============================================================================

/** 원장 한 줄이 그려질 때의 어조. 색은 표면이 정한다. */
export type RunLedgerTone = "neutral" | "agent" | "action" | "end";

export interface RunLedgerRow {
  /** React 키. `ordinal`은 200행 상한 때문에 안정적이지 않아 쓰지 않는다. */
  key: string;
  atMs: number;
  kind: AgentRunLedgerEvent["kind"];
  /** 사람이 읽는 한 줄. `stage`일 때만 에이전트가 쓴 일반 텍스트다. */
  text: string;
  /** 사유 한 줄(끝난 줄에만). */
  reason?: string;
  tone: RunLedgerTone;
  /** 승인 요청 줄이 가리키는 승인. 카드로 가는 링크의 열쇠다. */
  approvalId?: string;
  /**
   * 연속한 같은 줄을 접은 수(2 이상일 때만). 깨우는 신호는 한 run에 여러 번(상한 10)
   * 올 수 있고, 같은 줄 열 개는 기록이 아니라 소음이다(#3824).
   */
  count?: number;
}

/** 깨우는 신호 줄. 우리가 보낸 신호이므로 에이전트 활동(tone agent)이 아니다. */
export const DOORBELL_SENT_TEXT = "깨우는 신호를 보냈어요";
export const DOORBELL_FAILED_TEXT = "깨우는 신호가 닿지 않았어요";
/** 이 앱이 아직 모르는 종류의 줄. 서버가 앞서 새 종류를 실었다. */
export const LEDGER_UNKNOWN_TEXT = "이 앱이 아직 모르는 기록이에요";

/** `doorbell_rung`의 `code`는 `<edge>_<result>`다. `_failed`로 끝나면 닿지 않았다. */
export function doorbellFailed(code: string | undefined): boolean {
  return code !== undefined && code.endsWith("_failed");
}

/** 에이전트가 보고한 단계의 상한(서버도 80자로 자른다). 화면에서도 한 번 더 자른다. */
const MAX_STAGE_CHARS = 80;

function stageText(stage: string | undefined): string {
  const text = (stage ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "단계를 보고했어요";
  return text.length <= MAX_STAGE_CHARS ? text : `${text.slice(0, MAX_STAGE_CHARS)}…`;
}

const APPROVAL_DECISION_TEXT: Record<string, string> = {
  approved: "승인됐어요",
  rejected: "거절됐어요",
  expired: "승인이 만료됐어요",
  cancelled: "승인 요청이 취소됐어요",
};

/**
 * 원장을 오래된 것부터 줄로 옮긴다. 서버가 이미 오래된 순으로 주지만 순서를
 * 믿지 않고 시각으로 한 번 더 정렬한다(같은 시각은 받은 순서를 지킨다).
 */
export function ledgerRows(
  events: readonly AgentRunLedgerEvent[]
): RunLedgerRow[] {
  return foldRepeats(rawLedgerRows(events));
}

/** 바로 앞 줄과 같은 깨움·모르는 줄은 한 줄로 접고 횟수를 붙인다. 시각은 첫 줄의 것이다. */
function foldRepeats(rows: RunLedgerRow[]): RunLedgerRow[] {
  const out: RunLedgerRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const foldable = row.kind === "doorbell_rung" || row.kind === "unknown";
    if (foldable && prev !== undefined && prev.kind === row.kind && prev.text === row.text) {
      out[out.length - 1] = { ...prev, count: (prev.count ?? 1) + 1 };
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * 기록 칸에 서는 줄. `tool_call`(oort가 잰 도구 호출)은 **여기에 서지 않는다**: 기록 칸은 수명주기·
 * 에이전트 단계·승인·깨움을 시간순으로 말하는 곳이고, 서버가 잰 도구 호출은 「oort 기록」 칸이
 * 따로 맡는다(`workTimeline`, #4654). 한 칸에 섞으면 출처가 다른 줄이 한 목록에 선다.
 */
type LedgerLineEvent = AgentRunLedgerEvent & {
  kind: Exclude<AgentRunLedgerEvent["kind"], "tool_call">;
};

function isLedgerLine(event: AgentRunLedgerEvent): event is LedgerLineEvent {
  return event.kind !== "tool_call";
}

function rawLedgerRows(
  events: readonly AgentRunLedgerEvent[]
): RunLedgerRow[] {
  const seen = new Map<string, number>();
  return events
    .filter(isLedgerLine)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.createdAtMs - b.event.createdAtMs || a.index - b.index)
    .map(({ event }): RunLedgerRow => {
      const base = `${event.kind}|${event.createdAtMs}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const common = {
        key: n === 1 ? base : `${base}|${n}`,
        atMs: event.createdAtMs,
        kind: event.kind,
      };
      switch (event.kind) {
        case "queued":
          return { ...common, text: "요청이 들어왔어요", tone: "neutral" };
        case "claimed":
          return { ...common, text: "에이전트가 일을 가져갔어요", tone: "neutral" };
        case "started":
          return { ...common, text: "작업을 시작했어요", tone: "agent" };
        case "stage":
          return { ...common, text: stageText(event.stage), tone: "agent" };
        case "paused":
          return { ...common, text: "일시 정지됐어요", tone: "neutral" };
        case "resumed":
          return { ...common, text: "다시 시작했어요", tone: "agent" };
        case "approval_requested":
          return {
            ...common,
            text: "승인을 요청했어요",
            tone: "action",
            ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
          };
        case "approval_decided":
          return {
            ...common,
            text:
              (event.code !== undefined
                ? APPROVAL_DECISION_TEXT[event.code]
                : undefined) ?? "승인 결정이 기록됐어요",
            tone: "neutral",
            ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
          };
        case "succeeded":
          return { ...common, text: "완료됐어요", tone: "end" };
        case "failed": {
          const reason = endReasonText(event.code);
          return { ...common, text: "실패했어요", tone: "end", ...(reason ? { reason } : {}) };
        }
        case "timed_out": {
          const reason = endReasonText(event.code);
          return {
            ...common,
            text: "시간이 초과됐어요",
            tone: "end",
            ...(reason ? { reason } : {}),
          };
        }
        case "cancelled": {
          const reason = endReasonText(event.code);
          return { ...common, text: "취소됐어요", tone: "end", ...(reason ? { reason } : {}) };
        }
        case "doorbell_rung":
          return {
            ...common,
            text: doorbellFailed(event.code) ? DOORBELL_FAILED_TEXT : DOORBELL_SENT_TEXT,
            tone: "neutral",
          };
        case "unknown":
          return { ...common, text: LEDGER_UNKNOWN_TEXT, tone: "neutral" };
      }
    });
}

/**
 * 로컬 시각 「HH:MM」. 기록 줄 옆의 때. 오늘이 아니면 날짜가 앞에 붙는다
 * (「10/12 18:20」): 하루를 넘긴 run에서 시각만 보이면 어제와 오늘이 섞인다.
 */
export function clockLabel(ms: number, nowMs: number = ms): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

// ---- 문장 --------------------------------------------------------------------

/**
 * 보이는 것의 한계(ADR-0200 D5). 한 줄이고 항상 보인다. 「실시간」「생각」을
 * 약속하지 않는다: 에이전트가 아무것도 보내지 않으면 oort는 「가져갔고 n분째
 * 보고가 없다」까지만 말할 수 있다.
 */
export const RUN_LEDGER_LIMIT_SENTENCE =
  "에이전트가 보낸 만큼만 보여요. 보내지 않은 생각은 oort도 알 수 없어요.";

/** 서버가 아는 run의 기록이 어디에 있는가. 닫아도 남는다는 사실. */
export const RUN_LEDGER_KEPT_SENTENCE =
  "이 기록은 서버에 남아 있어서 패널을 닫아도, 다른 기기에서도 볼 수 있어요.";

/** 흐르는 글(`textDelta`)은 저장하지 않는다. 늦게 연 패널에는 지나간 부분이 없다. */
export const RUN_STREAM_SENTENCE =
  "흐르는 글과 도구 호출은 저장하지 않아요. 이 패널을 연 뒤에 도착한 것만 보여요.";

/** 서버가 모르는 run(관리형·BYOA·옛 서버)의 기록이 이 화면에만 있다는 사실. */
export const RUN_LOCAL_ONLY_SENTENCE =
  "이 기록은 이 화면에만 있어요. 패널을 닫으면 사라져요.";

export interface RunEmptyState {
  headline: string;
  detail: string;
}

/**
 * 원장이 비었을 때(또는 아직 못 읽었을 때)의 안내. 수령 전과 후가 다른 말이다:
 * 아무도 가져가지 않은 run에 「진행이 없다」고 하면 에이전트가 아무것도 안 하는
 * 것처럼 읽히고, 가져간 run에 「아직 시작 전」이라고 하면 틀린다.
 */
export function runEmptyState(
  progress: Pick<AgentRunProgress, "phase" | "claimedAtMs"> | null
): RunEmptyState {
  if (progress === null) {
    return {
      headline: "아직 받은 기록이 없어요.",
      detail: "이 화면을 연 뒤에 도착한 진행이 여기에 쌓여요.",
    };
  }
  if (progress.phase === "queued") {
    return {
      headline: "아직 아무도 일을 가져가지 않았어요.",
      detail: "에이전트가 가져가면 여기에 기록이 쌓여요.",
    };
  }
  if (isOpenRunPhase(progress.phase)) {
    return {
      headline: "가져갔지만 아직 보고가 없어요.",
      detail: "에이전트가 단계를 보내면 여기에 쌓여요.",
    };
  }
  return {
    headline: "남은 기록이 없어요.",
    detail: "이 일에는 에이전트가 보고한 단계가 없었어요.",
  };
}

// ---- 여러 run을 순서대로·병렬로 ---------------------------------------------

export type RunListSection = "active" | "queue" | "done";

export interface RunListEntry {
  runId: string;
  section: RunListSection;
  progress: AgentRunProgress;
}

/** 「끝난 일」에 남기는 최근 건수. 나머지는 기록 보기에서 읽는다. */
export const RUN_LIST_DONE_LIMIT = 5;

/**
 * 한 에이전트의 한 채널 run들을 세 구역으로 나눈다.
 *
 *   active  진행 중 — 가져감·작업 중·승인 대기·일시 정지. **병렬**이다: 동시에
 *           여럿이어도 나란히 서고, 먼저 시작한 것이 위다.
 *   queue   대기열 — 아직 아무도 가져가지 않은 run. **순서**다: 서버의 순번이 곧 순서.
 *   done    끝난 일 — 최근 것이 위.
 *
 * 서버가 준 `queuePosition`을 그대로 쓴다. 클라이언트가 순번을 다시 세지 않는다.
 */
export function runList(
  rows: readonly AgentRunProgress[],
  agentMemberId: string
): RunListEntry[] {
  const agent = agentMemberId.toLowerCase();
  const mine = rows.filter((row) => row.agentMemberId === agent);
  const active = mine
    .filter(
      (row) => isOpenRunPhase(row.phase) && row.phase !== "queued"
    )
    .sort(
      (a, b) =>
        (a.startedAtMs ?? a.claimedAtMs ?? a.createdAtMs) -
        (b.startedAtMs ?? b.claimedAtMs ?? b.createdAtMs)
    );
  const queue = mine
    .filter((row) => row.phase === "queued")
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.POSITIVE_INFINITY) -
          (b.queuePosition ?? Number.POSITIVE_INFINITY) ||
        a.createdAtMs - b.createdAtMs
    );
  const done = mine
    .filter((row) => !isOpenRunPhase(row.phase))
    .sort(
      (a, b) =>
        (b.finishedAtMs ?? b.updatedAtMs) - (a.finishedAtMs ?? a.updatedAtMs)
    )
    .slice(0, RUN_LIST_DONE_LIMIT);
  const entry = (section: RunListSection) => (progress: AgentRunProgress) => ({
    runId: progress.id,
    section,
    progress,
  });
  return [
    ...active.map(entry("active")),
    ...queue.map(entry("queue")),
    ...done.map(entry("done")),
  ];
}

export const RUN_LIST_SECTION_LABEL: Readonly<Record<RunListSection, string>> = {
  active: "진행 중",
  queue: "대기열",
  done: "끝난 일",
};

export interface QueueAhead {
  /** 내가 멤버인 채널에서 이 run 앞에 서 있는 일(이름을 말해도 되는 것). */
  visible: { runId: string; channelId: string }[];
  /** 내가 볼 수 없는 채널의 일. 숫자로만 센다. */
  hiddenCount: number;
}

/**
 * 대기열 앞의 일. 서버는 앞선 run 전체를 `aheadTotal`로, 내가 멤버인 채널의 것만
 * `ahead[]`로 준다(ADR-0200 D3). 둘의 차이가 이름을 말할 수 없는 건수다.
 */
export function queueAhead(
  progress: Pick<AgentRunProgress, "aheadTotal" | "ahead">
): QueueAhead {
  const total = progress.aheadTotal ?? progress.ahead.length;
  return {
    visible: [...progress.ahead],
    hiddenCount: Math.max(0, total - progress.ahead.length),
  };
}
