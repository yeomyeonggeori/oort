import { authedRequest } from "../../lib/api";
import { createRequestBody, patchRequestBody } from "./request";
import {
  parseScheduledPage,
  parseScheduledResponse,
  type CreateScheduledInput,
  type ScheduledListQuery,
  type ScheduledMessage,
  type ScheduledPage,
  type ScheduledPatch,
} from "./types";

// =============================================================================
// 예약 메시지 REST 클라이언트 (ADR-0208 부록 A, openapi `scheduled-messages`, #4237).
//
//   POST   /v1/workspaces/{ws}/channels/{ch}/scheduled-messages   201 {scheduledMessage}
//   GET    /v1/workspaces/{ws}/scheduled-messages                 200 {scheduledMessages, nextCursor?}
//   PATCH  /v1/workspaces/{ws}/scheduled-messages/{id}            200 {scheduledMessage}
//   POST   /v1/workspaces/{ws}/scheduled-messages/{id}/send-now   200 {scheduledMessage}
//   DELETE /v1/workspaces/{ws}/scheduled-messages/{id}            204
//
// 서버는 #4214(PR #4257)가 track/engine에 들였다. 이 파일의 시험은 fetch를 대신하고, 살아 있는
// 서버와의 적합성은 main 승격 뒤에 잰다(`runtime-unverified`).
//
// ## 전송 길
// 공용 `authedRequest`(`lib/api`)다. 401이 한 번 회전하고, **같은 본문 문자열**로 다시 보내므로
// `clientRequestId`가 재시도에도 같다(서버가 같은 행으로 받는다). 리마인더·설정의 사설 전송은
// 회전을 건너뛰고 `error.code`를 버리는 쪽이 있어 쓰지 않는다. 비 2xx는 `ApiError(status,
// message, code)`로 던진다: 서버 문장(영어)이 아니라 상태와 코드로 `errors.ts`가 문장을 고른다.
// 404를 이 층에서 삼키지 않는다 — 목록의 404만 「표면 없음」이다(`isScheduledAbsent`).
// =============================================================================

function workspaceBase(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function itemPath(workspaceId: string, scheduledId: string): string {
  return `${workspaceBase(workspaceId)}/scheduled-messages/${encodeURIComponent(scheduledId)}`;
}

/** 목록 경로. 없는 질의는 키째 뺀다(서버 기본값이 `status=open`, `limit=50`이다). */
export function scheduledListPath(workspaceId: string, query: ScheduledListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.channelId !== undefined) params.set("channelId", query.channelId);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const text = params.toString();
  return `${workspaceBase(workspaceId)}/scheduled-messages${text === "" ? "" : `?${text}`}`;
}

/**
 * 내 예약 한 쪽. **이 서버에 예약이 없으면 404를 던진다**: 첫 목록 요청의 404만 「표면 없음」으로
 * 읽고(`isScheduledAbsent`) 입구를 세우지 않는다. 5xx·네트워크 오류는 없는 서버가 아니라
 * 장애다.
 */
export async function listScheduledMessages(
  workspaceId: string,
  query: ScheduledListQuery = {}
): Promise<ScheduledPage> {
  const res = await authedRequest(scheduledListPath(workspaceId, query));
  return parseScheduledPage(res.json<unknown>());
}

/** 한 번에 읽는 쪽 수의 상한. 서버 쪽 상한이 100개이고 내 대기는 50개까지라 정상은 한 쪽이다. */
export const SCHEDULED_LIST_MAX_PAGES = 20;

/**
 * 내 열린 예약(`pending` + `failed`) 전부. 커서를 따라가며 모은다. 알약·배너의 개수는 전부를
 * 세어야 맞으므로 첫 쪽에서 멈추지 않는다. 쪽 상한을 넘으면 거기까지만 돌려준다(끝없는 루프 방지).
 */
export async function listAllScheduledMessages(
  workspaceId: string,
  query: Omit<ScheduledListQuery, "cursor"> = {}
): Promise<ScheduledMessage[]> {
  const rows: ScheduledMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SCHEDULED_LIST_MAX_PAGES; page += 1) {
    const result = await listScheduledMessages(workspaceId, {
      ...query,
      status: query.status ?? "open",
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...result.scheduledMessages);
    if (result.nextCursor === undefined) break;
    cursor = result.nextCursor;
  }
  return rows;
}

/** 예약을 건다. 같은 `clientRequestId`의 재시도는 같은 행을 201로 받는다. */
export async function createScheduledMessage(
  workspaceId: string,
  input: CreateScheduledInput
): Promise<ScheduledMessage> {
  const res = await authedRequest(
    `${workspaceBase(workspaceId)}/channels/${encodeURIComponent(input.channelId)}/scheduled-messages`,
    { method: "POST", body: JSON.stringify(createRequestBody(input)) }
  );
  return parseScheduledResponse(res.json<unknown>());
}

/**
 * 글이나 시각을 고친다. **바뀐 키만** 싣는다(`request.ts`의 `scheduledPatch`가 비교해서
 * 만든다). 글만 고치면 `sendAtMs`가 없다.
 */
export async function updateScheduledMessage(
  workspaceId: string,
  scheduledId: string,
  patch: ScheduledPatch
): Promise<ScheduledMessage> {
  const res = await authedRequest(itemPath(workspaceId, scheduledId), {
    method: "PATCH",
    body: JSON.stringify(patchRequestBody(patch)),
  });
  return parseScheduledResponse(res.json<unknown>());
}

/**
 * 지금 보낸다. 요청 안에서 정본 전송을 부르므로 결과를 바로 받는다. 거절이면 409이고
 * `error.code`가 행이 이제 갖는 실패 사유다.
 */
export async function sendScheduledMessageNow(
  workspaceId: string,
  scheduledId: string
): Promise<ScheduledMessage> {
  const res = await authedRequest(`${itemPath(workspaceId, scheduledId)}/send-now`, {
    method: "POST",
  });
  return parseScheduledResponse(res.json<unknown>());
}

/** 예약을 지운다(취소). 이미 취소한 행도 204다. */
export async function deleteScheduledMessage(
  workspaceId: string,
  scheduledId: string
): Promise<void> {
  await authedRequest(itemPath(workspaceId, scheduledId), { method: "DELETE" });
}
