import { uuidEq, type RosterMember } from "../../lib/api";
import type { HostedAgentConnection } from "./model";
import { regenerateGate } from "./wizard";

// =============================================================================
// 로컬 호스티드 에이전트 감지 레지스트리 (T-5 / #1655, E4·E5).
//
// 데스크탑 셸이 수동적 시그니처(앱 번들 경로·번들 id·실행 프로세스 이름)만
// 관찰하고, 이 파일이 그 관찰을 **제품 결정**으로 바꾼다: 초대할 것인가,
// 재발급인가, 침묵인가. 위저드 단계 기계(`./wizard`)는 건드리지 않는다.
//
// ## 왜 코어에 살리는가
//
// 시그니처와 초대 문장은 웹과 폰이 같이 읽어야 하고, 셸은 관찰만 한다. 셸이
// "그록봇을 초대할까요"를 지어내면 다음 에이전트를 넣을 때 Rust와 카피가
// 갈라진다. 관찰 허용 목록의 문자열은 셸에 **같은 리터럴**로 복제된다
// (`clients/desktop/src-tauri/src/detect.rs`) — 웹뷰가 임의 경로를 넘겨
// 파일시스템 오라클이 되는 길을 막기 위해서다. 두 표가 어긋나면 아래 테스트와
// Rust 쪽 테스트가 각자 자기 리터럴을 고정하므로, 한쪽만 고친 PR 은 그 쪽에서
// 붉어진다.
//
// ## 수동적 시그니처만
//
// 그록봇 앱을 프로그램으로 제어하는 경로와 루프백 포트 스캔은 이 레지스트리에
// 자리가 없다 (패킷 §0-2). v1 시그니처는 Grok Bot 하나다.
// =============================================================================

/** v1 감지기 id. 셸 프로브의 `id` 와 같다. */
export const GROK_HOSTED_AGENT_ID = "grok";

export interface HostedAgentIdentity {
  displayName: string;
  handle: string;
}

export interface HostedAgentSignature {
  id: string;
  identity: HostedAgentIdentity;
  /**
   * 설치 경로. 셸만 읽는다. 웹 번들은 이 문자열로 파일을 열지 않는다.
   */
  bundlePaths: readonly string[];
  bundleIds: readonly string[];
  processNames: readonly string[];
  invitePrompt: string;
  inviteActionLabel: string;
  recoverPrompt: string;
  recoverActionLabel: string;
}

/**
 * 확장 가능한 레지스트리. v1 은 Grok Bot 한 줄. 다음 에이전트는 여기 한 줄과
 * 셸 허용 목록 한 줄을 같이 더한다.
 */
export const HOSTED_AGENT_SIGNATURES: readonly HostedAgentSignature[] = [
  {
    id: GROK_HOSTED_AGENT_ID,
    identity: { displayName: "그록봇", handle: "grokbot" },
    bundlePaths: ["/Applications/Grok Bot.app"],
    bundleIds: ["com.anysphere.sand"],
    processNames: ["Grok Bot"],
    invitePrompt: "그록봇을 팀에 초대할까요?",
    inviteActionLabel: "팀에 초대하기",
    recoverPrompt: "그록봇 연결 값을 다시 발급할까요?",
    recoverActionLabel: "연결 값 다시 발급",
  },
];

export function hostedAgentSignature(
  id: string
): HostedAgentSignature | null {
  return HOSTED_AGENT_SIGNATURES.find((row) => row.id === id) ?? null;
}

/** 셸이 허용 목록 한 줄에 대해 돌려주는 관찰. 제품 문장은 없다. */
export interface HostedAgentProbe {
  id: string;
  bundlePresent: boolean;
  processRunning: boolean;
}

/** 설치 또는 실행 중이면 감지. 둘 다 거짓이면 이 줄은 침묵이다. */
export function hostedAgentDetected(probe: HostedAgentProbe): boolean {
  return probe.bundlePresent || probe.processRunning;
}

export type HostedInviteKind = "invite" | "recover";

export interface HostedInvitePlan {
  kind: HostedInviteKind;
  signatureId: string;
  displayName: string;
  handle: string;
  prompt: string;
  actionLabel: string;
  /** 재발급할 기존 연결. invite 에는 없다. */
  connectionId?: string;
  /**
   * 위저드가 열리자마자 밟을 발급. 핸들이 이미 쓰이면 create 를 생략해
   * identity 단계로 떨어진다 (수동 폴백).
   */
  autoAdvance?: "create" | "regenerate";
}

function foldHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

function foldName(raw: string): string {
  return raw.trim().toLowerCase();
}

function isUsableAgent(member: RosterMember): boolean {
  return (
    member.kind === "agent" &&
    member.status !== "deleted" &&
    member.status !== "suspended"
  );
}

/** 이 identity 에 해당하는 에이전트 멤버. 핸들이 이름보다 앞선다. */
export function matchHostedAgentMember(
  members: readonly RosterMember[],
  identity: HostedAgentIdentity
): RosterMember | null {
  const handle = foldHandle(identity.handle);
  const byHandle = members.find(
    (member) => isUsableAgent(member) && foldHandle(member.handle) === handle
  );
  if (byHandle) return byHandle;
  const name = foldName(identity.displayName);
  return (
    members.find(
      (member) =>
        isUsableAgent(member) && foldName(member.displayName) === name
    ) ?? null
  );
}

function connectionForMember(
  connections: readonly HostedAgentConnection[],
  memberId: string
): HostedAgentConnection | null {
  const mine = connections.filter((row) => uuidEq(row.agentMemberId, memberId));
  return mine.find((row) => regenerateGate(row).allowed) ?? mine[0] ?? null;
}

function handleTaken(
  members: readonly RosterMember[],
  handle: string
): boolean {
  const folded = foldHandle(handle);
  return members.some(
    (member) =>
      member.status !== "deleted" && foldHandle(member.handle) === folded
  );
}

/**
 * 감지 관찰 + 명부 + 연결 목록 → 초대 한 줄, 또는 침묵(`null`).
 *
 * 미감지는 호출부가 그리지 않는다. 활성 연결은 재발급이 409 이므로 같은 침묵이다.
 */
export function planHostedInvite(input: {
  probes: readonly HostedAgentProbe[];
  members: readonly RosterMember[];
  connections: readonly HostedAgentConnection[];
  signatureId?: string;
}): HostedInvitePlan | null {
  const signature = hostedAgentSignature(
    input.signatureId ?? GROK_HOSTED_AGENT_ID
  );
  if (!signature) return null;
  const probe = input.probes.find((row) => row.id === signature.id);
  if (!probe || !hostedAgentDetected(probe)) return null;

  const member = matchHostedAgentMember(input.members, signature.identity);
  const connection = member
    ? connectionForMember(input.connections, member.id)
    : null;

  if (connection && regenerateGate(connection).allowed) {
    return {
      kind: "recover",
      signatureId: signature.id,
      displayName: signature.identity.displayName,
      handle: signature.identity.handle,
      prompt: signature.recoverPrompt,
      actionLabel: signature.recoverActionLabel,
      connectionId: connection.id,
      autoAdvance: "regenerate",
    };
  }
  if (connection) return null;

  const taken = handleTaken(input.members, signature.identity.handle);
  return {
    kind: "invite",
    signatureId: signature.id,
    displayName: signature.identity.displayName,
    handle: signature.identity.handle,
    prompt: signature.invitePrompt,
    actionLabel: signature.inviteActionLabel,
    ...(taken ? {} : { autoAdvance: "create" as const }),
  };
}
