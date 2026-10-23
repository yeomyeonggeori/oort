import type { MessageAttachment } from "../../lib/api";
import { arrayField, num, record, str, WireShapeError } from "../../lib/wire";

// =============================================================================
// 예약 메시지의 계약 타입과 와이어 파서 (ADR-0208, #4237).
//
// 모양의 정본은 `docs/api/openapi.yaml`의 `scheduled-messages` 태그와 스키마
// `ScheduledMessage` · `CreateScheduledMessageRequest` ·
// `UpdateScheduledMessageRequest`다(서버 #4214, track/engine에서 확정). enum 값은
// 엔진이 소유한다(TRACKS 1절): 여기서 값을 더하지 않고, 엔진이 더하면 이 표와
// `copy.ts`의 사유표를 함께 고친다.
//
// 파서는 던지지 않는 `lib/wire` 헬퍼 위에 서고, 필수 필드가 빠졌거나 `status`가
// 닫힌 집합 밖이면 `null`이다. 알 수 없는 `failureReason`은 행을 버리지 않고
// `not_allowed`로 읽는다(그 사유가 「정본 경로가 앞으로 더하는 다른 정책 거절」이라는
// 뜻이어서 새 사유를 모르는 구버전 클라이언트의 안전한 읽기다).
// =============================================================================

/** ADR-0208 D3. `sending`은 없다: 전송과 상태 전이가 한 트랜잭션이다. */
export const SCHEDULED_STATUSES = ["pending", "sent", "failed", "cancelled"] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];

/** ADR-0208 D8. 닫힌 집합 8종, 엔진 소유. */
export const SCHEDULED_FAILURE_REASONS = [
  "sessions_ended",
  "author_inactive",
  "missed",
  "send_error",
  "not_member",
  "root_unavailable",
  "attachment_unavailable",
  "not_allowed",
] as const;
export type ScheduledFailureReason = (typeof SCHEDULED_FAILURE_REASONS)[number];

/** 멤버·워크스페이스당 대기(`pending`) 예약 상한. 서버가 `pending_limit_reached`로 판정한다(D10). */
export const SCHEDULED_PENDING_LIMIT = 50;
/** 지금 + 60초 이상(D2). 서버는 DB 시계로 판정하고 이 값은 클라이언트의 사전 안내다. */
export const SCHEDULED_MIN_LEAD_MS = 60_000;
/** 120일 이하(D2). */
export const SCHEDULED_MAX_LEAD_MS = 120 * 24 * 60 * 60_000;
/** 마감 30초 전부터 편집은 `scheduled_too_late`다(D9). 취소·지금 보내기는 해당 없다. */
export const SCHEDULED_EDIT_LOCK_MS = 30_000;

