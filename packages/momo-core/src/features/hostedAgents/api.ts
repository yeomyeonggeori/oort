import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { responseRecord } from "../../lib/wire";
import { apiBase, coreSession } from "../../runtime/host";
import type { HostedConfirmApproval } from "./approval";

// =============================================================================
// REST client for hosted agent connections (ADR-0162 HAP-E3, openapi `agents`).
//
// 여덟 동작만 있고 전부 이미 서버에 있다. 새로 지어낸 wire 는 없다:
//   POST /v1/workspaces/{ws}/hosted-agent-connections                       create
//   GET  /v1/workspaces/{ws}/hosted-agent-connections                       list
//   GET  /v1/workspaces/{ws}/hosted-agent-connections/{id}                  get
//   POST …/{id}/pairing-challenge/regenerate                                regenerate
//   POST …/{id}/confirm                                                     confirm
//   POST …/{id}/disconnect                                                  disconnect
//   POST …/{id}/cleanup-artifacts/{artifactId}/acknowledge                  acknowledge
//   POST …/{id}/disconnect/complete                                         complete
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
