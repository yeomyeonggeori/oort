import type {MembershipRole, RosterMember} from '@momo/core/lib/api';
import {mayActOnLiveness} from '@momo/core/features/agents/liveness';
import {dmPeerStatusDot, type StatusDot} from '@momo/core/features/presence/statusDot';

import {useAgentLiveness} from '../agents/useAgentLiveness';

// =============================================================================
// 한 멤버의 상태 점 — 프로필 시트의 칩 (#4319).
//
// DM 머리의 상대 점(`ConversationScreen` 의 `peerStatus`)·홈 DM 줄과 **같은 core 판정**(`dmPeerStatusDot`)이고, 에이전트의
// 생존 읽기도 **같은 쿼리 키**(`useAgentLiveness`)라 한 에이전트의 요청은 머리와 이 칩이 나눠 쓴다. 사람은 스스로 정한 상태
// (자리 비움·방해 금지)만 점이 되고 요청이 없다(`useAgentLiveness(null)` 은 쿼리를 세우지 않는다). 모르면 `null` — 점이 없다.
//
// 훅은 조건부로 부를 수 없으니 멤버가 없을 때(시트가 닫혀 있을 때)도 늘 불린다. 그때는 `null` 이다.
// =============================================================================

export function useMemberStatusDot(
  member: Pick<RosterMember, 'id' | 'kind' | 'hostOnline' | 'presenceStatus' | 'dndUntilMs'> | null,
  /** 보는 사람(나)의 역할 — 경고 점(주황)은 깨울 수 있는 소유자·관리자에게만 경고다(`mayActOnLiveness`). */
  viewerRole: MembershipRole | undefined,
  nowMs: number,
): StatusDot | null {
  const agentId = member?.kind === 'agent' ? member.id : null;
  const read = useAgentLiveness(agentId);
  return dmPeerStatusDot({
    member,
    liveness: agentId === null ? undefined : read.liveness,
    mayAct: mayActOnLiveness(viewerRole),
    // 에이전트는 읽은 시각, 사람은 화면이 든 시각(방해 금지 만료 판정).
    nowMs: agentId === null ? nowMs : read.nowMs,
  });
}
