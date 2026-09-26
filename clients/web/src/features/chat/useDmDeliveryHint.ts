import { useQuery } from "@tanstack/react-query";
import { getAgentDmDelivery } from "@momo/core/features/hostedAgents/api";
import {
  dmComposerHint,
  parseAgentDmDelivery,
} from "@momo/core/features/hostedAgents/dmApproval";
import { agentLabelAsSubject, agentLabel } from "@momo/core/features/agents/turnCopy";
import type { RosterMember } from "@momo/core/lib/api";
import {
  memberFor,
  memberNameParts,
  type Directory,
} from "@/features/workspace/useWorkspace";

// =============================================================================
// DM 컴포저 힌트의 문장 (#2891, ADR-0162 증보 2).
//
// 「멘션 없이 바로 말하면 …가 답합니다」는 서버가 이 DM을 에이전트에게 **전달할
// 때만** 참이다. 호스티드 에이전트는 소유자 대화이거나 소유자가 연 대화일 때만
// 전달되므로, 문장은 서버의 `agent-dm-delivery` 답을 따른다.
//
//   * 답을 기다리는 동안: 문장 없음. 모르는 채로 「답합니다」를 약속하지 않는다.
//   * 답이 없을 때(이 경로가 없는 옛 서버, 네트워크 실패): 이전 문장. 관리형
//     에이전트만 있던 서버의 동작 그대로다.
//   * 모르는 상태 단어: 문장 없음.
// =============================================================================

export function dmDeliveryQueryKey(workspaceId: string, channelId: string) {
  return ["agent-dm-delivery", workspaceId, channelId] as const;
}

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
    queryKey: dmDeliveryQueryKey(workspaceId, channelId),
    queryFn: async () => parseAgentDmDelivery(await getAgentDmDelivery(workspaceId, channelId)),
    enabled: dmAgent !== null,
    // 승인·연결 상태는 다른 사람이 바꾼다. 방에 돌아올 때 다시 묻는다.
    staleTime: 30_000,
    retry: false,
  });
  if (dmAgent === null) return null;
  const parts = memberNameParts(directory, dmAgent.id, dmAgent.displayName);
  const names = {
    agentSubject: agentLabelAsSubject(parts),
    agentName: agentLabel(parts),
    ownerName: null as string | null,
  };
  if (delivery.isPending) return null;
  if (delivery.isError || delivery.data === null) {
    return dmComposerHint("open", names);
  }
  const state = delivery.data.state;
  if (state === null) return null;
  const ownerId = delivery.data.ownerMemberId;
  names.ownerName =
    ownerId === null ? null : (memberFor(directory, ownerId)?.displayName ?? null);
  return dmComposerHint(state, names);
}
