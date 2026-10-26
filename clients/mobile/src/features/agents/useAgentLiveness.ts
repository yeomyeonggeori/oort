import {
  ApiError,
  fetchAgentLiveness,
  type AgentLiveness,
} from '@momo/core/lib/api';
import type {AgentLivenessLookup} from '@momo/core/features/agents/turnCopy';
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {useQueries, useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
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

/**
 * 한 에이전트의 생존 읽기 옵션. 웹 `agentLivenessQuery`와 같은 모양이고, 한 사람(`useAgentLiveness`)과
 * 여럿(`useAgentLivenessLookup`)이 **같은 쿼리**를 나눠 쓰게 한 곳에 둔다 — 키가 같아야 한쪽이 읽은 답을
 * 다른 쪽이 다시 묻지 않고 쓴다.
 */
function agentLivenessQuery(workspaceId: string, agentId: string) {
  return {
    queryKey: agentLivenessQueryKey(workspaceId, agentId),
    queryFn: async (): Promise<AgentLiveness | null> => {
      try {
        return await fetchAgentLiveness(workspaceId, agentId);
      } catch (error) {
        if (serverSaysAbsent(error)) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 30_000,
    retry: (count: number, error: unknown) =>
      !(error instanceof ApiError && error.status < 500) && count < 1,
    refetchInterval: (q: {state: {data?: AgentLiveness | null}}) =>
      q.state.data === null ? false : LIVENESS_POLL_MS,
  };
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
    ...agentLivenessQuery(workspaceId, agentId ?? ''),
    enabled: enabled && agentId !== null,
  });
  // `dataUpdatedAt`을 읽어 갱신마다 다시 그린다: 「n분 전」이 새 시각으로 계산된다.
  void query.dataUpdatedAt;
  return {liveness: query.data, nowMs: Date.now()};
}

/**
 * 여러 에이전트의 생존 판정을 한 번에 찾는 함수 (#4285: 대화 아래 활동 줄이 아무도 가져가지 않은
 * 요청의 근거 줄 맨 앞에 서버의 경고 라벨을 싣는다). 호스티드가 아니면(404) null, 아직 읽는 중이면
 * undefined다 — 지어내지 않는다.
 *
 * 돌려주는 함수는 답이 바뀔 때만 새로 만들어진다: 활동 줄이 메모하는 입력이라, 렌더마다 새 함수를
 * 내면 1Hz로 다시 그려지는 대화 화면이 줄 문구를 초당 한 번 처음부터 만든다.
 */
export function useAgentLivenessLookup(
  agentIds: readonly string[],
): AgentLivenessLookup {
  const {workspaceId} = useSession();
  const key = [...new Set(agentIds.map(id => id.toLowerCase()))].sort().join('|');
  const ids = useMemo(() => (key === '' ? [] : key.split('|')), [key]);
  const results = useQueries({
    queries: ids.map(id => agentLivenessQuery(workspaceId, id)),
  });
  // 답의 지문: 상태와 마지막 신호 시각. 같으면 같은 함수를 돌려준다.
  const fingerprint = results
    .map(result =>
      result.data === undefined
        ? 'u'
        : result.data === null
          ? 'n'
          : `${result.data.state}:${result.data.lastSignalAtMs ?? ''}`,
    )
    .join('|');
  return useMemo(() => {
    const byId = new Map<string, AgentLiveness | null>();
    ids.forEach((id, index) => {
      const data = results[index]?.data;
      if (data !== undefined) {
        byId.set(id, data);
      }
    });
    return (memberId: string) => byId.get(memberId.toLowerCase());
    // `results`는 렌더마다 새 배열이다. 지문이 같으면 담긴 답도 같다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, fingerprint]);
}
