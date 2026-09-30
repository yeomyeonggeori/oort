import { ApiError } from "../../lib/api";
import type { MembershipRole } from "../../lib/api";
import { memberMayWriteMemory } from "./browser";
import type {
  ConsolidationRevertKind,
  MemoryItem,
  MemoryItemEvent,
  RevertedConsolidation,
} from "./model";

// =============================================================================
// 결정 타임라인과 자동 정리 이력 (ADR-0196 D4 · D12 V5, #3174).
//
// 세 가지가 이 파일을 붙든다.
//
//   1. 링크는 서버가 준 것만 쓴다. `ItemDto`에는 `closedById`·`mergedIntoId`가 없어서 「누가 누구를
//      바꿨나」는 옛 결정의 원장 사건(`superseded.superseded_by`, `merged.into`)에서만 읽는다.
//      `valid_to == valid_from`인 이웃을 찾아 짐작하지 않는다(다른 결정과 우연히 맞을 수 있다).
//   2. 되돌릴 수 있는 사건은 서버의 되돌리기 함수와 같은 규칙으로만 고른다: 진 쪽의 병합
//      (`merged` + `into`), 모순으로 닫은 기간(`superseded` + `contradiction`), 감쇠(`retired` +
//      `decayed`). 그 밖은 버튼을 그리지 않는다. 마지막 판정은 서버이고, 이미 되돌렸거나
//      상태가 바뀐 것은 409가 말한다.
//   3. 게스트는 이력을 읽기만 한다. 채널 역할이 게스트인 경우는 서버의 403이 두 번째 벽이다.
// =============================================================================

// ---- 자동 정리 안내 ------------------------------------------------------------

export const TIMELINE_VIEW_LIST = "목록";
export const TIMELINE_VIEW_TIMELINE = "결정 타임라인";
export const TIMELINE_LABEL = "결정 타임라인";
export const TIMELINE_LEAD =
  "채널의 결정이 시간에 따라 어떻게 바뀌었는지 보여 줘요. 카드를 누르면 근거와 이력이 열려요.";
export const CLEANUP_NOTE =
  "겹치거나 오래 쓰지 않은 기억은 밤사이 자동으로 정리해요. 정리한 기록은 남고, 멤버는 되돌릴 수 있어요. 이미 되돌렸거나 그 사이 상태가 바뀐 정리는 되돌릴 수 없어요.";
/** 상세 이력 위의 짧은 안내. 같은 화면에 타임라인의 긴 안내가 이미 있어서 되풀이하지 않는다. */
export const HISTORY_CLEANUP_NOTE = "정리한 기록은 남고, 멤버는 되돌릴 수 있어요.";
export const TIMELINE_EMPTY_HEADLINE = "아직 결정 기억이 없어요.";
export const TIMELINE_EMPTY_DETAIL =
  "채널에서 결정이 기억으로 남으면 바뀐 순서대로 여기에 쌓여요.";
export const TIMELINE_LOAD_ERROR = "결정 타임라인을 불러오지 못했어요.";
export const TIMELINE_LINKS_CAPPED =
  "결정이 많아서 일부는 바뀐 결정 링크를 그리지 않았어요.";
export const TIMELINE_LINKS_ERROR =
  "일부 결정의 변경 기록을 불러오지 못했어요.";
export const TIMELINE_LOAD_MORE = "결정 더 불러오기";
export const TIMELINE_LOAD_MORE_NOTE = "지금까지 불러온 결정만 그렸어요.";
export const TIMELINE_NO_SUBJECT = "주제 없음";
export const TIMELINE_ORDER_NOTE = "오래된 결정이 위, 최근 결정이 아래예요.";

export type DecisionState = "current" | "closed" | "merged" | "decayed";

export const DECISION_STATE_LABEL: Readonly<Record<DecisionState, string>> = {
  current: "지금 유효해요",
  closed: "기간이 닫혔어요",
  merged: "다른 기억에 합쳐졌어요",
  decayed: "오래 쓰지 않아 내려갔어요",
};

export function decisionStateLabel(state: DecisionState): string {
  return DECISION_STATE_LABEL[state];
}

