import { record } from "../../lib/wire";
import { attachParticle, particleFor } from "../../lib/koreanParticle";

function isRecord(value: unknown): value is Record<string, unknown> {
  return record(value) !== null;
}

// =============================================================================
// hosted 에이전트 1:1 DM 승인 (ADR-0162 증보 2 / #2915) · DM 컴포저 힌트 (#2891).
//
// 규칙은 서버가 정한다. 이 파일은 서버가 알려 준 상태를 **사람 말로 옮길**
// 뿐이다.
//
//   * 소유자와 자기 에이전트의 1:1 DM은 저절로 열린다. 저장된 값이 아니라서
//     끄는 버튼이 없다.
//   * 다른 멤버와의 DM은 소유자가 한 DM씩 연다. 기본은 닫힘.
//   * 구독 에이전트(소유자 전용)는 소유자 DM만. 다른 DM은 열 수 없다.
//
// 컴포저 힌트는 「멘션 없이 바로 말하면 …가 답합니다」를 **전달이 열린 DM에서만**
// 쓴다. 호스티드 에이전트에게 그 문장은 승인 전까지 거짓이었다(#2891).
// =============================================================================

export type HostedDmApprovalState =
  | "owner"
  | "approved"
  | "unapproved"
  | "not_approvable";

export interface HostedDmApprovalRow {
  channelId: string;
  counterpartMemberId: string;
  state: HostedDmApprovalState;
}

export interface HostedDmApprovals {
  connectionId: string;
  agentMemberId: string;
  ownerMemberId: string | null;
  /** 내가 소유자이고 연결이 살아 있다. */
  canEdit: boolean;
  ownerOnly: boolean;
  dms: HostedDmApprovalRow[];
}

const APPROVAL_STATES: readonly HostedDmApprovalState[] = [
  "owner",
  "approved",
  "unapproved",
  "not_approvable",
];

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseRow(value: unknown): HostedDmApprovalRow | null {
  if (!isRecord(value)) return null;
  const channelId = str(value.channelId);
  const counterpartMemberId = str(value.counterpartMemberId);
  const state = APPROVAL_STATES.find((known) => known === value.state);
  if (channelId === null || counterpartMemberId === null || state === undefined) {
    return null;
  }
  return { channelId, counterpartMemberId, state };
}

/** 모르는 상태 단어의 줄은 버린다. 모르는 것을 「열림」으로 그리지 않는다. */
export function parseHostedDmApprovals(value: unknown): HostedDmApprovals | null {
  if (!isRecord(value)) return null;
  const connectionId = str(value.connectionId);
  const agentMemberId = str(value.agentMemberId);
  if (connectionId === null || agentMemberId === null) return null;
  const dms = Array.isArray(value.dms)
    ? value.dms.map(parseRow).filter((row): row is HostedDmApprovalRow => row !== null)
    : [];
  return {
    connectionId,
    agentMemberId,
    ownerMemberId: str(value.ownerMemberId),
    canEdit: value.canEdit === true,
    ownerOnly: value.ownerOnly === true,
    dms,
  };
}

/** PUT/DELETE 응답의 한 줄. */
export function parseHostedDmApprovalWrite(value: unknown): HostedDmApprovalRow | null {
  return isRecord(value) ? parseRow(value.dm) : null;
}

/** 승인 줄을 목록에 끼워 넣는다(다시 받아 오기 전의 몇 백 밀리초). */
export function applyHostedDmApproval(
  list: HostedDmApprovals,
  row: HostedDmApprovalRow
): HostedDmApprovals {
  return {
    ...list,
    dms: list.dms.map((dm) =>
      dm.channelId === row.channelId ? { ...dm, state: row.state } : dm
    ),
  };
}

// ---- 설정 › 에이전트 자격 › 1:1 대화 ---------------------------------------

export const DM_APPROVAL_HEADLINE = "1:1 대화";

export function dmApprovalLead(agentName: string): string {
  return `${agentName}${particleFor(agentName, "topic")} 소유자와의 1:1 대화에서 바로 답합니다. 다른 멤버와의 대화는 소유자가 하나씩 열어야 답합니다.`;
}

export const DM_APPROVAL_OWNER_ONLY_LEAD =
  "개인 에이전트라 소유자와의 1:1 대화에서만 답합니다. 다른 멤버와의 대화는 열 수 없습니다.";
export const DM_APPROVAL_EMPTY_HEADLINE = "아직 이 에이전트와 나눈 1:1 대화가 없습니다.";
export const DM_APPROVAL_EMPTY_DETAIL =
  "멤버가 이 에이전트에게 1:1 대화를 시작하면 여기에 줄이 생깁니다.";
