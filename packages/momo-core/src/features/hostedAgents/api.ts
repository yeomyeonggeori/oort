import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { responseRecord } from "../../lib/wire";
import { apiBase, coreSession } from "../../runtime/host";
import type { HostedConfirmApproval } from "./approval";
import type { OauthApproveRequest, OauthDenyRequest } from "./oauthConsent";

// =============================================================================
// REST client for hosted agent connections (ADR-0162 HAP-E3, openapi `agents`).
//
// 열 동작만 있고 전부 이미 서버에 있다. 새로 지어낸 wire 는 없다:
//   POST /v1/workspaces/{ws}/hosted-agent-connections                       create
//   GET  /v1/workspaces/{ws}/hosted-agent-connections                       list
//   GET  /v1/workspaces/{ws}/hosted-agent-connections/{id}                  get
//   POST …/{id}/pairing-challenge/regenerate                                regenerate
//   POST …/{id}/confirm                                                     confirm
//   POST …/{id}/disconnect                                                  disconnect
//   POST …/{id}/cleanup-artifacts/{artifactId}/acknowledge                  acknowledge
//   POST …/{id}/disconnect/complete                                         complete
//   PUT  …/{id}/doorbell                                                    register doorbell (ADR-0171)
//   DELETE …/{id}/doorbell                                                  unregister doorbell
//
// 아래 셋은 HAP-UX2(#1362)가 열었다. 앞선 다섯과 한 파일에 사는 이유는 자격증명
// 경계가 같기 때문이다 — 다만 방향이 반대다: 앞의 셋이 원문을 **받아** 오는 반면
// 해제 셋은 아무 비밀값도 오가지 않는다. 그래서 `cache: "no-store"` 도 셋에는
// 없다. 없는 이유를 적어 두지 않으면 다음 사람이 「일관성」으로 붙인다.
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

// ---- 해제 (HAP-E6 / #1362) --------------------------------------------------

/** 사람이 따로 이름 붙여 추적하려는 provider 항목 하나. 비밀값이 아니다. */
export interface HostedCleanupSeed {
  kind: string;
  externalRef: string;
}

/**
 * 200. 한 transaction 으로 자격증명 폐기 + `cleanup_pending` 전이 + 전용 멤버
 * pause + 진행 중이던 작업 정리 + 6종 정리 목록 씨앗.
 *
 * 이미 `cleanup_pending` 인 연결에 다시 보내면 `startedNow: false` 로 답하고
 * 아무것도 다시 쓰지 않는다. 다만 `artifacts` 로 새 항목을 주면 목록에 **병합**
 * 한다. 그래서 이 함수 하나가 「해제 시작」과 「목록 복원」 둘 다의 경로다.
 */
export function disconnectHostedConnection(
  workspaceId: string,
  connectionId: string,
  artifacts: readonly HostedCleanupSeed[] = []
): Promise<unknown> {
  return hostedRequest(`${connection(workspaceId, connectionId)}/disconnect`, {
    method: "POST",
    body: JSON.stringify(artifacts.length > 0 ? { artifacts } : {}),
  });
}

/**
 * 200. 정리 항목 하나에 관측을, 그리고 원한다면 처분 하나를 기록한다.
 *
 * 본문에 `source` 를 실을 칸이 **없다**. 서버는 이 경로로 들어온 모든 확인을
 * `manual` 로 쓰고, `server_verified` 는 자기가 폐기한 자격증명에만 붙인다.
 * 여기에 칸을 만드는 순간 클라이언트가 자기 주장을 서버의 사실로 승격시킬 수
 * 있게 되고, 그 값은 이 흐름에서 유일하게 "oort 가 직접 확인했다"는 뜻이다.
 */
