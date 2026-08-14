import { attachParticle } from "../../lib/koreanParticle";
import {
  boundedLabel,
  isHostedScope,
  HOSTED_AGENT_PORT_AUDIENCE,
  HOSTED_AUTH_MODE,
  type HostedAgentConnection,
  type HostedAgentScope,
} from "./model";
import type { HostedGate } from "./wizard";

// =============================================================================
// 사람이 내리는 보안 결정 — 정확히 어느 채널과 어느 권한인가
// (ADR-0162 D6 4항, goal HAP-UX1 / #1360).
//
// 이 파일은 마법사에서 유일하게 **되돌릴 수 없는 판단**이 사는 자리다. 감지는
// 기계가 하고 활성은 상대 에이전트가 증명하지만, "이 에이전트가 어느 대화에
// 들어가도 되는가"는 사람만 답할 수 있다. 서버도 같은 자리에 두 겹의 문을 세워
// 두었다: confirm 이 채널 자격을 재검사하고(`valid_channels`), hosted job claim SQL
// 이 매 호출 현재 승인 집합을 다시 본다(#1366). 그래서 이 화면의 일은 문을 지키는
// 것이 아니라 **사람이 무엇을 허락하는지 읽을 수 있게 적는 것**이다.
//
// ## 규율 1 — 결과 문장은 언제나 보인다
//
// 각 권한 줄이 자기 결과를 한 문장으로 달고 있고(hover 나 disclosure 뒤가 아니다),
// 고른 것 전체가 무엇을 뜻하는지도 저장 버튼 바로 위에 문장으로 선다. 권한
// 이름만 나열된 목록은 읽는 사람에게 결정이 아니라 받아쓰기다.
//
// ## 규율 2 — 자격 없는 줄은 숨기지 않고 **사유와 함께 세운다**
//
// features/timeline/spawnHostChoice.ts 가 호스트 목록에서 이미 정한 규율을 그대로
// 잇는다. 회색으로 처리된 "1:1 대화 (승인 대상 아님)" 가 "왜 내 DM 이 목록에
// 없지"의 정직한 답이고, 빈 목록은 아니다.
//
// ## 규율 3 — 고를 수 없는 것은 **보내지 않는다** (fail-closed)
//
// `buildConfirmApproval` 은 자격 없는 채널 id 와 이 빌드가 모르는 scope 를 본문에
// 싣지 않는다. 서버가 같은 것을 다시 막지만, 화면이 고를 수 있는 것처럼 보여
// 놓고 서버가 거절하는 것은 막은 것이 아니라 거짓말한 뒤 막은 것이다.
// =============================================================================

// ---- 권한 -------------------------------------------------------------------

export interface HostedScopeChoice {
  id: HostedAgentScope;
  label: string;
  /** 이 권한을 켜면 무슨 일이 생기는가. 상시 노출된다 (규율 1). */
  detail: string;
  /** 끌 수 없는 권한인가. */
  required: boolean;
  /** 왜 끌 수 없는가. 체크박스가 잠긴 자리에 그대로 선다. */
  requiredReason?: string;
}

/**
 * 닫힌 권한 목록과 각 권한의 결과 문장.
 *
 * 문장은 openapi `HostedAgentScope` 의 tool 매핑을 사람 말로 옮긴 것이다.
 * `agent:port:connect` 가 "도달만 하고 아무 도구도 열지 않는다"는 것은 이 흐름의
 * 가장 중요한 사실 중 하나다: 감지된 에이전트가 아직 아무것도 못 하는 이유가
 * 그것이고, 그래서 이 줄은 목록의 맨 위에 있고 끌 수 없다.
 */
