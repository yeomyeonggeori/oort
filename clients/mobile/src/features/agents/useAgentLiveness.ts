import {
  ApiError,
  fetchAgentLiveness,
  type AgentLiveness,
} from '@momo/core/lib/api';
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {useQuery} from '@tanstack/react-query';
import {useSession} from '../../session/useSession';

// =============================================================================
// 에이전트의 「지금 살아 있는가」 읽기 (ADR-0200 D4, U4 #3750). 웹의
// `clients/web/src/features/agents/useAgentLiveness.ts`와 같은 규칙이고 **쿼리 키도
// 같다**(`['agent-liveness', ws, agent]`): 키가 한 글자만 달라도 한 클라이언트가 쓴
// 갱신을 다른 클라이언트가 못 읽는다.
//
// 404는 오류가 아니라 「라벨 없음」이다: hosted가 아닌 에이전트, 채널을 공유하지 않는
// 에이전트, 이 라우트가 없는 구 서버가 모두 같은 404로 답한다.
// =============================================================================

/** 살아 있음은 분 단위 사실이라 이 간격이면 라벨이 한 박자 이상 늦지 않는다. */
export const LIVENESS_POLL_MS = 60_000;

export function agentLivenessQueryKey(workspaceId: string, agentId: string) {
  return ['agent-liveness', workspaceId, agentId.toLowerCase()] as const;
}

export interface AgentLivenessRead {
  /** 서버가 답한 라벨. 없음(hosted 아님·모름)이면 null. 아직 모르면 undefined. */
  liveness: AgentLiveness | null | undefined;
  /** 이 렌더의 시각. 갱신마다 새로 읽는다. */
  nowMs: number;
}

export function useAgentLiveness(
  agentId: string | null,
  enabled = true,
): AgentLivenessRead {
  const {workspaceId} = useSession();
  const query = useQuery({
    queryKey: agentLivenessQueryKey(workspaceId, agentId ?? ''),
    queryFn: async (): Promise<AgentLiveness | null> => {
      try {
        return await fetchAgentLiveness(workspaceId, agentId as string);
      } catch (error) {
        if (serverSaysAbsent(error)) {
          return null;
        }
        throw error;
      }
    },
    enabled: enabled && agentId !== null,
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status < 500) && count < 1,
    refetchInterval: q =>
      q.state.data === null ? false : LIVENESS_POLL_MS,
  });
  // `dataUpdatedAt`을 읽어 갱신마다 다시 그린다: 「n분 전」이 새 시각으로 계산된다.
  void query.dataUpdatedAt;
  return {liveness: query.data, nowMs: Date.now()};
}
