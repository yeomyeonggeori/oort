import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  record,
  num,
  str,
  stringArrayField,
  arrayField,
  WireShapeError,
} from "../../lib/wire";

// =============================================================================
// Hosted agent connections: wire shapes, status vocabulary and refusal copy
// (ADR-0162, goal HAP-UX1 / #1360).
//
// "Bring your hosted agent" 은 사용자가 이미 남의 인프라에서 돌리고 있는 에이전트를
// oort 의 1급 팀메이트로 들이는 흐름이다. 서버(HAP-E3)는 그 흐름을 두 개의 서로
// 다른 비밀값과 한 줄의 상태로 표현한다:
//
//   pairing_pending ──(에이전트가 pairing 값으로 다이얼인)──> detected
//   detected ──(사람이 채널·권한 승인 → active credential 1회 발급)──> detected
//   detected ──(그 credential 로 첫 증명 성공 + 전용 멤버 pause 해제)──> active
//
// 두 번째 화살표가 상태를 바꾸지 않는다는 사실이 이 파일의 설계를 지배한다.
// 승인은 자격증명을 **발급**할 뿐 연결을 활성화하지 않는다(`confirm_hosted_
// connection_in_tx` 는 `status='detected'` 를 유지한 채 `active_token_id` 만 채운다).
// 그래서 "승인했다"와 "붙었다"는 화면에서도 다른 문장이어야 한다.
//
// ## 규율 1 — 비밀값은 타입에 실리지 않는다
//
// 목록·조회 응답에는 비밀값이 없다(openapi `HostedAgentConnection`). 그래서
// `HostedAgentConnection` 에는 비밀값을 담을 필드 자체가 없고, `parseConnection`
// 은 스프레드가 아니라 **이름 붙은 필드 열둘**만 다시 짓는다. 서버가 약속을 어기고
// 무언가를 더 실어도 이 타입을 거쳐서는 화면에 닿지 못한다. 같은 규율이
// features/webhooks/model.ts 에 이미 서 있고, 그 이유도 같다.
//
// ## 규율 2 — provider 가 보낸 말은 렌더하지 않는다
//
// ADR-0162 D6: "클라이언트가 제출한 provider/Bot metadata 는 표시용 힌트일 뿐
// 권한의 근거가 아니다." 서버는 한 걸음 더 갔다 — `detect_pairing_in_tx` 가
// clientInfo 의 이름/버전을 **아예 저장하지 않는다**(`let client_name: Option<String>
// = None;`). 그래서 이 클라이언트가 감지 화면에 그릴 수 있는 것은 서버가 스스로
// 도출한 사실뿐이고, `connectionFacts` 의 키 집합이 닫혀 있는 것이 그 사실을
// 구조로 만든다. 그래도 `boundedLabel` 이 남는 이유는 사람이 1단계에서 적는
// 이름이 그대로 4단계 승인 문장에 들어가기 때문이다.
//
// ## 규율 3 — 서버의 영어 문장은 화면의 말이 아니다
//
// `hostedFailureMessage` 는 STATUS 로만 분기하고 wire message 를 절대 이어 붙이지
// 않는다. 이 표면의 400/409 본문은 운영자 영어이고, 무엇보다 이 흐름은 비밀값을
// 다루는 유일한 에이전트 표면이라 "서버가 보낸 문자열을 그대로 그린다"는 습관이
// 가장 비싼 자리다.
// =============================================================================

/** ADR-0162 D7 의 canonical lifecycle. 서버 enum 그대로. */
export type HostedConnectionStatus =
  | "pairing_pending"
  | "detected"
  | "active"
  | "expired"
  | "cleanup_pending"
  | "disconnected";

/**
 * 닫힌 hosted scope 집합 (openapi `HostedAgentScope`).
 *
 * 순서가 화면의 순서다: 접속이 먼저고, 읽기가 쓰기보다 앞이며, 작업 두 줄이 끝이다.
 * 서버 `HOSTED_AGENT_SCOPES` 와 같은 여섯이고 같은 순서다.
 */
