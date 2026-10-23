import { num, record, str } from "../../lib/wire";
import {
  SCHEDULED_EDIT_LOCK_MS,
  isScheduledStatus,
  readFailureReason,
  type ScheduledFailureReason,
  type ScheduledMessage,
  type ScheduledStatus,
} from "./types";

// =============================================================================
// 개인 채널 이벤트 `scheduled_message.updated`와 `rev` 병합 (ADR-0208 D12, #4237).
//
// 채널은 `user:read-state#<MEMBER>`(`readStateRailChannelName`)이고 프레임은 id·상태·시각만
// 싣는다. **본문·첨부 이름은 싣지 않는다**: 클라이언트는 이벤트로 목록을 무효화하고 `GET`으로
// 보강한다(유실은 다음 `GET`이 복구하고 정본은 PG다).
//
//   data: { type: "scheduled_message.updated", v: 1, ts, payload: {
//     workspace_id, member_id, scheduled_message_id, channel_id,   // 대문자 UUID
//     status, send_at_ms, rev, failure_reason?, sent_message_id? } }
//
// 병합은 코어가 한 벌만 갖는다. 웹은 이벤트와 목록을 둘 다 받고, 폰은 목록(재조회)과 자기
// 쓰기의 응답만 받는데, 둘 다 같은 규칙으로 합쳐야 한 화면이 다른 화면과 갈라지지 않는다.
//
//   1. **`rev`가 더 클 때만 반영한다.** 같거나 작으면 무시한다(중복 전달·늦게 온 옛 이벤트).
//   2. **UUID는 대소문자를 접어 같은 행으로 본다.** 이벤트는 대문자, REST는 소문자로 온다.
//   3. **닫힌 행(보냄·취소·지움)은 묘비를 남긴다.** 목록에서 사라진 행을 늦게 온 옛 `pending`
//      이벤트나 옛 목록이 되살리지 못한다.
//   4. **본문이 없는 이벤트로도 화면이 즉시 바뀐다.** 아는 행은 상태·시각을 그 자리에서 고치고,
//      모르는 행은 본문 없는 **뼈대 행**으로 세운다. 그래서 `sessions_ended`로 멈춘 예약이
//      이벤트가 도착한 즉시 「보내지 못함」 구역·채널 배너(실패 어조)·사이드바 알약에 잡힌다
//      (owner 결정 ⑥의 조건). 본문은 뒤따르는 `GET`이 채운다.
// =============================================================================

/** 프레임의 `type`. */
export const SCHEDULED_MESSAGE_EVENT = "scheduled_message.updated";

/** 이벤트가 싣는 것 전부. 본문·첨부 이름은 없다. id는 와이어 그대로(대문자)다. */
export interface ScheduledMessageFrame {
  workspaceId: string;
  memberId: string;
  scheduledMessageId: string;
  channelId: string;
  status: ScheduledStatus;
  sendAtMs: number;
  rev: number;
  /** `status === "failed"`일 때. */
  failureReason?: ScheduledFailureReason;
  /** `status === "sent"`일 때. */
  sentMessageId?: string;
  /** 프레임의 `ts`가 읽히면 그 시각(밀리초). */
  tsMs?: number;
}

/** `ts`는 에포크 밀리초 숫자이거나 날짜 문자열일 수 있다. 읽지 못하면 `undefined`다. */
function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 개인 채널의 발행물이 예약 신호인가. 알 수 없는 모양(다른 `type`, 필수 키 없음, 닫힌 집합 밖의
 * `status`, 정수가 아닌 `rev`)은 `null`이다. 같은 채널의 인박스·read-state 프레임은
 * `asInboxEvent`가 읽으므로 이 함수는 그것들에 `null`을 돌려준다.
 */
export function asScheduledMessageFrame(data: unknown): ScheduledMessageFrame | null {
  const frame = record(data);
  if (str(frame, "type") !== SCHEDULED_MESSAGE_EVENT) return null;
  const payload = record(frame?.payload);
  const workspaceId = str(payload, "workspace_id");
  const memberId = str(payload, "member_id");
  const scheduledMessageId = str(payload, "scheduled_message_id");
  const channelId = str(payload, "channel_id");
  const status = str(payload, "status");
  const sendAtMs = num(payload, "send_at_ms");
  const rev = num(payload, "rev");
  if (
    workspaceId === undefined ||
    memberId === undefined ||
    scheduledMessageId === undefined ||
    channelId === undefined ||
    !isScheduledStatus(status) ||
    sendAtMs === undefined ||
    rev === undefined ||
    !Number.isInteger(rev) ||
    rev < 0
  ) {
    return null;
  }
  const out: ScheduledMessageFrame = {
    workspaceId,
    memberId,
    scheduledMessageId,
    channelId,
    status,
    sendAtMs,
    rev,
  };
  const failureReason = readFailureReason(payload?.failure_reason);
  if (failureReason !== undefined) out.failureReason = failureReason;
  const sentMessageId = str(payload, "sent_message_id");
  if (sentMessageId !== undefined) out.sentMessageId = sentMessageId;
  const tsMs = readTimestampMs(frame?.ts);
  if (tsMs !== undefined) out.tsMs = tsMs;
  return out;
}

