import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { responseRecord } from "../../lib/wire";
import { apiBase, coreSession } from "../../runtime/host";
import type { HostedConfirmApproval } from "./approval";

// =============================================================================
// REST client for hosted agent connections (ADR-0162 HAP-E3, openapi `agents`).
//
// 다섯 동작만 있고 전부 이미 서버에 있다. 새로 지어낸 wire 는 없다:
//   POST /v1/workspaces/{ws}/hosted-agent-connections                       create
//   GET  /v1/workspaces/{ws}/hosted-agent-connections                       list
//   GET  /v1/workspaces/{ws}/hosted-agent-connections/{id}                  get
//   POST …/{id}/pairing-challenge/regenerate                                regenerate
//   POST …/{id}/confirm                                                     confirm
//
// disconnect 세 경로는 **일부러 없다**. 그것은 UX2(#1362)의 것이고, 여기에 함수만
// 미리 두면 다음 사람이 그 함수를 부르는 버튼을 이 화면에 단다.
//
// ## 비밀값 경계 (features/webhooks/api.ts 와 같은 규율, 같은 이유)
//
// 다섯 중 셋이 본문에 원문 비밀값을 싣는다(create·regenerate 는 pairing 값,
// confirm 은 active 자격증명). 서버는 그 셋에 `Cache-Control: no-store` 를 강제하고
// 해시만 보관한다. 클라이언트가 지켜야 할 두 가지를 여기서 지킨다:
//
//   1. 그 셋은 `cache: "no-store"` 로 보낸다. 서버가 안 들겠다는 본문을 브라우저
//      HTTP 캐시에 들라고 요청하지 않는다.
//   2. **이 파일은 아무것도 로그하지 않는다.** 실패에 `console.warn(error)` 한 줄이
//      들어가면 일회성 자격증명이 화면보다 오래 사는 devtools 버퍼로 간다.
//
// 목록·조회 응답에는 비밀값이 없고(openapi), `./model` 의 파서가 필드를 하나씩
// 다시 지으므로 서버가 그 약속을 어겨도 화면에 닿지 않는다.
// =============================================================================

async function hostedRequest(
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    // STATUS 만 쓴다. 화면은 `hostedFailureMessage` 로 한국어를 짓고, 이 문자열은
    // 진단용으로 오류에만 남는다.
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return responseRecord(res.json<unknown>());
}

function collection(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/hosted-agent-connections`;
}

function connection(workspaceId: string, connectionId: string): string {
  return `${collection(workspaceId)}/${encodeURIComponent(connectionId)}`;
}

export interface CreateHostedConnectionInput {
  displayName: string;
  handle: string;
  authMode: string;
}

/**
 * 201. 전용 agent member, `paused=true` 프로필, `pairing_pending` 커넥션, pairing
 * 값이 한 transaction 으로 생긴다. 기존 agent 에 덧붙이는 경로는 v0 에 없다.
 */
export function createHostedConnection(
  workspaceId: string,
  input: CreateHostedConnectionInput
): Promise<unknown> {
  return hostedRequest(collection(workspaceId), {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

/** 비밀값 없는 목록. human owner/admin 이 아니면 403 이다. */
export function listHostedConnections(workspaceId: string): Promise<unknown> {
  return hostedRequest(collection(workspaceId));
}

/** 비밀값 없는 단건. 마법사가 상태 전이를 이걸로 따라간다. */
export function getHostedConnection(
  workspaceId: string,
  connectionId: string
): Promise<unknown> {
  return hostedRequest(connection(workspaceId, connectionId));
}

/**
 * 200. 앞선 값(과 이미 발급된 자격증명)을 무효화하고 새 pairing 값을 하나 준다.
 * 활성 커넥션에는 409 다.
 */
export function regenerateHostedPairing(
  workspaceId: string,
  connectionId: string
): Promise<unknown> {
  return hostedRequest(
    `${connection(workspaceId, connectionId)}/pairing-challenge/regenerate`,
    { method: "POST", cache: "no-store" }
  );
}

/**
 * 201. 사람의 승인을 저장하고 active 자격증명을 한 번 발급한다.
 *
 * 이 응답이 오더라도 커넥션은 아직 `detected` 다. 활성은 provider 가 그 자격증명으로
 * 증명에 성공한 뒤에 온다(`./model` 머리말).
 */
export function confirmHostedConnection(
  workspaceId: string,
  connectionId: string,
  approval: HostedConfirmApproval
): Promise<unknown> {
  return hostedRequest(`${connection(workspaceId, connectionId)}/confirm`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(approval),
  });
}