export const HOSTED_SCOPE_CHOICES: readonly HostedScopeChoice[] = [
  {
    id: "agent:port:connect",
    label: "접속",
    detail:
      "이 에이전트가 oort에 접속만 합니다. 대화도 작업도 이 권한만으로는 열리지 않습니다.",
    required: true,
    requiredReason: "접속 없이는 나머지 권한이 아무것도 열지 못하므로 항상 포함됩니다.",
  },
  {
    id: "agent:inbox:read",
    label: "부름 읽기",
    detail:
      "승인한 채널에서 이 에이전트를 부른 메시지를 순서대로 읽습니다. 부르지 않은 대화는 오지 않습니다.",
    required: false,
  },
  {
    id: "messages:read",
    label: "지난 대화 읽기",
    detail:
      "승인한 채널의 지난 메시지를 읽습니다. 승인하지 않은 채널의 대화는 읽지 못합니다.",
    required: false,
  },
  {
    id: "messages:write",
    label: "메시지 쓰기",
    detail:
      "승인한 채널에 이 에이전트 이름으로 메시지를 씁니다. 사람이 쓴 것과 같은 자리에 남습니다.",
    required: false,
  },
  {
    id: "agent:jobs:read",
    label: "작업 가져가기",
    detail:
      "승인한 채널에서 만들어진 작업을 가져가 진행합니다. 다른 에이전트의 작업은 가져가지 못합니다.",
    required: false,
  },
  {
    id: "agent:runs:callback",
    label: "작업 결과 보고",
    detail:
      "가져간 작업의 진행과 결과를 보고합니다. 이 권한이 없으면 작업이 끝났는지 알 수 없습니다.",
    required: false,
  },
];

/** 서버가 반드시 요구하는 권한 (`validate_hosted_scopes`). */
export const REQUIRED_HOSTED_SCOPE: HostedAgentScope = "agent:port:connect";

/**
 * 처음 체크되어 있는 권한.
 *
 * "부르면 읽고 답한다"는 가장 작은 쓸모 있는 조합이다. 작업 두 줄(가져가기·보고)과
 * 지난 대화 읽기는 **끄고 시작한다** — 최소 권한의 뜻은 기본값이 필요를 따라가는
 * 것이지, 권한 목록을 다 켜 두고 사람에게 빼라고 시키는 것이 아니다.
 */
export const DEFAULT_HOSTED_SCOPES: readonly HostedAgentScope[] = [
  "agent:port:connect",
  "agent:inbox:read",
  "messages:write",
];

/** 목록 순서대로, 중복 없이, 필수 권한을 반드시 포함해서. */
export function normalizeScopes(
  selected: readonly string[]
): HostedAgentScope[] {
  const wanted = new Set<HostedAgentScope>([REQUIRED_HOSTED_SCOPE]);
  for (const scope of selected) {
    if (isHostedScope(scope)) wanted.add(scope);
  }
  return HOSTED_SCOPE_CHOICES.filter((choice) => wanted.has(choice.id)).map(
    (choice) => choice.id
  );
}

/**
 * 고른 권한이 저장할 수 있는 조합인가.
 *
 * 필수 권한은 `normalizeScopes` 가 이미 되돌려 놓으므로 여기서 막힐 일은 하나뿐이다:
 * 접속 말고 아무것도 고르지 않은 경우. 그것은 서버가 거절하지 않지만
 * (`agent:port:connect` 하나도 유효한 집합이다) 사람이 의도한 결과일 가능성이
 * 낮으므로 저장을 막는 대신 **결과 문장이 그 사실을 말한다**. 그래서 이 게이트는
 * 상태가 아니라 조합만 본다.
 */
export function scopeGate(scopes: readonly HostedAgentScope[]): HostedGate {
  if (!scopes.includes(REQUIRED_HOSTED_SCOPE)) {
    return {
      allowed: false,
      blockedCopy: "접속 권한 없이는 저장할 수 없습니다.",
    };
  }
  return { allowed: true };
}

// ---- 채널 -------------------------------------------------------------------

/** 화면이 이미 이름을 지어 건네는 채널 한 줄. */
export interface ApprovalChannelInput {
  id: string;
  /** 화면 말로 지어진 이름. 코어는 이름을 짓지 않는다. */
  label: string;
  kind: "public" | "private" | "dm";
  archivedAtMs?: number;
}

