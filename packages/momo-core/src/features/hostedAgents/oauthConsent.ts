import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { attachParticle } from "../../lib/koreanParticle";
import {
  arrayField,
  num,
  record,
  str,
  stringArrayField,
  WireShapeError,
} from "../../lib/wire";
import {
  approvableChannelIds,
  HOSTED_SCOPE_CHOICES,
  REQUIRED_HOSTED_SCOPE,
  scopeActionList,
  type ApprovalChannelInput,
  type HostedScopeChoice,
} from "./approval";
import {
  boundedLabel,
  isHostedScope,
  HOSTED_AGENT_SCOPES,
  type HostedAgentScope,
} from "./model";

// =============================================================================
// MCP OAuth 2.1 resource-owner consent — the human's approve/deny decision on a
// provider-initiated authorization request (ADR-0162 증보 1, goal HAP-UX4 / #1369).
//
// 이 파일은 #1368(HAP-E7)이 세운 인가 서버와 화면 사이의 **판정과 문구**만 들고
// 있다. 서버가 하는 일과 화면이 하는 일의 경계가 이 흐름의 보안 그 자체라, 그
// 경계를 코드로 못 박는 것이 이 파일의 목적이다:
//
//   provider ──(리다이렉트)──> /v1/oauth/authorize ──(서버가 서명한 request id)──>
//     이 화면(consent) ──(사람이 approve/deny)──> 서버가 code/state/iss 를
//       provider 의 등록된 redirect 로 돌려보냄
//
// ## 규율 1 — 화면에 닿는 것은 서버가 서명한 opaque request id 하나뿐이다
//
// authorize 리다이렉트는 raw query·token·code·verifier 를 이 화면으로 넘기지
// 않는다(#1368 `authorize_hands_the_browser_only_a_server_minted_request_id`).
// 이 화면이 아는 사실 전부는 그 id 를 preview 에 제시해 **서버에서** 되받는다.
// provider 가 보낸 리다이렉트의 다른 값은 신뢰하지 않는다. 그래서 이 파일의 파서는
// preview 응답만 읽고, 그 응답조차 이름 붙은 필드로 다시 짓는다(규율 2).
//
// ## 규율 2 — 비밀값은 타입에 실리지 않는다
//
// preview·decision 응답에는 비밀값이 없다(dto `HostedOauthConsentPreviewResponse`
// ·`HostedOauthDecisionResponse` 는 code/token/verifier 를 싣지 않는다). 그래서
// 이 타입들에는 비밀값을 담을 칸이 없고, 파서는 스프레드가 아니라 이름 붙은 필드만
// 다시 짓는다. features/hostedAgents/model.ts 규율 1 과 같은 이유, 같은 모양이다.
//
// ## 규율 3 — clientId·redirectUri 는 provider 가 자칭한 값이 아니다
//
// dto 머리말이 못 박는다: "neither is client-declared metadata, both come from
// the operator's allowlist." 서버는 등록되지 않은 client·redirect 를 이 화면까지
// 보내지 않는다(authorize 가 먼저 400 으로 거절한다). 그래서 이 화면은 그 둘을
// **운영자가 등록한 값**으로 정직하게 적는다. self-reported 라고 적으면 그것은
// 반대 방향의 거짓말이다 — 운영자가 검증한 값을 검증되지 않은 것처럼 말하는 것이다.
//
// ## 규율 4 — 없는 것과 거절된 것은 한 문장이다 (non-enumerable)
//
// 서버는 만료·위조·재생·타 워크스페이스·비관리자·OAuth 비활성 전부를 같은 404 로
// 답한다(#1368 `verified_claims`·`require_admin`·`enabled_oauth`). 그 구분이
// 화면에 새면 권한 없는 탐침이 "그 요청은 존재한다"를 알아낸다. 그래서 이 파일의
// 실패 문구도 404 를 하나의 사유로 접고, 어떤 경우에도 static bearer 로 내려가지
// 않는다(capability 0).
// =============================================================================

// ---- preview 응답 -----------------------------------------------------------

