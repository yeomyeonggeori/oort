import { uuidEq, type Channel, type RosterMember } from "@momo/core/lib/api";
import { declaredStatusLabel } from "@momo/core/features/presence/model";
import {
  AGENT_HOST_ONLINE_LABEL,
  agentHostDot,
  humanPresenceDot,
} from "@momo/core/features/presence/statusDot";

// =============================================================================
// 새 DM 모달의 순수 판정 (#3662).
//
// 모달은 「누구와」만 묻는다. 그 사람과의 DM이 이미 있으면 그 DM으로 가고, 없으면 만든다.
// 둘 다 서버가 정본이다(POST /dms는 참가자 쌍마다 멱등이라 두 번째 호출도 같은 채널을
// 준다). 여기의 `existingDmChannelId`는 서버를 건너뛰어도 되는 경우를 알아보는 것뿐이다:
// 목록에 이미 그 1:1 DM이 있으면 네트워크 없이 바로 간다(오프라인에서도 열리는 길).
// =============================================================================

/**
 * 나와 `peerId` 둘뿐인 보관되지 않은 DM의 id, 없으면 null. 셋 이상의 DM은 같은 사람이 끼어
 * 있어도 「그 사람과의 DM」이 아니므로 세지 않는다. 비교는 대소문자를 가리지 않는다.
 */
export function existingDmChannelId(
  channels: readonly Channel[],
  selfMemberId: string,
  peerId: string
): string | null {
  for (const channel of channels) {
    if (channel.kind !== "dm" || channel.archivedAtMs !== undefined) continue;
    const others = (channel.memberIds ?? []).filter((id) => !uuidEq(id, selfMemberId));
    if (others.length === 1 && uuidEq(others[0], peerId)) return channel.id;
  }
  return null;
}

/** 새 DM의 상대가 될 수 있는 사람: 나를 뺀 활동 중 멤버(사람·에이전트). */
export function newDmCandidates(
  members: readonly RosterMember[],
  selfMemberId: string
): RosterMember[] {
  return members.filter((m) => m.status === "active" && !uuidEq(m.id, selfMemberId));
}

export type PeerDot = "online" | "away" | "dnd";

/**
 * 상대 옆의 상태 점. **알 수 있는 것만** 그린다: 웹 명부에는 다른 사람의 접속 여부가 없으므로
 * (design-review #1889 H-3) 사람은 스스로 정한 자리 비움·방해 금지만, 에이전트는 호스트가
 * 닿아 있음(`hostOnline`)만 점이 된다. 사람의 「온라인」 초록 점은 근거가 없어 만들지 않는다.
 * 방해 금지는 만료 시각이 지나면 자동(auto)으로 본다(서버는 만료 때 이벤트를 보내지 않는다).
 */
export function peerDot(member: RosterMember | null, nowMs: number): PeerDot | null {
  if (!member) return null;
  // 판정은 코어 한 곳이다(`presence/statusDot.ts`): 사이드바 DM 행의 상태 점(#3964)과 같은 규칙을 읽는다.
  // 이 모달은 생존 판정을 따로 묻지 않으므로 에이전트는 호스트 연결(`hostOnline`)만 본다.
  const dot =
    member.kind === "agent"
      ? agentHostDot(member.hostOnline)
      : humanPresenceDot(member, nowMs);
  if (dot === null) return null;
  return dot.tone === "ok" ? "online" : dot.tone === "warn" ? "away" : "dnd";
}

export const PEER_DOT_LABEL: Record<PeerDot, string> = {
  online: AGENT_HOST_ONLINE_LABEL,
  away: declaredStatusLabel("away"),
  dnd: declaredStatusLabel("dnd"),
};
