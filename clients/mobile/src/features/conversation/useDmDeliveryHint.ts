import {useQuery} from '@tanstack/react-query';
import {getAgentDmDelivery} from '@momo/core/features/hostedAgents/api';
import {
  dmComposerHint,
  parseAgentDmDelivery,
} from '@momo/core/features/hostedAgents/dmApproval';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import {attachParticle} from '@momo/core/lib/koreanParticle';

// =============================================================================
// DM 컴포저 힌트 (#2891, ADR-0162 증보 2). 웹 `useDmDeliveryHint` 와 같은 규칙.
//
// 「멘션 없이 바로 말하면 …가 답합니다」는 서버가 이 DM을 에이전트에게 전달할
// 때만 참이다. 답을 기다리는 동안은 문장 없음, 이 경로가 없는 옛 서버·실패면
// 이전 문장, 모르는 상태 단어면 문장 없음.
// =============================================================================

export function useDmDeliveryHint({
  workspaceId,
  channelId,
  directory,
  dmAgent,
}: {
  workspaceId: string;
  channelId: string;
  directory: Directory;
  dmAgent: RosterMember | null;
}): string | null {
  const delivery = useQuery({
    queryKey: ['agent-dm-delivery', workspaceId, channelId],
    queryFn: async () =>
      parseAgentDmDelivery(await getAgentDmDelivery(workspaceId, channelId)),
    enabled: dmAgent !== null,
    staleTime: 30_000,
    retry: false,
  });
  if (dmAgent === null) {
    return null;
  }
  const names = {
    agentSubject: attachParticle(dmAgent.displayName, 'subject'),
    agentName: dmAgent.displayName,
    ownerName: null as string | null,
  };
  if (delivery.isPending) {
    return null;
  }
  if (delivery.isError || delivery.data === null) {
    return `${dmComposerHint('open', names)}.`;
  }
  const state = delivery.data.state;
  if (state === null) {
    return null;
  }
  const ownerId = delivery.data.ownerMemberId;
  names.ownerName =
    ownerId === null ? null : memberFor(directory, ownerId)?.displayName ?? null;
  return `${dmComposerHint(state, names)}.`;
}
