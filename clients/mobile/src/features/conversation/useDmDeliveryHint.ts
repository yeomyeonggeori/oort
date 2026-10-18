import {useQuery} from '@tanstack/react-query';
import {getAgentDmDelivery} from '@momo/core/features/hostedAgents/api';
import {
  dmComposerHint,
  dmDeliveryAnswers,
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
// 때만 참이다. 답을 기다리는 동안은 문장 없음, 그 밖의 실패·모르는 상태 단어면 문장 없음.
//
// **정상(`open`·`not_hosted`)에는 문장이 없다** (#4016, 성재 3047: 「멘션 없이 바로 말하면 grok가
// 답해요」는 뺀다). 매번 입력창 위에 서는 안내는 정상 상태를 되풀이할 뿐이고, 에이전트 DM 에서 그냥
// 말하면 답하는 것은 입력창 자리표시자(「grok에게 메시지 보내기」)가 이미 말한다. 답하지 **않는**
// 경우(승인 대기·연결 끊김·꺼짐 등)만 문장이 남는다 — 그것은 모르면 헛기다리게 되는 사실이다.
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
  if (delivery.isError) {
    return null;
  }
  if (delivery.data === null) {
    return null;
  }
  const state = delivery.data.state;
  if (state === null) {
    return null;
  }
  if (dmDeliveryAnswers(state)) {
    return null;
  }
  const ownerId = delivery.data.ownerMemberId;
  names.ownerName =
    ownerId === null ? null : memberFor(directory, ownerId)?.displayName ?? null;
  return `${dmComposerHint(state, names)}.`;
}