export const HOSTED_AGENT_SCOPES = [
  "agent:port:connect",
  "agent:inbox:read",
  "messages:read",
  "messages:write",
  "agent:jobs:read",
  "agent:runs:callback",
] as const;

export type HostedAgentScope = (typeof HOSTED_AGENT_SCOPES)[number];

/** 이 wave 에서 실제로 열려 있는 유일한 인증 방식 (ADR-0162 D5). */
export const HOSTED_AUTH_MODE = "static_bearer";

/** 발급되는 자격증명이 겨냥하는 유일한 audience. */
export const HOSTED_AGENT_PORT_AUDIENCE = "/v1/mcp/agent-port";

export function isHostedScope(value: string): value is HostedAgentScope {
  return (HOSTED_AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * 비밀값을 담을 수 없는 커넥션 한 줄.
 *
 * `activeCredentialId` 는 자격증명의 **식별자**이지 자격증명이 아니다. 이 값이
 * 있고 상태가 아직 `detected` 인 구간이 "승인은 끝났고 증명이 안 왔다"이며,
 * 마법사의 5단계가 정확히 그 구간에 산다.
 */
export interface HostedAgentConnection {
  id: string;
  agentMemberId: string;
  status: HostedConnectionStatus;
  authMode: string;
  audience: string;
  approvedChannelIds: string[];
  approvedScopes: HostedAgentScope[];
  activeCredentialId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * 한 번만 보이는 pairing 값. 컴포넌트 상태에서만 살고, 쿼리 캐시·저장소·로그
 * 어디에도 쓰지 않는다(features/settings/webhookCredentialScope.ts 의 규율).
 */
export interface RevealedPairingChallenge {
  connection: HostedAgentConnection;
  pairingCredential: string;
  pairingExpiresAtMs: number;
}

/** 한 번만 보이는 active 값. pairing 값과 **다른 비밀**이다 (ADR-0162 D6). */
export interface RevealedActiveCredential {
  connection: HostedAgentConnection;
  credentialId: string;
  credential: string;
  tokenType: string;
}

// ---- wire -------------------------------------------------------------------

function toStatus(value: string | undefined): HostedConnectionStatus | null {
  switch (value) {
    case "pairing_pending":
    case "detected":
    case "active":
    case "expired":
    case "cleanup_pending":
    case "disconnected":
      return value;
    default:
      return null;
  }
}

function toScopes(value: unknown): HostedAgentScope[] | null {
  const raw = stringArrayField(value, "approvedScopes");
  if (raw === null) return null;
  const kept: HostedAgentScope[] = [];
  for (const scope of raw) {
    // 모르는 scope 는 **버린다**. 이 빌드가 이름을 모르는 권한을 승인 요약에
    // 그리면 사람은 자기가 무엇을 허락했는지 읽을 수 없는 줄을 보게 된다.
    if (isHostedScope(scope) && !kept.includes(scope)) kept.push(scope);
  }
  return kept;
}

/**
 * 한 줄을 필드 이름으로 다시 짓는다. 스프레드도 캐스트도 아니다 (규율 1).
 * 필수 칸이 하나라도 빠지면 반쯤 그린 줄 대신 `null` 을 돌려준다.
 */
export function toHostedConnection(value: unknown): HostedAgentConnection | null {
  const row = record(value);
  if (!row) return null;
  const id = str(row, "id");
  const agentMemberId = str(row, "agentMemberId");
  const status = toStatus(str(row, "status"));
  const authMode = str(row, "authMode");
  const audience = str(row, "audience");
  const approvedChannelIds = stringArrayField(row, "approvedChannelIds");
  const approvedScopes = toScopes(row);
  const createdAtMs = num(row, "createdAtMs");
  const updatedAtMs = num(row, "updatedAtMs");
  if (
    !id ||
    !agentMemberId ||
    !status ||
    !authMode ||
    !audience ||
    approvedChannelIds === null ||
    approvedScopes === null ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    return null;
  }
  const activeCredentialId = str(row, "activeCredentialId");
  return {
    id,
    agentMemberId,
    status,
    authMode,
    audience,
    approvedChannelIds,
    approvedScopes,
    ...(activeCredentialId ? { activeCredentialId } : {}),
    createdAtMs,
    updatedAtMs,
  };
}

/** 목록 응답. 최근에 만든 것이 위로 온다(서버의 정렬 약속과 같은 방향). */
export function parseHostedConnections(wire: unknown): HostedAgentConnection[] {
  const rows = arrayField(wire, "connections") ?? [];
  return rows
    .map(toHostedConnection)
    .filter((row): row is HostedAgentConnection => row !== null)
    .sort((a, b) =>
      a.createdAtMs === b.createdAtMs
        ? a.id.localeCompare(b.id)
        : b.createdAtMs - a.createdAtMs
    );
}

/** 단건 조회 응답. cleanup manifest 는 UX2(#1362)의 것이므로 읽지 않는다. */
export function parseHostedConnection(wire: unknown): HostedAgentConnection {
  const connection = toHostedConnection(record(wire)?.["connection"]);
  if (!connection) throw new WireShapeError();
  return connection;
}

/**
 * 발급/재발급 응답.
 *
 * `expected` 는 웹훅 카드가 이미 쓰는 가드다: 방금 요청한 것과 **다른** 커넥션을
 * 설명하는 응답은 저장하라고 내밀 값이 아니다. 재발급에서만 의미가 있고
 * (최초 발급은 아직 id 를 모른다) 생략할 수 있다.
 */
export function parsePairingIssuance(
  wire: unknown,
  expected?: { connectionId?: string }
): RevealedPairingChallenge {
  const row = record(wire);
  const connection = toHostedConnection(row?.["connection"]);
  const pairingCredential = str(row, "pairingCredential");
  const pairingExpiresAtMs = num(row, "pairingExpiresAtMs");
  if (!connection || !pairingCredential || pairingExpiresAtMs === undefined) {
    throw new WireShapeError();
  }
  if (connection.status !== "pairing_pending") throw new WireShapeError();
  if (expected?.connectionId && connection.id !== expected.connectionId) {
    throw new WireShapeError();
  }
  return { connection, pairingCredential, pairingExpiresAtMs };
}

/**
 * 승인 응답.
 *
 * 상태 검사가 `active` 하나가 아닌 것은 오타가 아니다: 오늘의 서버는 승인 뒤에도
 * `detected` 를 유지한다(머리말). 그래서 `active` 만 받으면 정상 응답이 전부 형상
 * 오류가 된다. 반대로 아무 상태나 받으면 아직 다이얼인도 안 한 커넥션의 응답을
 * 승인 완료로 그린다. 그 사이가 이 두 줄이다 — 상태는 서버가 정하되, 이 응답이
 * **방금 요청한 커넥션의 것**이고 자격증명 id 가 커넥션이 가리키는 것과 같다는
 * 두 사실은 확인한다.
 */
export function parseActivationIssuance(
  wire: unknown,
  expected: { connectionId: string }
): RevealedActiveCredential {
  const row = record(wire);
  const connection = toHostedConnection(row?.["connection"]);
  const credentialId = str(row, "credentialId");
  const credential = str(row, "credential");
  const tokenType = str(row, "tokenType");
  if (!connection || !credentialId || !credential || !tokenType) {
    throw new WireShapeError();
  }
  if (connection.id !== expected.connectionId) throw new WireShapeError();
  if (connection.status !== "detected" && connection.status !== "active") {
    throw new WireShapeError();
  }
  if (connection.activeCredentialId !== credentialId) throw new WireShapeError();
  return { connection, credentialId, credential, tokenType };
}

// ---- 문구 -------------------------------------------------------------------

/** 상태 한 낱말. 목록 칩과 마법사 머리글이 같은 말을 쓴다. */
export function hostedStatusLabel(status: HostedConnectionStatus): string {
  switch (status) {
    case "pairing_pending":
      return "연결 대기";
    case "detected":
      return "감지됨";
    case "active":
      return "활성";
    case "expired":
      return "만료됨";
    case "cleanup_pending":
      return "정리 중";
    case "disconnected":
      return "연결 해제됨";
  }
}

export type HostedChipTone = "neutral" | "ok" | "warn" | "danger";

export function hostedStatusTone(status: HostedConnectionStatus): HostedChipTone {
  switch (status) {
    case "active":
      return "ok";
    case "detected":
      return "warn";
    case "expired":
      return "danger";
    case "pairing_pending":
    case "cleanup_pending":
    case "disconnected":
      return "neutral";
  }
}

/**
 * 상태가 지금 무엇을 뜻하는지 한 문장.
 *
 * `detected` 가 두 문장인 이유는 그 상태가 두 자리이기 때문이다: 승인 전과,
 * 승인은 끝났는데 증명이 안 온 자리. 상태 하나에 문장 하나를 고집하면 그 둘 중
 * 하나는 반드시 거짓말이 된다.
 */
export function hostedStatusDetail(connection: HostedAgentConnection): string {
  switch (connection.status) {
    case "pairing_pending":
      // 소비되는 시점은 붙여 넣는 순간이 아니라 **감지되는 순간**이다. 노출 카드가
      // 이미 그렇게 적고 있고(presets.ts `PAIRING_REVEAL_SCOPE_NOTE`), 두 문장이
      // 어긋나면 사람은 값을 붙인 직후 그것이 죽었다고 읽어 아직 살아 있는 값을
      // 다시 발급한다.
      return "아직 이 에이전트가 다이얼인하지 않았습니다. 연결 값은 감지되는 순간 소비됩니다.";
    case "detected":
      return connection.activeCredentialId === undefined
        ? "다이얼인은 확인했지만 아직 아무 권한도 열리지 않았습니다. 사람이 채널과 권한을 확인해야 다음으로 갑니다."
        : "승인이 끝나고 새 자격증명이 발급됐습니다. 그 값으로 첫 증명이 성공해야 활성이 됩니다.";
    case "active":
      return "자격증명 증명이 성공했고 승인한 채널에서 이 에이전트가 일할 수 있습니다.";
    case "expired":
      return "연결 값이 만료됐습니다. 새 값을 발급해 provider 설정을 다시 채우세요.";
    case "cleanup_pending":
      return "oort 쪽 권한은 이미 끊겼습니다. provider에 남은 설정 정리가 끝나야 완전히 해제됩니다.";
    case "disconnected":
      return "이 연결은 해제됐습니다. 다시 쓰려면 새 연결을 만드세요.";
  }
}

/**
 * 이 마법사가 다루지 않는 상태인가.
 *
 * 해제 흐름은 UX2(#1362)의 것이다. 여기서 반쪽짜리 해제 UI 를 그리면 두 화면이
 * 같은 커넥션에 서로 다른 다음 행동을 말하게 된다.
 */
export function isHostedTerminal(status: HostedConnectionStatus): boolean {
  return status === "cleanup_pending" || status === "disconnected";
}

/**
 * 사람이 적은 이름을 다시 그릴 때의 상한.
 *
 * 제어문자를 지우고 공백을 한 칸으로 접은 뒤 길이를 자른다. 이 값은 1단계 입력이
 * 4단계 승인 문장과 5단계 확인 문장으로 그대로 흐르므로, 줄바꿈이 섞인 붙여넣기
 * 하나가 승인 요약을 세 줄짜리 미로로 만들 수 있다.
 */
export function boundedLabel(raw: string, max = 60): string {
  let cleaned = "";
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? " " : character;
  }
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  const points = [...collapsed];
  return points.length <= max ? collapsed : `${points.slice(0, max).join("")}…`;
}

export interface HostedFact {
  key: string;
  value: string;
  /** 식별자나 경로처럼 줄 안에서 아무 데서나 끊어도 되는 값인가. */
  token?: boolean;
}

/**
 * 감지 화면이 그리는 사실들 — **전부 서버가 스스로 도출한 것**이다 (규율 2).
 *
 * 키 집합이 닫혀 있고 그 사실을 테스트가 못으로 박는다. 이 목록이 열리는 순간
 * "서버가 준 다른 필드도 한 줄 추가"가 자연스러워지고, 그 습관이 provider 가
 * 보낸 문자열을 화면에 올린다.
 */
export function connectionFacts(
  connection: HostedAgentConnection,
  agentLabel: string
): HostedFact[] {
  return [
    { key: "전용 에이전트", value: boundedLabel(agentLabel) },
    { key: "연결 상태", value: hostedStatusLabel(connection.status) },
    { key: "인증 방식", value: hostedAuthModeLabel(connection.authMode) },
    { key: "허용 대상", value: connection.audience, token: true },
  ];
}

export function hostedAuthModeLabel(authMode: string): string {
  return authMode === HOSTED_AUTH_MODE
    ? "고정 bearer (static bearer)"
    : "이 빌드가 모르는 방식";
}

// ---- 거절 -------------------------------------------------------------------

export type HostedAction =
  | "list"
  | "get"
  | "create"
  | "regenerate"
  | "confirm";

function actionPrefix(action: HostedAction): string {
  switch (action) {
    case "list":
      return "연결 목록을 불러오지 못했습니다.";
    case "get":
      return "연결 상태를 불러오지 못했습니다.";
    case "create":
      return "연결을 만들지 못했습니다.";
    case "regenerate":
      return "연결 값을 다시 발급하지 못했습니다.";
    case "confirm":
      return "승인을 저장하지 못했습니다.";
  }
}

function statusAdvice(action: HostedAction, status: number): string {
  switch (status) {
    case 400:
      if (action === "confirm") {
        return "고른 채널이나 권한을 서버가 거절했습니다. 목록을 다시 불러온 뒤 다시 고르세요.";
      }
      return "이름이나 핸들을 서버가 거절했습니다. 값을 확인하고 다시 시도하세요.";
    case 401:
      return "로그인 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요.";
    case 403:
      return "호스티드 에이전트 연결은 워크스페이스 오너나 관리자만 다룰 수 있습니다. 관리자에게 요청하세요.";
    case 404:
      return "이 연결이 서버에 없습니다. 목록을 다시 불러오세요.";
    case 409:
      if (action === "create") {
        return "같은 핸들의 멤버가 이미 있습니다. 다른 핸들로 다시 시도하세요.";
      }
      if (action === "regenerate") {
        return "이미 활성이거나 해제된 연결은 값을 다시 발급할 수 없습니다. 상태를 다시 불러오세요.";
      }
      return "이 연결은 지금 승인할 수 있는 상태가 아닙니다. 이미 승인됐거나 값이 만료됐습니다. 상태를 다시 불러오세요.";
    case 429:
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    default:
      return "잠시 뒤에 다시 시도하세요.";
  }
}

/**
 * 무슨 일이 있었고 다음에 무엇을 할지. STATUS 로만 분기한다 (규율 3).
 *
 * `NetworkError.message` 만 이어 붙인다 — 그 문자열은 이 패키지가 이 목적으로
 * 직접 쓴 것이고 wire 에서 온 것이 하나도 없다.
 */
export function hostedFailureMessage(
  action: HostedAction,
  error: unknown
): string {
  const prefix = actionPrefix(action);
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof ApiError) return `${prefix} ${statusAdvice(action, error.status)}`;
  if (error instanceof WireShapeError) {
    return `${prefix} 서버 응답을 확인하지 못했습니다. 상태를 다시 불러오세요.`;
  }
  return `${prefix} 잠시 뒤에 다시 시도하세요.`;
}

/** 목록 403 은 "누가 할 수 있는가"라는 답이지 장애가 아니다. */
export function isHostedOperatorDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}