export interface ApprovalChannelChoice {
  id: string;
  label: string;
  /** 이 줄이 무엇인지, 또는 왜 고를 수 없는지. 상시 노출된다. */
  detail: string;
  disabled: boolean;
}

/**
 * 서버가 승인 대상으로 받는 채널인가.
 *
 * `confirm_hosted_connection_in_tx` 의 `valid_channels` 그대로다:
 * `archived_at IS NULL AND kind <> 'dm'`. 여기서 규칙이 갈라지면 화면이 고르게 해
 * 놓고 서버가 400 으로 거절한다.
 */
export function isApprovableChannel(channel: ApprovalChannelInput): boolean {
  return channel.kind !== "dm" && channel.archivedAtMs === undefined;
}

function channelDetail(channel: ApprovalChannelInput): string {
  if (channel.kind === "dm") {
    return "1:1 대화는 승인 대상이 아닙니다. 에이전트는 채널에서만 부릅니다.";
  }
  if (channel.archivedAtMs !== undefined) {
    return "보관된 채널입니다. 다시 열면 승인할 수 있습니다.";
  }
  return channel.kind === "private"
    ? "비공개 채널입니다. 승인하면 이 채널의 멤버가 됩니다."
    : "공개 채널입니다. 승인하면 이 채널의 멤버가 됩니다.";
}

/**
 * 승인 목록의 모든 줄. 자격 없는 줄도 사유를 달고 선다 (규율 2).
 *
 * 정렬은 자격 있는 줄이 먼저이고, 그 안에서는 화면이 준 순서를 지킨다. 코어가
 * 다시 정렬하면 사이드바가 보여 준 순서와 승인 목록의 순서가 갈라진다.
 */
export function channelApprovalChoices(
  channels: readonly ApprovalChannelInput[]
): ApprovalChannelChoice[] {
  const eligible: ApprovalChannelChoice[] = [];
  const blocked: ApprovalChannelChoice[] = [];
  for (const channel of channels) {
    const row: ApprovalChannelChoice = {
      id: channel.id,
      label: boundedLabel(channel.label, 80),
      detail: channelDetail(channel),
      disabled: !isApprovableChannel(channel),
    };
    (row.disabled ? blocked : eligible).push(row);
  }
  return [...eligible, ...blocked];
}

/** 고른 것 중 실제로 승인 가능한 id 만. 대소문자 흔들림은 서버가 정규화한다. */
export function approvableChannelIds(
  channels: readonly ApprovalChannelInput[],
  selected: readonly string[]
): string[] {
  const wanted = new Set(selected.map((id) => id.toLowerCase()));
  const kept: string[] = [];
  for (const channel of channels) {
    if (!isApprovableChannel(channel)) continue;
    if (!wanted.has(channel.id.toLowerCase())) continue;
    if (kept.some((id) => id.toLowerCase() === channel.id.toLowerCase())) continue;
    kept.push(channel.id);
  }
  return kept;
}

// ---- 결과 문장 --------------------------------------------------------------

/** 권한 하나가 사람 말로 무엇인가. 결과 문장이 이 낱말들을 잇는다. */
function scopeAction(scope: HostedAgentScope): string | null {
  switch (scope) {
    case "agent:port:connect":
      // 접속은 결과 문장의 목록에 들어가지 않는다: 그것은 다른 권한들이 서 있는
      // 바닥이지 사람이 승인하는 행동이 아니다. 그 사실은 권한 줄 자기 문장이
      // 이미 말한다.
      return null;
    case "agent:inbox:read":
      return "자기를 부른 메시지 읽기";
    case "messages:read":
      return "지난 대화 읽기";
    case "messages:write":
      return "메시지 쓰기";
    case "agent:jobs:read":
      return "작업 가져가기";
    case "agent:runs:callback":
      return "작업 결과 보고";
  }
}