export const DM_APPROVAL_LOADING_LABEL = "1:1 대화 목록을 불러오는 중입니다.";
export const DM_APPROVAL_OPEN_LABEL = "대화 열기";
export const DM_APPROVAL_CLOSE_LABEL = "대화 닫기";
export const DM_APPROVAL_OPEN_CONFIRM = "열기";
export const DM_APPROVAL_CLOSE_CONFIRM = "닫기";
export const DM_APPROVAL_BUSY_LABEL = "바꾸는 중";
export const DM_APPROVAL_OFFLINE_NOTE =
  "연결이 끊겨 지금은 바꿀 수 없습니다. 다시 연결되면 여기서 바꿀 수 있습니다.";

export function dmApprovalOpenQuestion(memberName: string): string {
  return `${memberName}님과의 대화 내용을 이 에이전트가 읽고 답하게 할까요?`;
}

export function dmApprovalCloseQuestion(memberName: string): string {
  return `${memberName}님과의 대화를 닫을까요? 이후 메시지는 에이전트에게 가지 않습니다.`;
}

/** 읽기 전용일 때 목록 위에 한 번 선다. */
export function dmApprovalReadOnlyNote(ownerName: string | null): string {
  return ownerName === null
    ? "소유자가 없는 에이전트라 다른 멤버와의 대화를 열 수 없습니다."
    : `${ownerName}님(소유자)만 바꿀 수 있습니다.`;
}

export function dmApprovalStateLabel(state: HostedDmApprovalState): string {
  switch (state) {
    case "owner":
      return "소유자 대화, 항상 열림";
    case "approved":
      return "열림";
    case "unapproved":
      return "닫힘";
    case "not_approvable":
      return "열 수 없음";
  }
}

export function dmApprovalStateTone(
  state: HostedDmApprovalState
): "ok" | "muted" {
  return state === "owner" || state === "approved" ? "ok" : "muted";
}

export function dmApprovalFailureMessage(status: number | null): string {
  switch (status) {
    case 403:
      return "소유자만 이 대화를 열거나 닫을 수 있습니다.";
    case 409:
      return "이 대화는 지금 바꿀 수 없습니다. 목록을 새로 불러와 상태를 확인해 주세요.";
    case 422:
      return "이제 1:1 대화가 아니라 열 수 없습니다. 목록을 새로 불러와 주세요.";
    default:
      return "바꾸지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
  }
}

// ---- DM 컴포저 힌트 (#2891) --------------------------------------------------

export type AgentDmDeliveryState =
  | "not_hosted"
  | "open"
  | "awaiting_owner"
  | "owner_only"
  | "not_approvable"
  | "connection_unavailable"
  | "delivery_disabled"
  | "subscription_disabled";

const DELIVERY_STATES: readonly AgentDmDeliveryState[] = [
  "not_hosted",
  "open",
  "awaiting_owner",
  "owner_only",
  "not_approvable",
  "connection_unavailable",
  "delivery_disabled",
  "subscription_disabled",
];

export interface AgentDmDelivery {
  agentMemberId: string | null;
  ownerMemberId: string | null;
  /** `null`: 에이전트 1:1 DM이 아니다. */
  state: AgentDmDeliveryState | null;
}

/** 모르는 상태 단어는 `null`로 읽는다. 모르는 것을 「답합니다」로 약속하지 않는다. */
export function parseAgentDmDelivery(value: unknown): AgentDmDelivery | null {
  if (!isRecord(value)) return null;
  const state = DELIVERY_STATES.find((known) => known === value.state) ?? null;
  return {
    agentMemberId: str(value.agentMemberId),
    ownerMemberId: str(value.ownerMemberId),
    state,
  };
}

/** 이 상태에서 말하면 에이전트가 답하는가. */
export function dmDeliveryAnswers(state: AgentDmDeliveryState): boolean {
  return state === "open" || state === "not_hosted";
}

/**
 * 힌트 문장. `agentSubject`는 조사가 붙은 이름(「hermes가」), `agentName`은
 * 조사 없는 이름, `ownerName`은 소유자 표시 이름(없으면 「소유자」).
 */
export function dmComposerHint(
  state: AgentDmDeliveryState,
  names: { agentSubject: string; agentName: string; ownerName: string | null }
): string {
  const owner = names.ownerName === null ? "소유자" : `${names.ownerName}님`;
  switch (state) {
    case "not_hosted":
    case "open":
      return `멘션 없이 바로 말하면 ${names.agentSubject} 답합니다`;
    case "awaiting_owner":
      return `${attachParticle(owner)} 이 대화를 열어야 ${names.agentSubject} 답합니다`;
    case "owner_only":
      return `${owner}의 개인 에이전트라 이 대화에는 답하지 않습니다`;
    case "not_approvable":
      return `${names.agentSubject} 이 대화에는 답하지 않습니다`;
    case "connection_unavailable":
      return `${names.agentName}의 연결이 끊겨 있어 지금은 답하지 않습니다`;
    case "delivery_disabled":
      return "이 서버에서 외부 에이전트 전달이 꺼져 있어 답하지 않습니다";
    case "subscription_disabled":
      return "이 서버에서 구독 에이전트가 꺼져 있어 답하지 않습니다";
  }
}