export function acknowledgeHostedCleanupArtifact(
  workspaceId: string,
  connectionId: string,
  artifactId: string,
  body: { currentStatus: string; disposition?: string; evidence?: string }
): Promise<unknown> {
  return hostedRequest(
    `${connection(workspaceId, connectionId)}/cleanup-artifacts/${encodeURIComponent(
      artifactId
    )}/acknowledge`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

/**
 * 200. terminal `disconnected` 로의 전이. 필수 항목이 하나라도 미해결이면 409 이고,
 * 서버가 자기 쪽 폐기(자격증명 0개·전용 멤버 pause)를 되읽지 못해도 409 다.
 *
 * 이미 끝난 전이를 다시 부르면 `disconnectedNow: false` 로 답하고 감사 기록을
 * 남기지 않는다.
 */
export function completeHostedDisconnect(
  workspaceId: string,
  connectionId: string
): Promise<unknown> {
  return hostedRequest(
    `${connection(workspaceId, connectionId)}/disconnect/complete`,
    { method: "POST" }
  );
}

// ---- 도어벨 (ADR-0171 / WD-2) -----------------------------------------------
//
// PUT 본문에 운영자 Bearer 가 실린다. 서버는 응답에 마스킹만 남기고
// `Cache-Control: no-store` 를 강제한다. 그래서 이 둘도 `cache: "no-store"` 로
// 보낸다. 이 파일은 아무것도 로그하지 않는다는 규율이 여기서도 그대로다.

export interface RegisterHostedDoorbellInput {
  url: string;
  secret: string;
}

/** 200. 같은 URL 로 다시 보내면 교체·재봉인되고 발화 시각은 초기화된다. */
export function registerHostedDoorbell(
  workspaceId: string,
  connectionId: string,
  input: RegisterHostedDoorbellInput
): Promise<unknown> {
  return hostedRequest(`${connection(workspaceId, connectionId)}/doorbell`, {
    method: "PUT",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

/** 200. 미등록이면 JSON 404, 게이트 닫힘이면 본문 없는 404. */
export function unregisterHostedDoorbell(
  workspaceId: string,
  connectionId: string
): Promise<unknown> {
  return hostedRequest(`${connection(workspaceId, connectionId)}/doorbell`, {
    method: "DELETE",
    cache: "no-store",
  });
}

// ---- OAuth resource-owner consent (HAP-E7 / #1368, HAP-UX4 / #1369) ---------
//
// 세 경로 전부 인가 결정을 다룬다. 그래서 셋 다 `cache: "no-store"` 로 보낸다 —
// preview 는 candidate 를, decision 응답은 provider 로 갈 code 를 담은 redirectTo 를
// 싣고, 어느 것도 두 번째 브라우저에 재생돼서는 안 된다(서버도 모든 OAuth 응답에
// `no-store` 를 강제한다). 이 파일은 아무것도 로그하지 않는다는 규율이 여기서도
// 그대로다: request 봉투와 redirectTo 는 devtools 버퍼로 새지 않는다.
//
// 화면에 닿는 유일한 상태 복원 열쇠는 서버가 서명한 opaque `request` 봉투 하나이고
// (#1369 보안 척추), 그것은 URL 에서 읽혀 여기 본문/쿼리로만 흐른다.

function oauthCollection(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/oauth/authorization-requests`;
}

/**
 * consent 화면이 그릴 사실을 서버에서 되받는다. `request` 봉투를 제시하면 서버가
 * client·redirect·resource·issuer·요청 scope·만료·묶을 수 있는 연결(candidate)을
 * 돌려준다. 만료·위조·재생·타 워크스페이스·비관리자·OAuth 비활성은 전부 같은
 * 404 다(non-enumerable).
 */
export function previewHostedOauthConsent(
  workspaceId: string,
  requestId: string
): Promise<unknown> {
  return hostedRequest(
    `${oauthCollection(workspaceId)}/preview?request=${encodeURIComponent(
      requestId
    )}`,
    { cache: "no-store" }
  );
}

/**
 * 사람의 승인을 기록하고, 서버가 provider 의 등록된 redirect 로 갈 곳(redirectTo)을
 * 돌려준다. 중복·재요청은 서버가 409 로 답한다(단 하나의 terminal decision).
 */
export function approveHostedOauthConsent(
  workspaceId: string,
  body: OauthApproveRequest
): Promise<unknown> {
  return hostedRequest(`${oauthCollection(workspaceId)}/approve`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
}

/**
 * 거부를 기록한다. 연결은 그대로 `pairing_pending` 에 남고 아무 권한도 열리지
 * 않는다. 서버는 access_denied redirect 를 돌려준다.
 */
export function denyHostedOauthConsent(
  workspaceId: string,
  body: OauthDenyRequest
): Promise<unknown> {
  return hostedRequest(`${oauthCollection(workspaceId)}/deny`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(body),
  });
}