/** 「10월 3일부터 지금까지」 / 「10월 3일 ~ 10월 9일」. 날짜 글자는 화면이 형식을 정해 넘긴다. */
export function decisionIntervalLabel(
  state: DecisionState,
  fromLabel: string,
  toLabel: string | null
): string {
  if (state === "closed" && toLabel !== null)
    return `${fromLabel} ~ ${toLabel}`;
  if (state === "current") return `${fromLabel}부터 지금까지`;
  return `${fromLabel}부터`;
}

export function replacedByLine(dateLabel: string | null): string {
  return dateLabel === null
    ? "다른 결정으로 바뀌었어요"
    : `다른 결정으로 바뀌었어요 (${dateLabel})`;
}

export const OPEN_REPLACEMENT = "바뀐 결정 보기";
export const OPEN_REPLACED = "이 결정이 바꾼 이전 결정 보기";

export function replacesLine(count: number): string {
  return count === 1
    ? "이전 결정 1개를 바꿨어요"
    : `이전 결정 ${count}개를 바꿨어요`;
}

export const MERGED_INTO_LINE = "비슷한 기억에 합쳐졌어요";
export const OPEN_MERGE_WINNER = "합쳐진 기억 보기";

// ---- 타임라인 모델 -------------------------------------------------------------

export interface TimelineEntry {
  item: MemoryItem;
  state: DecisionState;
  /** 이 결정을 바꾼 결정(닫힌 결정만). 옛 결정의 원장 사건에서만 읽는다. */
  replacedById?: string;
  /** 이 결정이 닫은 결정들(지금 불러온 것 안에서만). */
  replacesIds: string[];
  /** 합쳐져 들어간 기억(합쳐진 결정만). */
  mergedIntoId?: string;
}

export interface TimelineGroup {
  key: string;
  channelId: string;
  subjectKey?: string;
  /** 오래된 것이 먼저. */
  entries: TimelineEntry[];
}

/** 타임라인이 그리는 결정인가. 고쳐 쓰기·근거 소실로 내려간 것은 결정이 바뀐 이야기가 아니다. */
export function decisionStateOf(
  item: Pick<MemoryItem, "kind" | "retiredAtMs" | "retiredReason" | "validToMs">
): DecisionState | null {
  if (item.kind !== "decision") return null;
  if (item.retiredAtMs !== undefined) {
    if (item.retiredReason === "merged") return "merged";
    if (item.retiredReason === "decayed") return "decayed";
    return null;
  }
  return item.validToMs !== undefined ? "closed" : "current";
}

function eventString(event: MemoryItemEvent, key: string): string | undefined {
  const value = event.detail[key];
  return typeof value === "string" ? value : undefined;
}

/** 닫은 결정의 id. 되돌려진(더 새로운 `reverted`가 가리키는) 닫기는 이미 아니어서 `state`가 거른다. */
export function closerFromEvents(
  events: readonly MemoryItemEvent[]
): string | undefined {
  let found: MemoryItemEvent | undefined;
  for (const event of events) {
    if (
      event.action === "superseded" &&
      eventString(event, "reason") === "contradiction" &&
      eventString(event, "superseded_by") !== undefined &&
      (found === undefined || event.createdAtMs >= found.createdAtMs)
    ) {
      found = event;
    }
  }
  return found === undefined ? undefined : eventString(found, "superseded_by");
}

export function mergeWinnerFromEvents(
  events: readonly MemoryItemEvent[]
): string | undefined {
  let found: MemoryItemEvent | undefined;
  for (const event of events) {
    if (
      event.action === "merged" &&
      eventString(event, "into") !== undefined &&
      (found === undefined || event.createdAtMs >= found.createdAtMs)
    ) {
      found = event;
    }
  }
  return found === undefined ? undefined : eventString(found, "into");
}

/** 이 항목의 원장 사건을 읽어야 링크를 알 수 있는가(닫힌 결정·합쳐진 결정). */
export function needsEventsForLinks(item: MemoryItem): boolean {
  const state = decisionStateOf(item);
  return state === "closed" || state === "merged";
}

