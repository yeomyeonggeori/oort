import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { num, record, str, WireShapeError } from "../../lib/wire";
import type { HostedAgentConnection } from "./model";

// =============================================================================
// Hosted-connection doorbell (ADR-0171 / WD-2).
//
// 등록은 PUT, 해제는 DELETE, 투영은 커넥션 GET 의 선택 필드다. 전용 GET 은 없다.
// 시크릿은 write-only: 요청에만 실리고, 응답·타입·로그에는 마스킹만 남는다.
//
// 게이트 `MOMO_DOORBELL_ENABLED` 가 꺼지면 PUT/DELETE 는 본문 없는 404 다. 그것은
// 미등록 JSON 404(`doorbell is not registered`)와 다른 답이고, 화면이 등록 실패로
// 읽으면 운영자가 플래그를 켜야 하는 자리를 고장으로 고친다.
// =============================================================================

export const DOORBELL_URL_MAX = 2048;
export const DOORBELL_SECRET_MAX = 4096;

export interface HostedDoorbellProjection {
  url: string;
  secretMasked: string;
  lastFiredAtMs?: number;
  lastStatus?: string;
}

export interface HostedDoorbellRegistration {
  connectionId: string;
  url: string;
  secretMasked: string;
  registeredAtMs: number;
  lastFiredAtMs?: number;
  lastStatus?: string;
}

export const DOORBELL_HEADLINE = "도어벨";
export const DOORBELL_LEAD =
  "그록봇 webhook 루틴을 부름이 쌓일 때 깨웁니다. 도어벨이 실패해도 부름 자체는 그대로 남습니다.";
export const DOORBELL_EMPTY_HEADLINE = "도어벨이 아직 없습니다.";
export const DOORBELL_EMPTY_DETAIL =
  "그록봇에 webhook 루틴을 만든 뒤, 받은 https 주소와 sender key를 넣으세요. 루틴 문안은 셀프호스트 에이전트 플레이북의 도어벨 절에 있습니다.";
export const DOORBELL_GATE_OFF_HEADLINE = "이 서버는 도어벨이 꺼져 있습니다.";
export const DOORBELL_GATE_OFF_DETAIL =
  "운영자가 MOMO_DOORBELL_ENABLED를 열기 전에는 등록할 수 없습니다. 꺼진 것은 고장이 아닙니다.";
export const DOORBELL_URL_HINT =
  "https 주소만 등록됩니다. 사설망과 로컬 주소는 거절됩니다.";
export const DOORBELL_SECRET_HINT =
  "저장 후에는 끝자리만 보입니다. 다시 넣으면 교체되고 다시 봉인되며, 마지막 발화 시각은 초기화됩니다.";
export const DOORBELL_NEVER_FIRED = "아직 울린 적 없음";
export const DOORBELL_STATUS_NONE = "없음";
export const DOORBELL_NOT_ACTIVE =
  "활성 연결에서만 도어벨을 등록할 수 있습니다.";
export const DOORBELL_REGISTER_LABEL = "도어벨 등록";
export const DOORBELL_REPLACE_LABEL = "도어벨 교체";
export const DOORBELL_REGISTER_BUSY = "등록 중";
export const DOORBELL_REPLACE_BUSY = "교체 중";
export const DOORBELL_UNREGISTER_LABEL = "도어벨 해제";
export const DOORBELL_UNREGISTER_QUESTION =
  "해제하면 이 연결의 webhook 깨우기가 즉시 멈춥니다. 부름 전달은 그대로입니다.";
export const DOORBELL_UNREGISTER_CONFIRM = "해제";
export const DOORBELL_UNREGISTER_BUSY = "해제 중";
export const DOORBELL_REGISTERED_LIVE = "도어벨을 등록했습니다.";
export const DOORBELL_UNREGISTERED_LIVE = "도어벨을 해제했습니다.";
export const DOORBELL_URL_LABEL = "webhook 주소";
export const DOORBELL_SECRET_LABEL = "sender key";
export const DOORBELL_MASK_LABEL = "시크릿";
export const DOORBELL_FIRED_LABEL = "마지막 발화";
export const DOORBELL_STATUS_LABEL = "마지막 상태";
export const DOORBELL_OFFLINE_NOTE =
  "연결이 끊겨 있어 지금은 도어벨을 바꾸거나 해제할 수 없습니다.";
export const DOORBELL_BUSY_NOTE =
  "앞서 누른 것이 아직 끝나지 않았습니다. 이어서 등록하거나 해제할 수 있습니다.";
export const DOORBELL_LOADING_LABEL = "도어벨을 불러오는 중입니다.";
export const DOORBELL_RETRY_GATE = "다시 시도";

/**
 * GET 투영. URL 과 마스킹이 둘 다 있어야 등록된 것이다. 하나만 오면 그리지 않는다.
 */
