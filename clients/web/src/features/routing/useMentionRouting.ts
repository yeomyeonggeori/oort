import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  fetchAgentAllowedModels,
  fetchAgentProfile,
  type AgentProfile,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  calledAgents,
  mentionRoutingTargetKey,
  type MentionRoutingTarget,
} from "@momo/core/features/routing/mentionTargets";
import {
  INHERIT_DRAFT,
  resolveInheritance,
  type CalledAgentRouting,
  type EffortTable,
  type RoutingDraft,
} from "@momo/core/features/routing/routingModel";
import { useSession } from "@/app/session";
import { isAgentProfileMissing } from "./useAgentProfile";

export interface MentionRouting {
  draft: RoutingDraft;
  reset: () => void;
}

/**
 * 컴포저가 들고 있는 1회 오버라이드 상태.
 *
 * 멘션 대상이 바뀌면 초안을 비운다. hermes에게 고른 강도가 김인턴에게 그대로
 * 따라가면, 사람은 자기가 고른 적 없는 값을 보낸다.
 *
 * 기준은 부른 **집합**이다(`mentionRoutingTargetKey`). 앞 판은 한 명일 때의 id
 * 하나만 봤고, 그래서 여럿을 부른 글에서는 이름을 갈아 끼워도 초안이 그대로
 * 남았다: `@hermes @kim-intern`에 걸어 둔 강도가 `@hermes @atlas`로 고친 순간
 * 아틀라스에게 붙는다. 단일에서 막아 둔 사고가 다중에서만 열려 있던 자리다.
 */
export function useMentionRouting(target: MentionRoutingTarget): {
  draft: RoutingDraft;
  setDraft: (next: RoutingDraft) => void;
  reset: () => void;
} {
  const [draft, setDraft] = useState<RoutingDraft>(INHERIT_DRAFT);
  const targetKey = mentionRoutingTargetKey(target);
  useEffect(() => {
    setDraft(INHERIT_DRAFT);
  }, [targetKey]);
  return {
    draft,
    setDraft,
    reset: () => setDraft(INHERIT_DRAFT),
  };
}

// ---- 부른 사람들에게 지금 걸려 있는 값 ---------------------------------------
//
// 한 발화가 여러 명을 부르면 run도 그 수만큼 생기고, 각자에게 걸려 있는 모델·강도는
// 서로 다르다(각자의 프로필과 각자의 allow-list). 그 값들을 읽지 않으면 화면은
// "각 에이전트의 프로필 값이 적용됩니다"라고 적어 놓고 그 값이 무엇인지는 끝내
// 말하지 못한다 — 앞 판의 다중 줄이 정확히 그랬다.
//
// 쿼리 키는 단일 경로(`useAgentProfile`·`useAllowedAgentModels`)의 것과 **같은
// 모양**이다. 같은 에이전트를 두 캐시 항목으로 만들면 프로필 다이얼로그에서 저장한
// 값이 이 줄에 반영되지 않는다.

export interface CalledAgentsRouting {
  agents: CalledAgentRouting[];
  /** 아직 답을 기다리는 읽기가 하나라도 있다. */
  isPending: boolean;
  /** 상속값을 끝내 읽지 못한 에이전트들의 표시 이름. 비어 있으면 전부 읽었다. */
  unreadable: string[];
  /** 실패한 읽기를 다시 던진다. */
  refetch: () => void;
}

export function useCalledAgentsRouting(
  target: MentionRoutingTarget,
  table: EffortTable | null
): CalledAgentsRouting {
  const { workspaceId } = useSession();
  const workspaceKey = workspaceId.toLowerCase();
  const members: RosterMember[] = calledAgents(target);

  const profiles = useQueries({
    queries: members.map((member) => ({
      queryKey: ["agent-profile", workspaceKey, member.id.toLowerCase()],
      queryFn: () => fetchAgentProfile(workspaceId, member.id),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const allowed = useQueries({
    queries: members.map((member) => ({
      queryKey: ["routing", "allowed-models", workspaceKey, member.id.toLowerCase()],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAgentAllowedModels(workspaceId, member.id, signal),
      retry: false,
      staleTime: 30_000,
      retryOnMount: false,
      refetchOnWindowFocus: false,
    })),
  });

  // 404는 실패가 아니라 "프로필이 아직 없다"이고, 그때 상속의 상대는 에이전트
  // 자신의 모델이다(단일 경로의 `useAgentProfile`과 같은 독법).
  const failures = members.map((_, index) => {
    const error = profiles[index]?.error;
    return error !== null && error !== undefined && !isAgentProfileMissing(error);
  });
  const pending = members.some((_, index) => profiles[index]?.isPending === true);

  // 메모하지 않는다. 부른 인원은 한 문장이 부를 수 있는 만큼이고(실제로 두세 명),
  // 상속 계산은 순수 함수 하나다. 메모의 의존성 배열이 쿼리 객체를 흉내 내는
  // 문자열이 되는 쪽이 훨씬 비싸게 틀린다.
  const agents = members.map((member, index): CalledAgentRouting => {
    const profile = (profiles[index]?.data as AgentProfile | undefined) ?? null;
    const allowedModels = allowed[index]?.data ?? null;
    const known = profiles[index]?.isPending !== true && !failures[index];
    return {
      id: member.id,
      handle: member.handle,
      displayName: member.displayName,
      inheritance: known
        ? resolveInheritance(table, member.agentModel ?? "", profile, allowedModels)
        : null,
      allowedModels,
    };
  });

  return {
    agents,
    isPending: pending,
    unreadable: members
      .filter((_, index) => failures[index])
      .map((member) => member.displayName),
    refetch: () => {
      for (const [index, failed] of failures.entries()) {
        if (failed) void profiles[index]?.refetch();
      }
    },
  };
}
