import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchAgentLiveness, type AgentLiveness } from "@momo/core/lib/api";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { useSession } from "@/app/session";

// =============================================================================
// 에이전트의 「지금 살아 있는가」 읽기 (ADR-0200 D4, #3749). 서버가 파생한 라벨을
// 한 곳에서 읽어 멤버 목록·헤더·사이드바·작업 패널이 같은 쿼리를 나눠 쓴다.
//
// 404는 **오류가 아니라 「라벨 없음」** 이다: hosted가 아닌 에이전트, 채널을 공유하지
// 않는 에이전트, 이 라우트가 없는 구 서버가 모두 같은 404로 답한다(이 경로는 「hosted
// 인가」를 알아내는 탐침이 아니다). 그 답은 오래 캐시해 매번 다시 묻지 않는다.
// =============================================================================

/** 살아 있음은 분 단위 사실이라 이 간격이면 라벨이 한 박자 이상 늦지 않는다. */
export const LIVENESS_POLL_MS = 60_000;
/** 「라벨 없음」은 자주 바뀌지 않는다. */
const ABSENT_STALE_MS = 5 * 60_000;

export function agentLivenessQueryKey(workspaceId: string, agentId: string) {
  return ["agent-liveness", workspaceId, agentId.toLowerCase()] as const;
}

/** 모듈 스코프 옵션: 렌더 스코프를 붙잡는 클로저를 세션 수명 캐시에 얹지 않는다. */
export function agentLivenessQuery(workspaceId: string, agentId: string) {
  return {
    queryKey: agentLivenessQueryKey(workspaceId, agentId),
    queryFn: async (): Promise<AgentLiveness | null> => {
      try {
        return await fetchAgentLiveness(workspaceId, agentId);
      } catch (error) {
        if (serverSaysAbsent(error)) return null;
        throw error;
      }
    },
    staleTime: 30_000,
    retry: (count: number, error: unknown) =>
      !(error instanceof ApiError && error.status < 500) && count < 1,
    refetchInterval: (query: { state: { data?: AgentLiveness | null } }) =>
      query.state.data === null ? false : LIVENESS_POLL_MS,
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
  enabled = true
): AgentLivenessRead {
  const { workspaceId } = useSession();
  const query = useQuery({
    ...agentLivenessQuery(workspaceId, agentId ?? ""),
    enabled: enabled && agentId !== null,
    gcTime: ABSENT_STALE_MS,
  });
  // `dataUpdatedAt`을 읽어 갱신마다 다시 그린다: 「n분 전」이 새 시각으로 계산된다.
  void query.dataUpdatedAt;
  return { liveness: query.data, nowMs: Date.now() };
}