// ---- 병합 스토어 --------------------------------------------------------------------

/**
 * 열린 행(`pending` + `failed`)과 닫힌 행의 묘비. 이 값은 화면의 수명(세션 동안)만큼 산다.
 * 불변이고 모든 함수가 새 스토어를 돌려준다.
 */
export interface ScheduledStore {
  readonly rows: readonly ScheduledMessage[];
  /** 닫힌 행(보냄·취소·지움)의 마지막 `rev`. 키는 소문자 id다. */
  readonly closed: Readonly<Record<string, number>>;
}

export const EMPTY_SCHEDULED_STORE: ScheduledStore = { rows: [], closed: {} };

/** 와이어의 id는 대소문자가 섞여 오가므로(`uuidEq`) 소문자로 접은 키로 같은 행을 찾는다. */
function idKey(id: string): string {
  return id.toLowerCase();
}

function findRow(store: ScheduledStore, key: string): ScheduledMessage | undefined {
  return store.rows.find((row) => idKey(row.id) === key);
}

/** 이 id에 대해 지금까지 본 가장 큰 `rev`(열린 행이든 묘비든). 처음 보는 id면 `undefined`. */
function knownRev(store: ScheduledStore, key: string): number | undefined {
  const row = findRow(store, key);
  const closed = store.closed[key];
  if (row === undefined) return closed;
  return closed === undefined ? row.rev : Math.max(row.rev, closed);
}

function upsertRow(store: ScheduledStore, row: ScheduledMessage): ScheduledStore {
  const key = idKey(row.id);
  const index = store.rows.findIndex((existing) => idKey(existing.id) === key);
  const rows =
    index === -1
      ? [...store.rows, row]
      : store.rows.map((existing, at) => (at === index ? row : existing));
  return { rows, closed: store.closed };
}

function closeRow(store: ScheduledStore, key: string, rev: number): ScheduledStore {
  const previous = store.closed[key];
  return {
    rows: store.rows.filter((row) => idKey(row.id) !== key),
    closed: { ...store.closed, [key]: previous === undefined ? rev : Math.max(previous, rev) },
  };
}

/** 이벤트가 알려 주는 대로 아는 행의 필드를 고친다. 본문·첨부는 이벤트에 없으니 그대로 둔다. */
function patchRowFromFrame(row: ScheduledMessage, frame: ScheduledMessageFrame): ScheduledMessage {
  // 열린 행에는 보낸 흔적이 없다. 상태가 바뀌면 상태에 딸린 필드도 함께 갈아 끼운다.
  const {
    failureReason: _failureReason,
    sentMessageId: _sentMessageId,
    sentAtMs: _sentAtMs,
    editableUntilMs: _editableUntilMs,
    ...rest
  } = row;
  // 행의 채널은 바뀌지 않는다: 이벤트의 대문자 id로 덮어 써서 REST의 소문자 id와 갈라놓지 않는다.
  const next: ScheduledMessage = {
    ...rest,
    status: frame.status,
    sendAtMs: frame.sendAtMs,
    rev: frame.rev,
  };
  if (frame.tsMs !== undefined) next.updatedAtMs = frame.tsMs;
  if (frame.status === "failed") {
    const reason = frame.failureReason ?? row.failureReason;
    if (reason !== undefined) next.failureReason = reason;
  } else if (frame.status === "pending") {
    next.editableUntilMs = frame.sendAtMs - SCHEDULED_EDIT_LOCK_MS;
  }
  return next;
}

/**
 * 모르는 행의 **뼈대 행**: 본문·첨부 없이 목록·배너·알약의 개수를 세울 수 있는 만큼만 갖는다. id는 REST가
 * 쓰는 소문자로 접는다(대문자 id로 서 있다가 뒤따르는 `GET`의 소문자 행으로 바뀌며 행의 키가 달라져
 * 다시 그려지지 않게).
 */
