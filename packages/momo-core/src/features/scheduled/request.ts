import type { CreateScheduledInput, ScheduledMessage, ScheduledPatch } from "./types";

// =============================================================================
// 요청 직렬화와 멱등 규칙 (ADR-0208 D9·D14·D16, UI 명세 0.5·0.6, #4237).
//
// 이 파일이 지키는 것 셋.
//
// 1. **생성 본문은 닫혀 있다.** 서버 스키마는 `additionalProperties: false`다. 없는 값은
//    키째 뺀다(`rootId`·`attachmentIds`·빈 `body`). `replyToId`·`routing`·`props`는 보낼 수
//    없는 값이라 이 타입에 자리가 없다.
// 2. **고칠 때는 바뀐 것만 싣는다.** 글만 고치면 `sendAtMs`를 보내지 않고, 시각만 바꾸면
//    `body`를 보내지 않는다. 이유가 둘 있다. 시각을 안 바꿨는데 보내면 남은 시간이 30~60초인
//    대기 행은 `send_at_too_soon`이 되고, 실패 행은 시각을 주면 되살아나 대기 50개에 센다
//    (명세 0.6). 그리고 서버는 본문을 준 수정과 다시 걸기에서만 「내용을 마지막으로 쓴 세션」
//    (`armed_session_id`)을 요청 세션으로 옮긴다(D14): 바뀌지 않은 본문을 함께 보내면
//    시각만 바꾼 수정이 그 세션을 가져가 버린다.
// 3. **`clientRequestId`는 요청 내용이 같을 때만 다시 쓴다.** 서버는 같은 id에 **옛 행**을
//    돌려준다(D9: 조회가 모든 검증보다 먼저다). 내용이 바뀌었는데 id가 같으면 사람이 고친
//    예약이 아니라 처음 예약이 돌아오고, 화면은 성공이라고 말한다.
// =============================================================================

/**
 * 생성 요청 본문(와이어). 필수는 `sendAtMs`와 `clientRequestId`이고, `body`는 앞뒤 공백을
 * 걷은 뒤 비어 있으면 키째 뺀다(첨부만 있는 예약). `attachmentIds`는 비어 있으면 뺀다.
 */
export function createRequestBody(input: CreateScheduledInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sendAtMs: input.sendAtMs,
    clientRequestId: input.clientRequestId,
  };
  const text = input.body?.trim() ?? "";
  if (text !== "") body.body = text;
  if (input.rootId !== undefined) body.rootId = input.rootId;
  if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
    body.attachmentIds = [...input.attachmentIds];
  }
  return body;
}

/** 수정 요청 본문(와이어): 값이 있는 키만 싣는다. */
export function patchRequestBody(patch: ScheduledPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.body !== undefined) body.body = patch.body;
  if (patch.sendAtMs !== undefined) body.sendAtMs = patch.sendAtMs;
  return body;
}

/** 고치기 대화상자가 들고 있는 값. 칸이 없는 쪽(`sessions_ended` 행의 시각)은 `undefined`다. */
export interface ScheduledEdit {
  body?: string;
  sendAtMs?: number | null;
}

/**
 * 행과 편집값을 비교해 **바뀐 것만** 담은 수정을 만든다. 아무것도 안 바뀌었으면 `null`이다
 * (요청을 보내지 않는다. 서버는 빈 수정을 400으로 거절한다).
 *
 * 본문은 앞뒤 공백을 걷은 값끼리 비교하고 걷은 값을 보낸다(생성이 걷은 본문을 저장한다).
 */
export function scheduledPatch(
  row: Pick<ScheduledMessage, "body" | "sendAtMs">,
  edit: ScheduledEdit
): ScheduledPatch | null {
  const patch: ScheduledPatch = {};
  if (edit.body !== undefined) {
    const next = edit.body.trim();
    if (next !== (row.body ?? "").trim()) patch.body = next;
  }
  if (edit.sendAtMs !== undefined && edit.sendAtMs !== null && edit.sendAtMs !== row.sendAtMs) {
    patch.sendAtMs = edit.sendAtMs;
  }
  return patch.body === undefined && patch.sendAtMs === undefined ? null : patch;
}

/**
 * 고친 글이 비어도 되는가. 글이 비고 첨부도 없으면 서버가 400 `empty_message`다. 첨부는 바꿀 수
 * 없으므로(명세 1.7) 행의 첨부 수로 판정한다.
 */
export function editBodyProblem(
  row: Pick<ScheduledMessage, "attachments">,
  body: string
): "empty" | null {
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  return body.trim() === "" && !hasAttachments ? "empty" : null;
}

// ---- clientRequestId -------------------------------------------------------------

/** 요청의 **내용**: 이 중 하나라도 다르면 다른 요청이다. 채널은 경로에 실려도 내용이다. */
export interface ScheduledRequestContent {
  workspaceId: string;
  channelId: string;
  rootId?: string;
  body: string;
  sendAtMs: number;
  /** 사람이 고른 순서다. 서버가 순서를 `position`으로 저장하므로 순서도 내용이다. */
  attachmentIds: readonly string[];
}

/** UUID는 대소문자가 섞여 오가므로(`uuidEq`) 소문자로 접어 비교한다. */
function fold(id: string): string {
  return id.toLowerCase();
}

/** 내용의 정규형. 같은 내용이면 같은 문자열이다. */
export function scheduledContentKey(content: ScheduledRequestContent): string {
  return JSON.stringify([
    fold(content.workspaceId),
    fold(content.channelId),
    content.rootId === undefined ? null : fold(content.rootId),
    content.body.trim(),
    content.sendAtMs,
    content.attachmentIds.map(fold),
  ]);
}

/** 마지막 시도의 내용 정규형과 그때 쓴 id. 컴포저가 ref로 들고 있다. */
export interface ClientRequestMemory {
  key: string;
  id: string;
}

/**
 * 이번 시도의 `clientRequestId`. 직전 시도와 **내용이 같으면** 같은 id(응답을 잃은 재시도를
 * 서버가 같은 행으로 받는다), 다르면 `newId()`로 새 id다. 호출하는 쪽이 돌려받은 값을
 * 기억해 두고, 201을 받아 입력을 비운 뒤에는 `null`로 되돌린다.
 *
 * `newId`는 호출부가 준다(`crypto.randomUUID`는 플랫폼 전역이라 코어가 직접 읽지 않는다).
 */
export function nextClientRequest(
  memory: ClientRequestMemory | null,
  content: ScheduledRequestContent,
  newId: () => string
): ClientRequestMemory {
  const key = scheduledContentKey(content);
  if (memory !== null && memory.key === key) return memory;
  return { key, id: newId() };
}
