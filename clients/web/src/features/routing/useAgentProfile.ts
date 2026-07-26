import { createContext, useCallback, useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  fetchAgentProfile,
  putAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
} from "@/lib/api";
import { useSession } from "@/app/session";
import { isUnknownFieldRejection, noteRoutingUnsupported } from "./capability";
import type { RoutingDraft } from "./routingModel";

// =============================================================================
// 에이전트 프로필의 라우팅 필드 읽기·저장 (ADR-0134 D3 2층, MOMO-626/537).
//
// PUT은 patch가 아니라 replace다(AgentProfileInput). 그래서 모델 하나를 바꾸는
// 저장도 instructions와 enabledTools를 읽은 그대로 되돌려 보낸다. 이 규칙을
// 어기면 라우팅을 손봤다는 이유로 에이전트의 지시문이 지워진다.
//
// `effortPref`는 이 서버가 아직 모를 수 있는 키다(ENGINE_HANDOFF X-14: 컬럼은
// 마이그레이션 041에 있지만 REST writer는 없다). 그래서 값이 있을 때만 싣고,
// closed-world 디코더가 "모르는 필드"로 거절하면 그 자리에서 capability를
// 내리고(capability.ts의 learned downgrade) 저장이 안 됐다고 말한다. 조용히
// 필드를 빼고 "저장했습니다"라고 답하는 것이 여기서 가장 나쁜 실패다.
// =============================================================================

export interface AgentProfileSaveFailure {
  message: string;
  /** 서버가 이 필드 자체를 모른다고 답했다. capability가 내려간 상태다. */
  unsupported: boolean;
}

export interface AgentProfileHandle {
  profile: AgentProfile | null;
  isPending: boolean;
  error: unknown;
  refetch: () => void;
  saving: boolean;
  failure: AgentProfileSaveFailure | null;
  clearFailure: () => void;
  /** 저장 성공이면 true. 실패는 failure에 남는다. */
  save: (draft: RoutingDraft) => Promise<boolean>;
}

export function useAgentProfile(agentMemberId: string | null): AgentProfileHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AgentProfileSaveFailure | null>(null);

  // uuid는 서버마다 대소문자가 다르게 온다(Swift는 대문자, PG JSON은 소문자).
  // 캐시 키로 쓰는 순간 같은 에이전트가 두 항목이 되므로 여기서 접는다.
  const key = agentMemberId?.toLowerCase() ?? null;
  const query = useQuery({
    queryKey: ["agent-profile", workspaceId.toLowerCase(), key],
    queryFn: () => fetchAgentProfile(workspaceId, agentMemberId as string),
    enabled: agentMemberId !== null,
    retry: false,
    staleTime: 30_000,
  });

  const profile = query.data ?? null;

  const save = useCallback(
    async (draft: RoutingDraft): Promise<boolean> => {
      if (agentMemberId === null || profile === null) return false;
      setSaving(true);
      setFailure(null);
      const input: AgentProfileInput = {
        instructions: profile.instructions,
        enabledTools: profile.enabledTools,
        // triggers.mention is fixed true by contract; sending the profile's own
        // value back keeps the replace faithful instead of re-deciding it here.
        triggers: { mention: true },
      };
      if (draft.model !== null) input.modelPref = draft.model;
      if (draft.effort !== null) input.effortPref = draft.effort;
      try {
        const saved = await putAgentProfile(workspaceId, agentMemberId, input);
        client.setQueryData(
          ["agent-profile", workspaceId.toLowerCase(), key],
          saved
        );
        return true;
      } catch (error) {
        if (isUnknownFieldRejection(error)) {
          noteRoutingUnsupported();
          setFailure({
            message:
              "이 서버는 아직 에이전트 추론 강도 저장을 지원하지 않아 변경을 저장하지 못했습니다. 모델만 바꾸면 저장됩니다.",
            unsupported: true,
          });
          return false;
        }
        setFailure({
          message:
            error instanceof ApiError || error instanceof Error
              ? error.message
              : "변경을 저장하지 못했습니다.",
          unsupported: false,
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [agentMemberId, profile, workspaceId, client, key]
  );

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    profile,
    isPending: agentMemberId !== null && query.isPending,
    error: query.error,
    refetch,
    saving,
    failure,
    clearFailure: useCallback(() => setFailure(null), []),
    save,
  };
}

// ---- 다이얼로그를 어디서든 연다 ---------------------------------------------
// 디렉터리 행과 타임라인의 에이전트 이름과 컴포저 멘션 줄, 세 곳이 같은 하나의
// 다이얼로그를 연다. 진입점마다 다이얼로그를 하나씩 두면 폼 상태가 세 벌이 되고
// 그중 하나는 반드시 낡는다(채널 만들기에서 이미 겪은 문제).

export const OpenAgentProfileContext = createContext<
  ((agentMemberId: string) => void) | null
>(null);

export function useOpenAgentProfile(): (agentMemberId: string) => void {
  const open = useContext(OpenAgentProfileContext);
  if (!open) {
    throw new Error(
      "useOpenAgentProfile must be used inside AgentProfileProvider"
    );
  }
  return open;
}

/** 다이얼로그가 지금 떠 있는가. 셸의 전역 단축키가 이 값을 보고 물러선다. */
export const AgentProfileOpenContext = createContext(false);

export function useAgentProfileOpen(): boolean {
  return useContext(AgentProfileOpenContext);
}