/** 이 요청이 묶일 수 있는 대기 중(`pairing_pending`) OAuth 연결 하나. */
export interface OauthConsentCandidate {
  connectionId: string;
  agentMemberId: string;
  /** 사람이 1단계에서 지은 전용 에이전트 이름. 화면 말이다. */
  agentDisplayName: string;
  createdAtMs: number;
}

/**
 * consent 화면이 사람에게 보여줄 사실 전부. **전부 서버에서 왔고**, 비밀값은 없다.
 *
 * `requestedScopes` 는 client 가 요청한 상한이다. 서버가 authorize 단계에서 이미
 * `HOSTED_AGENT_SCOPES` 안으로 걸렀으므로(모르는 scope 는 여기 오지 못한다) 이
 * 목록은 언제나 이 빌드가 이름을 아는 권한들이다.
 */
export interface OauthConsentPreview {
  clientId: string;
  redirectUri: string;
  /** 이 위임이 묶이는 정규 Agent Port 자원. */
  resource: string;
  issuer: string;
  requestedScopes: HostedAgentScope[];
  expiresAtMs: number;
  candidates: OauthConsentCandidate[];
}

/** 요청한 scope 중 이 빌드가 이름을 아는 것만, 정규 순서로, 중복 없이. */
function keepKnownScopes(raw: readonly string[]): HostedAgentScope[] {
  const wanted = new Set<HostedAgentScope>();
  for (const scope of raw) {
    if (isHostedScope(scope)) wanted.add(scope);
  }
  return HOSTED_AGENT_SCOPES.filter((scope) => wanted.has(scope));
}

function toCandidate(value: unknown): OauthConsentCandidate | null {
  const row = record(value);
  if (!row) return null;
  const connectionId = str(row, "connectionId");
  const agentMemberId = str(row, "agentMemberId");
  const agentDisplayName = str(row, "agentDisplayName");
  const createdAtMs = num(row, "createdAtMs");
  if (
    !connectionId ||
    !agentMemberId ||
    agentDisplayName === undefined ||
    createdAtMs === undefined
  ) {
    return null;
  }
  return { connectionId, agentMemberId, agentDisplayName, createdAtMs };
}

/**
 * preview 한 줄을 이름 붙은 필드로 다시 짓는다 (규율 2). 필수 칸이 하나라도 빠지면
 * 반쯤 그린 화면 대신 `WireShapeError` 를 던진다 — consent 는 사람이 신뢰를 내주는
 * 자리라, 읽지 못한 필드가 하나라도 있으면 아무것도 그리지 않는 것이 맞다.
 */
export function parseOauthConsentPreview(wire: unknown): OauthConsentPreview {
  const row = record(wire);
  const clientId = str(row, "clientId");
  const redirectUri = str(row, "redirectUri");
  const resource = str(row, "resource");
  const issuer = str(row, "issuer");
  const requestedRaw = stringArrayField(row, "requestedScopes");
  const expiresAtMs = num(row, "expiresAtMs");
  const candidateRows = arrayField(row, "candidates");
  if (
    !clientId ||
    !redirectUri ||
    !resource ||
    !issuer ||
    requestedRaw === null ||
    expiresAtMs === undefined ||
    candidateRows === null
  ) {
    throw new WireShapeError();
  }
  const requestedScopes = keepKnownScopes(requestedRaw);
  // 서버는 authorize 에서 `agent:port:connect` 없는 요청을 거절한다. 그래도 여기서
  // 다시 확인하는 이유는 이 값이 "무엇을 승인할 수 있는가"의 상한이기 때문이다:
  // 접속이 빠진 상한은 아무 권한도 열 수 없는 요청이고, 그것을 그리면 사람은
  // 승인해도 아무 일도 안 일어나는 버튼을 누른다.
  if (!requestedScopes.includes(REQUIRED_HOSTED_SCOPE)) {
    throw new WireShapeError();
  }
  const candidates = candidateRows
    .map(toCandidate)
    .filter((candidate): candidate is OauthConsentCandidate => candidate !== null);
  return {
    clientId,
    redirectUri,
    resource,
    issuer,
    requestedScopes,
    expiresAtMs,
    candidates,
  };
}

// ---- 승인 범위 --------------------------------------------------------------