export function scopeActionList(scopes: readonly HostedAgentScope[]): string[] {
  return HOSTED_SCOPE_CHOICES.filter((choice) => scopes.includes(choice.id))
    .map((choice) => scopeAction(choice.id))
    .filter((action): action is string => action !== null);
}

/**
 * 저장 버튼 바로 위에 서는 한 문단 — 무엇을 허락하는가, 그리고 무엇이 닫히는가.
 *
 * 두 번째 문장을 빼지 않는 이유: 승인 화면은 사람이 **허락**만 읽고 넘어가기 쉬운
 * 자리인데, 이 제품에서 승인 집합의 진짜 힘은 밖을 닫는 쪽에 있다(#1366 의 claim
 * SQL 이 승인 밖 채널의 작업을 lease 하지 않는다). 닫히는 쪽을 말하지 않으면
 * 사람은 자기가 고르지 않은 채널이 어떻게 되는지 모른 채 저장한다.
 */
export function approvalConsequence(
  agentLabel: string,
  channelCount: number,
  scopes: readonly HostedAgentScope[]
): string {
  const name = attachParticle(boundedLabel(agentLabel), "topic");
  const actions = scopeActionList(scopes);
  if (channelCount === 0) {
    return `${name} 접속만 하고 어떤 대화에도 닿지 못합니다. 채널을 하나도 승인하지 않았기 때문입니다.`;
  }
  if (actions.length === 0) {
    return `${name} ${channelCount}개 채널의 멤버가 되지만 읽기도 쓰기도 하지 못합니다. 접속 말고 아무 권한도 고르지 않았기 때문입니다.`;
  }
  const list = actions.join(", ");
  return `승인하면 ${name} ${channelCount}개 채널에서 ${list}를 할 수 있습니다. 승인하지 않은 채널에서는 이 에이전트를 멘션해도 작업이 만들어지지 않습니다.`;
}

/** 승인이 되돌릴 수 없는 결정이라는 사실. 확인 버튼 옆에 상시 노출된다. */
export const APPROVAL_SECURITY_NOTE =
  "이 승인은 사람만 내릴 수 있는 보안 결정입니다. 감지됐다는 사실은 권한의 근거가 아니고, 저장하기 전까지 이 에이전트는 아무 대화에도 닿지 못합니다.";

/** 승인을 나중에 좁히거나 넓히는 법. 되돌릴 수 없다고만 말하고 끝내지 않는다. */
export const APPROVAL_CHANGE_NOTE =
  "저장한 뒤 승인 범위를 바꾸려면 연결 값을 다시 발급해 처음부터 진행합니다. 이미 발급된 자격증명은 그때 폐기됩니다.";

// ---- 전송 본문 --------------------------------------------------------------

export interface HostedConfirmApproval {
  agentMemberId: string;
  audience: string;
  approvedChannelIds: string[];
  approvedScopes: HostedAgentScope[];
  authMode: string;
}

/**
 * confirm 본문. 자격 없는 것은 여기서 빠진다 (규율 3).
 *
 * `agentMemberId` 는 사람이 고르는 값이 아니라 커넥션이 이미 들고 있는 값이다.
 * 서버는 본문의 이 값이 커넥션의 전용 멤버와 다르면 승인을 거절하는데, 그 대조가
 * 의미를 가지려면 클라이언트가 **다른 곳에서 주워 온 id** 를 싣지 않아야 한다.
 */
export function buildConfirmApproval(
  connection: HostedAgentConnection,
  channels: readonly ApprovalChannelInput[],
  selectedChannelIds: readonly string[],
  selectedScopes: readonly string[]
): HostedConfirmApproval {
  return {
    agentMemberId: connection.agentMemberId,
    audience: HOSTED_AGENT_PORT_AUDIENCE,
    approvedChannelIds: approvableChannelIds(channels, selectedChannelIds),
    approvedScopes: normalizeScopes(selectedScopes),
    authMode: HOSTED_AUTH_MODE,
  };
}