function stubFromFrame(frame: ScheduledMessageFrame): ScheduledMessage {
  const stamp = frame.tsMs ?? 0;
  const stub: ScheduledMessage = {
    id: idKey(frame.scheduledMessageId),
    workspaceId: idKey(frame.workspaceId),
    memberId: idKey(frame.memberId),
    channelId: idKey(frame.channelId),
    status: frame.status,
    sendAtMs: frame.sendAtMs,
    rev: frame.rev,
    createdAtMs: stamp,
    updatedAtMs: stamp,
  };
  if (frame.status === "failed" && frame.failureReason !== undefined) {
    stub.failureReason = frame.failureReason;
  }
  if (frame.status === "pending") stub.editableUntilMs = frame.sendAtMs - SCHEDULED_EDIT_LOCK_MS;
  return stub;
}

/** 열린 행인데 본문이 아직 없다: 이벤트로만 안 행이라 `GET`이 채울 때까지 내용을 보이지 않는다. */
export function isScheduledStub(row: ScheduledMessage): boolean {
  return (row.status === "pending" || row.status === "failed") && row.body === undefined;
}

export interface ScheduledEventResult {
  store: ScheduledStore;
  /** 목록을 다시 읽어야 한다(본문이 바뀌었을 수 있다). 무시한 이벤트와 닫힘 이벤트는 `false`. */
  refetch: boolean;
}

/**
 * 이벤트 한 건을 스토어에 합친다. `rev`가 이미 아는 값 이하이면 무시한다. 닫힘(`sent`·`cancelled`)은
 * 행을 지우고 묘비를 남기며, 열림(`pending`·`failed`)은 아는 행을 고치거나 뼈대 행을 세우고
 * 재조회를 요청한다.
 */
export function applyScheduledEvent(
  store: ScheduledStore,
  frame: ScheduledMessageFrame
): ScheduledEventResult {
  const key = idKey(frame.scheduledMessageId);
  const known = knownRev(store, key);
  if (known !== undefined && frame.rev <= known) return { store, refetch: false };
  if (frame.status === "sent" || frame.status === "cancelled") {
    return { store: closeRow(store, key, frame.rev), refetch: false };
  }
  const existing = findRow(store, key);
  const next = existing === undefined ? stubFromFrame(frame) : patchRowFromFrame(existing, frame);
  return { store: upsertRow(store, next), refetch: true };
}

/**
 * 내 쓰기의 응답 행(생성 201·수정 200·지금 보내기 200)을 합친다. 응답은 행의 전체 모양이라
 * 같은 `rev`면 뼈대 행을 대신한다. 더 작은 `rev`는 무시한다.
 */
export function applyScheduledRow(store: ScheduledStore, row: ScheduledMessage): ScheduledStore {
  const key = idKey(row.id);
  const known = knownRev(store, key);
  if (known !== undefined && row.rev < known) return store;
  if (row.status === "sent" || row.status === "cancelled") return closeRow(store, key, row.rev);
  return upsertRow(store, row);
}

/** 지우기가 204로 끝났다. 취소 이벤트의 `rev`를 모르니 어떤 이벤트도 되살리지 못하게 막는다. */
export function removeScheduledRow(store: ScheduledStore, id: string): ScheduledStore {
  return closeRow(store, idKey(id), Number.MAX_SAFE_INTEGER);
}

/**
 * **필터 없는 열린 목록** 응답을 스토어에 합친다. 목록에 없는 행은 더 이상 열려 있지 않다고
 * 본다(보냈거나 취소했다): 그 행을 스토어에서 뺀다. 같은 행의 옛 스냅샷이 이벤트가 이미 올려 둔
 * 상태를 되돌리지는 못한다(더 큰 `rev`를 지킨다). 채널로 거른 응답에는 쓰지 말고 `applyScheduledRow`로
 * 한 행씩 합친다 — 거른 목록의 부재는 닫힘이 아니다.
 */
export function applyScheduledList(
  store: ScheduledStore,
  fetched: readonly ScheduledMessage[]
): ScheduledStore {
  let next: ScheduledStore = { rows: [], closed: store.closed };
  for (const row of fetched) {
    const key = idKey(row.id);
    const closedRev = store.closed[key];
    if (closedRev !== undefined && row.rev <= closedRev) continue;
    if (row.status === "sent" || row.status === "cancelled") {
      next = closeRow(next, key, row.rev);
      continue;
    }
    const existing = findRow(store, key);
    next = upsertRow(next, existing !== undefined && existing.rev > row.rev ? existing : row);
  }
  return next;
}