/**
 * consent 화면이 그리는 권한 줄들 — **요청된 상한 안에서만**.
 *
 * `HOSTED_SCOPE_CHOICES` 를 재사용하되 요청되지 않은 권한은 목록에 세우지 않는다.
 * consent 는 권한을 넓히는 자리가 아니라 요청된 것을 확인하고 좁히는 자리이고,
 * 서버도 요청 밖 scope 를 400 으로 거절한다(#1368
 * `an_approval_outside_the_hosted_ceiling_is_refused`). 접속(`required`)은 잠긴
 * 채로 켜져 있고, 그 사실은 줄 자기 문장이 말한다.
 */
export function oauthScopeChoices(
  requestedScopes: readonly HostedAgentScope[]
): HostedScopeChoice[] {
  return HOSTED_SCOPE_CHOICES.filter((choice) =>
    requestedScopes.includes(choice.id)
  );
}

/**
 * 고른 권한을 서버에 실을 수 있는 집합으로 정규화한다.
 *
 * 세 가지를 보장한다: (1) 요청된 상한 안이고(요청 밖은 버린다), (2) 접속을 반드시
 * 포함하고, (3) 정규 순서·중복 없음. 서버가 같은 셋을 다시 강제하지만, 화면이 고를
 * 수 있는 것처럼 보여 놓고 서버가 거절하는 것은 막은 것이 아니라 거짓말한 뒤 막은
 * 것이다(approval.ts 규율 3).
 */