/** openapi `ScheduledMessage`. `body`·`attachments`는 보낸·취소한 행에서 빠진다. */
export interface ScheduledMessage {
  id: string;
  workspaceId: string;
  /** 작성자. 늘 호출자 본인이다. */
  memberId: string;
  channelId: string;
  /** 스레드 답글 예약이면 그 스레드의 루트 메시지 id. */
  rootId?: string;
  body?: string;
  attachments?: MessageAttachment[];
  sendAtMs: number;
  status: ScheduledStatus;
  /** `status === "failed"`일 때만. */
  failureReason?: ScheduledFailureReason;
  /** `status === "sent"`일 때만. */
  sentMessageId?: string;
  sentAtMs?: number;
  /** `pending`일 때만. `sendAtMs - 30초`이고 서버가 판정한다(클라이언트는 힌트로 읽는다). */
  editableUntilMs?: number;
  /** 행이 바뀔 때마다 1 오른다. 개인 채널 이벤트가 같은 값을 싣는다. */
  rev: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ScheduledPage {
  scheduledMessages: ScheduledMessage[];
  nextCursor?: string;
}

/** 목록 `status` 질의. `open`(기본)은 `pending` + `failed`다. */
export type ScheduledListStatus = "open" | "pending" | "failed";

export interface ScheduledListQuery {
  channelId?: string;
  status?: ScheduledListStatus;
  cursor?: string;
  limit?: number;
}

/** openapi `CreateScheduledMessageRequest`. `clientRequestId`는 필수다(생성 재시도 멱등). */
export interface CreateScheduledInput {
  channelId: string;
  body?: string;
  sendAtMs: number;
  rootId?: string;
  attachmentIds?: readonly string[];
  clientRequestId: string;
}

/**
 * openapi `UpdateScheduledMessageRequest`. 둘 중 하나 이상. 클라이언트는 **바뀐 것만**
 * 싣는다(`request.ts`의 `scheduledPatch`): 글만 고치면 `sendAtMs`가 없고, 시각만 바꾸면
 * `body`가 없다.
 */
export interface ScheduledPatch {
  body?: string;
  sendAtMs?: number;
}

export function isScheduledStatus(value: unknown): value is ScheduledStatus {
  return (SCHEDULED_STATUSES as readonly unknown[]).includes(value);
}

export function isScheduledFailureReason(value: unknown): value is ScheduledFailureReason {
  return (SCHEDULED_FAILURE_REASONS as readonly unknown[]).includes(value);
}

/**
 * 와이어의 사유 문자열을 닫힌 집합으로 읽는다. 없으면 `undefined`, 모르는 값은
 * `not_allowed`다(머리말).
 */
export function readFailureReason(raw: unknown): ScheduledFailureReason | undefined {
  if (typeof raw !== "string") return undefined;
  return isScheduledFailureReason(raw) ? raw : "not_allowed";
}

function parseAttachment(value: unknown): MessageAttachment | null {
  const id = str(value, "id");
  const name = str(value, "name");
  const mime = str(value, "mime");
  const sizeBytes = num(value, "sizeBytes");
  if (id === undefined || name === undefined || mime === undefined || sizeBytes === undefined) {
    return null;
  }
  return { id, name, mime, sizeBytes };
}

/** 필수 필드가 빠졌거나 `status`가 닫힌 집합 밖이면 `null`이다. */
export function parseScheduledMessage(value: unknown): ScheduledMessage | null {
  const id = str(value, "id");
  const workspaceId = str(value, "workspaceId");
  const memberId = str(value, "memberId");
  const channelId = str(value, "channelId");
  const status = str(value, "status");
  const sendAtMs = num(value, "sendAtMs");
  const rev = num(value, "rev");
  const createdAtMs = num(value, "createdAtMs");
  const updatedAtMs = num(value, "updatedAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    memberId === undefined ||
    channelId === undefined ||
    !isScheduledStatus(status) ||
    sendAtMs === undefined ||
    rev === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    return null;
  }
  const row: ScheduledMessage = {
    id,
    workspaceId,
    memberId,
    channelId,
    sendAtMs,
    status,
    rev,
    createdAtMs,
    updatedAtMs,
  };
  const rootId = str(value, "rootId");
  if (rootId !== undefined) row.rootId = rootId;
  const body = str(value, "body");
  if (body !== undefined) row.body = body;
  const rawAttachments = arrayField(value, "attachments");
  if (rawAttachments !== null) {
    const attachments: MessageAttachment[] = [];
    for (const raw of rawAttachments) {
      const parsed = parseAttachment(raw);
      if (parsed === null) return null;
      attachments.push(parsed);
    }
    if (attachments.length > 0) row.attachments = attachments;
  }
  const failureReason = readFailureReason(record(value)?.failureReason);
  if (failureReason !== undefined) row.failureReason = failureReason;
  const sentMessageId = str(value, "sentMessageId");
  if (sentMessageId !== undefined) row.sentMessageId = sentMessageId;
  const sentAtMs = num(value, "sentAtMs");
  if (sentAtMs !== undefined) row.sentAtMs = sentAtMs;
  const editableUntilMs = num(value, "editableUntilMs");
  if (editableUntilMs !== undefined) row.editableUntilMs = editableUntilMs;
  return row;
}

/** `{scheduledMessage}` 응답(생성 201·수정 200·지금 보내기 200). 모양이 틀리면 던진다. */
export function parseScheduledResponse(value: unknown): ScheduledMessage {
  const row = parseScheduledMessage(record(value)?.scheduledMessage);
  if (row === null) throw new WireShapeError();
  return row;
}

/** `{scheduledMessages, nextCursor?}` 응답. 한 행이라도 읽지 못하면 던진다(리마인더와 같다). */
export function parseScheduledPage(value: unknown): ScheduledPage {
  const wrapped = arrayField(value, "scheduledMessages");
  if (wrapped === null) throw new WireShapeError();
  const scheduledMessages: ScheduledMessage[] = [];
  for (const raw of wrapped) {
    const row = parseScheduledMessage(raw);
    if (row === null) throw new WireShapeError();
    scheduledMessages.push(row);
  }
  const nextCursor = str(value, "nextCursor");
  return nextCursor === undefined ? { scheduledMessages } : { scheduledMessages, nextCursor };
}