export function doorbellProjection(
  connection: HostedAgentConnection
): HostedDoorbellProjection | null {
  const url = connection.doorbellUrl;
  const secretMasked = connection.doorbellSecretMasked;
  if (!url || !secretMasked) return null;
  return {
    url,
    secretMasked,
    ...(connection.doorbellLastFiredAtMs !== undefined
      ? { lastFiredAtMs: connection.doorbellLastFiredAtMs }
      : {}),
    ...(connection.doorbellLastStatus
      ? { lastStatus: connection.doorbellLastStatus }
      : {}),
  };
}

export function parseHostedDoorbellResponse(
  wire: unknown
): HostedDoorbellRegistration {
  const row = record(wire);
  const connectionId = str(row, "connectionId");
  const url = str(row, "url");
  const secretMasked = str(row, "secretMasked");
  const registeredAtMs = num(row, "registeredAtMs");
  if (!connectionId || !url || !secretMasked || registeredAtMs === undefined) {
    throw new WireShapeError();
  }
  const lastFiredAtMs = num(row, "lastFiredAtMs");
  const lastStatus = str(row, "lastStatus");
  return {
    connectionId,
    url,
    secretMasked,
    registeredAtMs,
    ...(lastFiredAtMs !== undefined ? { lastFiredAtMs } : {}),
    ...(lastStatus ? { lastStatus } : {}),
  };
}

/**
 * 등록/해제 응답을 커넥션 한 줄에 반영한다. 시크릿 원문은 인자 타입에 없다.
 * 필드를 이름으로 다시 짓는 이유는 스프레드가 옛 발화 칸을 남기기 때문이다.
 */
export function applyDoorbellRegistration(
  connection: HostedAgentConnection,
  registered: HostedDoorbellRegistration | null
): HostedAgentConnection {
  const next: HostedAgentConnection = {
    id: connection.id,
    agentMemberId: connection.agentMemberId,
    status: connection.status,
    authMode: connection.authMode,
    audience: connection.audience,
    approvedChannelIds: connection.approvedChannelIds,
    approvedScopes: connection.approvedScopes,
    createdAtMs: connection.createdAtMs,
    updatedAtMs: connection.updatedAtMs,
    ...(connection.activeCredentialId
      ? { activeCredentialId: connection.activeCredentialId }
      : {}),
  };
  if (registered === null) return next;
  return {
    ...next,
    doorbellUrl: registered.url,
    doorbellSecretMasked: registered.secretMasked,
    ...(registered.lastFiredAtMs !== undefined
      ? { doorbellLastFiredAtMs: registered.lastFiredAtMs }
      : {}),
    ...(registered.lastStatus
      ? { doorbellLastStatus: registered.lastStatus }
      : {}),
  };
}

export function doorbellUrlIssue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "https 주소를 입력하세요.";
  if (trimmed.length > DOORBELL_URL_MAX) return "주소가 너무 깁니다.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "https 주소를 입력하세요.";
  }
  if (parsed.protocol !== "https:") return "https 주소만 등록됩니다.";
  return null;
}

export function doorbellSecretIssue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "sender key를 입력하세요.";
  if (trimmed.length > DOORBELL_SECRET_MAX) {
    return "sender key가 너무 깁니다.";
  }
  return null;
}

/**
 * 게이트 닫힘: 본문 없는 404. `hostedRequest` 는 그때 `HTTP 404` 를 자리표시로
 * 쓴다. JSON 404 의 계약 문구와 구별한다.
 */
export function isDoorbellGateClosed(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  const message = error.message.trim();
  return message === "" || message === `HTTP ${error.status}`;
}

export type DoorbellAction = "register" | "unregister";

/**
 * 400/409 는 서버 계약 문구를 그대로 쓴다. 그 문구가 이 표면의 다음 행동이다.
 * 시크릿 원문은 서버가 응답에 싣지 않으므로 이어 붙여도 원문이 되지 않는다.
 */
export function doorbellFailureMessage(
  action: DoorbellAction,
  error: unknown
): string {
  const prefix =
    action === "register"
      ? "도어벨을 등록하지 못했습니다."
      : "도어벨을 해제하지 못했습니다.";
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof WireShapeError) {
    return `${prefix} 서버 응답을 확인하지 못했습니다. 다시 시도하세요.`;
  }
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 409) {
      const wire = error.message.trim();
      if (wire && !wire.startsWith("HTTP ")) return wire;
    }
    if (error.status === 401) {
      return `${prefix} 로그인 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요.`;
    }
    if (error.status === 403) {
      return `${prefix} 호스티드 에이전트 연결은 워크스페이스 오너나 관리자만 다룰 수 있습니다.`;
    }
    if (error.status === 404) {
      const wire = error.message.trim();
      if (wire && !wire.startsWith("HTTP ")) return wire;
      return `${prefix} 이 연결이 서버에 없습니다. 다시 불러오세요.`;
    }
    if (error.status === 429) {
      return `${prefix} 요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.`;
    }
    return `${prefix} 잠시 뒤에 다시 시도하세요.`;
  }
  return `${prefix} 잠시 뒤에 다시 시도하세요.`;
}

export function doorbellLastStatusTone(
  status: string | undefined
): "ok" | "warn" | "muted" {
  if (!status) return "muted";
  return status.startsWith("ok_") ? "ok" : "warn";
}