export function normalizeOauthScopes(
  requestedScopes: readonly HostedAgentScope[],
  selected: readonly string[]
): HostedAgentScope[] {
  const ceiling = new Set(requestedScopes);
  const wanted = new Set<HostedAgentScope>();
  if (ceiling.has(REQUIRED_HOSTED_SCOPE)) wanted.add(REQUIRED_HOSTED_SCOPE);
  for (const scope of selected) {
    if (isHostedScope(scope) && ceiling.has(scope)) wanted.add(scope);
  }
  return HOSTED_AGENT_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * 저장 버튼 바로 위에 서는 한 문단 — 무엇을 열고, 무엇이 닫히는가.
 *
 * approval.ts `approvalConsequence` 와 같은 규율을 따른다(닫히는 쪽을 말한다).
 * 다만 주어가 "이 provider 의 에이전트"라, 승인이 **외부**에 무엇을 여는지가 먼저
 * 읽혀야 한다.
 */
export function oauthConsentConsequence(
  agentLabel: string,
  channelCount: number,
  approvedScopes: readonly HostedAgentScope[]
): string {
  const name = attachParticle(boundedLabel(agentLabel), "topic");
  const actions = scopeActionList(approvedScopes);
  if (channelCount === 0) {
    return `${name} 접속만 하고 어떤 대화에도 닿지 못합니다. 채널을 하나도 승인하지 않았기 때문입니다.`;
  }
  if (actions.length === 0) {
    return `${name} ${channelCount}개 채널의 멤버가 되지만 읽기도 쓰기도 하지 못합니다. 접속 말고 아무 권한도 고르지 않았기 때문입니다.`;
  }
  const list = actions.join(", ");
  return `승인하면 이 외부 에이전트가 ${name} ${channelCount}개 채널에서 ${list}를 할 수 있습니다. 승인하지 않은 채널에서는 이 에이전트를 멘션해도 작업이 만들어지지 않습니다.`;
}

// ---- 전송 본문 --------------------------------------------------------------

/** approve 본문. camelCase 그대로 서버 dto `HostedOauthDecisionRequest` 에 맞춘다. */
export interface OauthApproveRequest {
  request: string;
  connectionId: string;
  approvedScopes: HostedAgentScope[];
  approvedChannelIds: string[];
}

/** deny 본문. 서버는 deny 에서 scope·channel 을 읽지 않으므로 싣지 않는다. */
export interface OauthDenyRequest {
  request: string;
  connectionId: string;
}

/**
 * approve 본문을 짓는다. 자격 없는 채널과 요청 밖 scope 는 여기서 빠진다.
 *
 * `request` 는 화면이 지어내는 값이 아니라 서버가 서명한 봉투를 그대로 되돌려
 * 주는 것이다(규율 1). `connectionId` 는 사람이 고른 candidate 의 것이다.
 */
export function buildOauthApprove(
  request: string,
  connectionId: string,
  requestedScopes: readonly HostedAgentScope[],
  selectedScopes: readonly string[],
  channels: readonly ApprovalChannelInput[],
  selectedChannelIds: readonly string[]
): OauthApproveRequest {
  return {
    request,
    connectionId,
    approvedScopes: normalizeOauthScopes(requestedScopes, selectedScopes),
    approvedChannelIds: approvableChannelIds(channels, selectedChannelIds),
  };
}

export function buildOauthDeny(
  request: string,
  connectionId: string
): OauthDenyRequest {
  return { request, connectionId };
}

// ---- decision 응답 ----------------------------------------------------------

/** 결정이 돌려주는 것은 브라우저가 다음에 갈 곳 하나뿐이다. */
export interface OauthDecisionResult {
  /** provider 의 등록된 redirect 로 가는 절대 http(s) URL. code/state/iss 만 싣는다. */
  redirectTo: string;
  connectionId: string;
}

/**
 * decision 응답을 읽는다. `redirectTo` 가 절대 http(s) URL 인지 확인한다.
 *
 * 이 값은 서버가 운영자 등록 redirect(claims.ru)로 지은 것이라 신뢰할 수 있지만,
 * 화면은 이 값으로 `location.replace` 를 부른다. 그래서 `javascript:`·`data:` 같은
 * scheme 을 여기서 막는다 — 신뢰하는 값이라도 브라우저를 다른 scheme 으로 보내지
 * 않는다는 규율은 웹훅 수신 URL(presets.ts `agentPortEndpoint`)이 이미 세운 것이다.
 *
 * `connectionId` 가 방금 결정을 보낸 그 연결과 다르면 형상 오류다: 이 응답이
 * 다른 연결의 것이면 그 redirect 를 따라가서는 안 된다.
 */
export function parseOauthDecision(
  wire: unknown,
  expected: { connectionId: string }
): OauthDecisionResult {
  const row = record(wire);
  const redirectTo = str(row, "redirectTo");
  const connectionId = str(row, "connectionId");
  if (!redirectTo || !connectionId) throw new WireShapeError();
  let parsed: URL;
  try {
    parsed = new URL(redirectTo);
  } catch {
    throw new WireShapeError();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WireShapeError();
  }
  if (connectionId.toLowerCase() !== expected.connectionId.toLowerCase()) {
    throw new WireShapeError();
  }
  return { redirectTo, connectionId };
}

// ---- 만료 -------------------------------------------------------------------

export interface OauthRequestExpiry {
  expired: boolean;
  /** 남은 시간 한 마디. 분으로 반올림해 초 단위로 흔들리지 않게 한다. */
  label: string;
}

/**
 * 이 인가 요청이 언제까지 유효한가.
 *
 * 만료된 요청은 승인해도 서버가 404 로 거절한다(봉투의 `exp` 검증). 그래서 화면은
 * 사람이 읽는 동안 만료가 지나면 승인 버튼을 거두고 이 사실을 말해야 한다. 초를
 * 그리지 않는 이유는 pairing 만료(wizard.ts `pairingExpiry`)와 같다: 매초 바뀌는
 * 숫자는 사람을 재촉할 뿐이고 이 표면의 모션 규율과 어긋난다.
 */
export function oauthRequestExpiry(
  expiresAtMs: number,
  nowMs: number
): OauthRequestExpiry {
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return { expired: true, label: "만료됨" };
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return { expired: false, label: "1분 안에 만료" };
  return { expired: false, label: `약 ${minutes}분 뒤 만료` };
}

// ---- 거절 -------------------------------------------------------------------

export type OauthConsentAction = "preview" | "approve" | "deny";

/**
 * 이 오류가 non-enumerable "지금 열 수 없는 요청"인가.
 *
 * 404(만료·위조·재생·타 워크스페이스·비관리자·OAuth 비활성)와 403(비사람·타
 * 워크스페이스 경로)을 함께 접는다. 이 둘은 "이 요청을 이 사람이 이 자리에서 열
 * 수 없다"는 한 사실이고, 화면은 그 안을 들여다보게 하지 않는다. 참이면 capability
 * 0 의 정직한 종료 화면을 그린다.
 */
export function isOauthRequestUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** 로그인 세션이 끝난 경우. 화면은 이때만 다시 로그인으로 되돌린다. */
export function isOauthSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * 이 결정이 이미 내려졌는가 (단 하나의 terminal decision).
 *
 * 서버는 중복 클릭·새로고침·뒤로-가서-다시·늦게 온 콜백을 전부 같은 409 로 답한다
 * (#1368 `exactly_one_terminal_decision_survives_duplicate_submission`). 화면은
 * 그것을 오류가 아니라 "이미 끝났다"로 그린다.
 */
export function isOauthAlreadyDecided(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function oauthActionPrefix(action: OauthConsentAction): string {
  switch (action) {
    case "preview":
      return "인가 요청을 불러오지 못했습니다.";
    case "approve":
      return "승인을 저장하지 못했습니다.";
    case "deny":
      return "거부를 저장하지 못했습니다.";
  }
}

/**
 * 무슨 일이 있었고 다음에 무엇을 할지. STATUS 로만 분기하고 wire 문자열은 절대
 * 이어 붙이지 않는다(model.ts 규율 3). 어떤 경우에도 static bearer 로 내려가라고
 * 말하지 않는다 — 실패의 답은 언제나 provider 에서 다시 시작하는 것이다.
 */
export function oauthConsentFailureMessage(
  action: OauthConsentAction,
  error: unknown
): string {
  const prefix = oauthActionPrefix(action);
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return `${prefix} 고른 권한이나 채널을 서버가 거절했습니다. 요청된 범위 안에서만 승인할 수 있습니다.`;
      case 401:
        return `${prefix} 로그인 세션이 만료되었습니다. 다시 로그인한 뒤 이 요청을 여세요.`;
      case 403:
      case 404:
        // non-enumerable (규율 4). 사유를 나누지 않는다.
        return `${prefix} 이 요청은 만료됐거나 이미 처리됐거나 이 워크스페이스에서 열 수 없는 요청입니다. 이 화면에서는 아무 권한도 열리지 않습니다. 필요하면 provider에서 연결을 다시 시작하세요.`;
      case 409:
        return `${prefix} 이 요청은 이미 처리됐습니다. 결정은 하나만 기록되고 이 화면에서는 더 진행하지 않습니다.`;
      case 429:
        return `${prefix} 요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.`;
      default:
        return `${prefix} 잠시 뒤에 다시 시도하세요.`;
    }
  }
  if (error instanceof WireShapeError) {
    return `${prefix} 서버 응답을 확인하지 못했습니다. provider에서 연결을 다시 시작하세요.`;
  }
  return `${prefix} 잠시 뒤에 다시 시도하세요.`;
}

// ---- 화면이 이름을 짓지 않는 사실들 -----------------------------------------

/**
 * consent 화면이 그리는 서버 사실들 — 전부 서버가 도출했거나 운영자가 등록한 것.
 *
 * clientId·redirectUri 를 "운영자 등록"으로 적는 것이 규율 3 이다. 이 목록은
 * candidate(전용 에이전트)와 워크스페이스 이름을 받지 않는다: 그 둘은 화면이 이미
 * 아는 값이라 이 파일이 아니라 화면이 자기 자리에 세운다.
 */
export interface OauthConsentFact {
  key: string;
  value: string;
  /** 식별자·경로처럼 아무 데서나 끊어도 되는 값인가. */
  token?: boolean;
}

export function oauthConsentFacts(preview: OauthConsentPreview): OauthConsentFact[] {
  return [
    { key: "요청한 외부 클라이언트", value: preview.clientId, token: true },
    { key: "승인 뒤 돌아갈 주소", value: preview.redirectUri, token: true },
    { key: "허용 대상(Agent Port 자원)", value: preview.resource, token: true },
    { key: "인가 서버", value: preview.issuer, token: true },
  ];
}

// ---- 문구 -------------------------------------------------------------------

export const OAUTH_CONSENT_TITLE = "외부 에이전트 연결 승인";

export const OAUTH_CONSENT_LEAD =
  "외부 provider가 이 워크스페이스의 전용 에이전트로 접속하려고 합니다. 아래 권한을 직접 확인하고 승인하거나 거부하세요. 감지됐다는 사실은 권한의 근거가 아닙니다.";

/** clientId·redirectUri 가 무엇인지 (규율 3). 운영자가 검증한 값임을 말한다. */
export const OAUTH_CONSENT_CLIENT_NOTE =
  "요청한 클라이언트와 돌아갈 주소는 이 워크스페이스 운영자가 미리 등록한 값입니다. 등록되지 않은 provider는 이 화면까지 오지 못합니다.";

/** 승인이 사람만의 보안 결정이고, 닫기·뒤로가기가 권한을 열지 않는다는 사실. */
export const OAUTH_CONSENT_SECURITY_NOTE =
  "이 승인은 사람만 내릴 수 있는 보안 결정입니다. 이 창을 닫거나 뒤로 가면 아무 권한도 열리지 않고, 그것은 거부와 같습니다. 승인은 아래 버튼으로만 일어납니다.";

/** candidate 하나를 골라야 하는 자리의 안내. */
export const OAUTH_CONSENT_PICK_AGENT_HINT =
  "이 인가는 대기 중인 전용 에이전트 하나에 묶입니다. 어느 에이전트로 접속을 허용할지 고르세요.";

/** candidate 가 없을 때. capability 0 의 정직한 종료. */
export const OAUTH_CONSENT_NO_CANDIDATE_HEADLINE =
  "이 요청에 묶을 대기 중인 연결이 없습니다.";

export const OAUTH_CONSENT_NO_CANDIDATE_DETAIL =
  "이 워크스페이스에는 이 인가 요청을 받을 대기 중인 OAuth 전용 에이전트가 없습니다. 이 화면에서는 아무 권한도 열리지 않습니다. provider에서 연결을 다시 시작하세요.";

/** 요청이 만료된 자리. */
export const OAUTH_CONSENT_EXPIRED_HEADLINE = "이 인가 요청이 만료됐습니다.";

export const OAUTH_CONSENT_EXPIRED_DETAIL =
  "만료된 요청은 승인할 수 없습니다. 이 화면에서는 아무 권한도 열리지 않습니다. provider에서 연결을 다시 시작하세요.";

/** 요청 id 없이 이 화면에 닿은 경우(잘못된 링크). */
export const OAUTH_CONSENT_MISSING_HEADLINE = "인가 요청을 찾을 수 없습니다.";

export const OAUTH_CONSENT_MISSING_DETAIL =
  "이 주소에는 확인할 인가 요청이 없습니다. provider의 연결 화면에서 다시 시작하면 올바른 요청으로 이 화면이 열립니다.";

/** non-enumerable 종료 화면(404/403). */
export const OAUTH_CONSENT_UNAVAILABLE_HEADLINE = "이 인가 요청을 열 수 없습니다.";

export const OAUTH_CONSENT_UNAVAILABLE_DETAIL =
  "이 요청은 만료됐거나 이미 처리됐거나 이 워크스페이스에서 열 수 없는 요청입니다. 이 화면에서는 아무 권한도 열리지 않습니다. 필요하면 provider에서 연결을 다시 시작하세요.";

/** 결정 뒤 provider 로 돌아가는 짧은 종료. */
export const OAUTH_CONSENT_RETURNING = "결정을 저장했습니다. provider로 돌아가는 중입니다.";

/** 로그아웃 상태에서 이 화면에 온 사람에게. */
export const OAUTH_CONSENT_SIGNIN_HEADLINE = "먼저 로그인하세요.";

export const OAUTH_CONSENT_SIGNIN_DETAIL =
  "이 인가 요청을 확인하려면 이 워크스페이스에 로그인해야 합니다. 로그인하면 이 요청으로 돌아옵니다.";

export const OAUTH_CONSENT_APPROVE_LABEL = "이 범위로 승인";

export const OAUTH_CONSENT_DENY_LABEL = "거부";