/**
 * 결정을 채널·주제마다 묶어 유효 시작 순으로 놓는다. `eventsByItem`은 링크를 위한 것일 뿐이라
 * 없으면 링크 없이 그대로 그린다(구간과 상태는 항목 자체에서 나온다).
 */
export function deriveDecisionTimeline(
  items: readonly MemoryItem[],
  eventsByItem: ReadonlyMap<string, readonly MemoryItemEvent[]>
): TimelineGroup[] {
  const byId = new Map<string, TimelineEntry>();
  const groups = new Map<string, TimelineGroup>();
  for (const item of items) {
    const state = decisionStateOf(item);
    if (state === null || item.spaceKind === "personal") continue;
    if (byId.has(item.id)) continue;
    const events = eventsByItem.get(item.id) ?? [];
    const entry: TimelineEntry = { item, state, replacesIds: [] };
    if (state === "closed") {
      const closer = closerFromEvents(events);
      if (closer !== undefined) entry.replacedById = closer;
    }
    if (state === "merged") {
      const winner = mergeWinnerFromEvents(events);
      if (winner !== undefined) entry.mergedIntoId = winner;
    }
    byId.set(item.id, entry);
    const key = `${item.channelId.toLowerCase()}|${item.subjectKey ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, channelId: item.channelId, entries: [] };
      if (item.subjectKey !== undefined) group.subjectKey = item.subjectKey;
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  for (const entry of byId.values()) {
    if (entry.replacedById === undefined) continue;
    byId.get(entry.replacedById)?.replacesIds.push(entry.item.id);
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.entries.sort(
      (a, b) =>
        a.item.validFromMs - b.item.validFromMs ||
        a.item.recordedAtMs - b.item.recordedAtMs
    );
  }
  // 가장 최근에 바뀐 묶음이 위로 온다.
  const latest = (group: TimelineGroup) =>
    Math.max(...group.entries.map((entry) => entry.item.validFromMs));
  out.sort((a, b) => latest(b) - latest(a) || a.key.localeCompare(b.key));
  return out;
}

// ---- 정리 이력과 되돌리기 -------------------------------------------------------

export type ConsolidationKind = "merged" | "closed" | "decayed";

export interface ConsolidationEventView {
  event: MemoryItemEvent;
  label: string;
  /** 자동 정리 사건인가(행위자 없음). */
  automatic: boolean;
  /** 서버의 되돌리기 규칙과 같은 종류인가. 아직 그대로인지는 서버가 판정한다. */
  kind: ConsolidationKind | null;
  /** 이미 사람이 되돌린 사건. */
  alreadyReverted: boolean;
}

function consolidationKindOf(event: MemoryItemEvent): ConsolidationKind | null {
  if (event.action === "merged" && eventString(event, "into") !== undefined)
    return "merged";
  if (
    event.action === "superseded" &&
    eventString(event, "reason") === "contradiction"
  ) {
    return "closed";
  }
  if (event.action === "retired" && eventString(event, "reason") === "decayed")
    return "decayed";
  return null;
}

/**
 * 사건 하나의 정리 표지. `alreadyReverted`는 같은 항목의 `reverted` 사건이 `detail.of`로 이 사건을
 * 가리킬 때 참이다. 스스로 되돌아간 경우(`of` 없음)는 여기서 알 수 없어서 서버의 409가 말한다.
 */
export function consolidationEventView(
  event: MemoryItemEvent,
  allEvents: readonly MemoryItemEvent[],
  label: string
): ConsolidationEventView {
  const kind = consolidationKindOf(event);
  return {
    event,
    label,
    automatic: event.actorMemberId === undefined,
    kind,
    alreadyReverted:
      kind !== null &&
      allEvents.some(
        (other) =>
          other.action === "reverted" && eventString(other, "of") === event.id
      ),
  };
}

export function canRevertEvent(
  view: Pick<ConsolidationEventView, "kind" | "alreadyReverted">,
  role: MembershipRole | undefined
): boolean {
  return (
    view.kind !== null && !view.alreadyReverted && memberMayWriteMemory(role)
  );
}

export const REVERT_LABEL = "되돌리기";
export const REVERT_ALREADY = "되돌렸어요";
export const REVERT_HISTORY_HEADING = "자동 정리 이력";
export const REVERT_AUTOMATIC = "자동 정리";
export const REVERT_GUEST_READONLY =
  "게스트는 정리 이력을 볼 수만 있어요. 되돌리는 건 멤버만 할 수 있어요.";
export const REVERT_OFFLINE = "연결이 끊겨 있어서 지금은 되돌릴 수 없어요.";
export const REVERT_CONFIRM_LABEL = "되돌리기";
export const REVERT_CANCEL_LABEL = "취소";
export const REVERT_BUSY = "되돌리는 중";
export const REVERT_TITLE = "이 정리를 되돌릴까요?";

export const REVERT_CONSEQUENCE: Readonly<Record<ConsolidationKind, string>> = {
  merged:
    "합쳐진 기억을 다시 따로 보이게 해요. 이긴 쪽에 옮겨 둔 근거도 원래대로 돌려요. 되돌린 뒤에는 이 둘을 자동으로 다시 합치지 않아요.",
  closed:
    "닫힌 결정을 다시 지금 유효한 결정으로 열어요. 되돌린 뒤에는 이 둘을 자동으로 다시 정리하지 않아요.",
  decayed:
    "오래 쓰지 않아 내려간 기억을 다시 살려요. 살아난 기억은 14일을 새로 얻고, 그 뒤에도 쓰이지 않으면 다시 정리될 수 있어요.",
};

export function revertSuccessMessage(kind: ConsolidationRevertKind): string {
  if (kind === "merged")
    return "합치기를 되돌렸어요. 두 기억이 다시 따로 보여요.";
  if (kind === "superseded")
    return "닫힌 기간을 되돌렸어요. 이 결정이 다시 지금 유효해요.";
  return "내려간 기억을 다시 살렸어요.";
}

export function revertedSuccessFrom(result: RevertedConsolidation): string {
  return revertSuccessMessage(result.reverted);
}

export const REVERT_FORBIDDEN_MESSAGE = "게스트는 정리를 되돌릴 수 없어요.";
export const REVERT_GONE_MESSAGE = "없는 기록이거나 볼 수 없는 기록이에요.";
/** 이미 되돌림·그 사이 바뀜·채널 기억이 꺼짐·잊은 내용이 되살아날 경우가 모두 같은 답이다. */
export const REVERT_CONFLICT_MESSAGE =
  "이미 되돌렸거나 그 사이 상태가 바뀌어서 지금은 되돌릴 수 없어요. 지금 상태를 다시 불러왔어요.";
export const REVERT_UNSUPPORTED_MESSAGE = "이 기록은 되돌릴 수 없는 종류예요.";
export const REVERT_FAILED_MESSAGE =
  "되돌리지 못했어요. 연결을 확인하고 다시 시도해 주세요.";

export interface RevertErrorView {
  message: string;
  /** 목록·이력을 다시 읽어야 하는가. */
  refetch: boolean;
  /** 이 항목이 더는 없다(또는 볼 수 없다). 상세를 닫는다. */
  gone: boolean;
}

/**
 * 403은 「게스트」, 404는 「없거나 볼 수 없음」(구분해 말하지 않는다), 409는 되돌릴 수 없는
 * 상태 전부(이미 되돌림·바뀜·스위치·억제), 422는 되돌릴 수 없는 사건 종류다.
 */
export function revertError(error: unknown): RevertErrorView {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return { message: REVERT_FORBIDDEN_MESSAGE, refetch: false, gone: false };
    }
    if (error.status === 404)
      return { message: REVERT_GONE_MESSAGE, refetch: true, gone: true };
    if (error.status === 409) {
      return { message: REVERT_CONFLICT_MESSAGE, refetch: true, gone: false };
    }
    if (error.status === 422) {
      return {
        message: REVERT_UNSUPPORTED_MESSAGE,
        refetch: false,
        gone: false,
      };
    }
  }
  return { message: REVERT_FAILED_MESSAGE, refetch: false, gone: false };
}
