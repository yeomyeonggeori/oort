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
import {
  isUnknownFieldRejection,
  noteRoutingUnsupported,
  routingScope,
} from "./capability";
import {
  routingRejectionField,
  type RoutingDraft,
  type RoutingRejectionField,
} from "./routingModel";

// =============================================================================
// 에이전트 프로필의 라우팅 필드 읽기·저장 (ADR-0134 D3 2층, MOMO-626/537).
//
// PUT은 patch가 아니라 replace다(AgentProfileInput). 그래서 모델 하나를 바꾸는
// 저장도 instructions와 enabledTools를 읽은 그대로 되돌려 보낸다. 이 규칙을
// 어기면 라우팅을 손봤다는 이유로 에이전트의 지시문이 지워진다.
//
// **404는 막다른 길이 아니다**(R1 B3). 같은 경로의 PUT은 upsert이고, 프로필이
// 없으면 만들어 준다(`AgentProfileRoutes.upsert`; momowebqa 실측: GET 404인
// 에이전트에 PUT 하면 200 + version 1 생성). 즉 이 훅이 보내는 바로 그 PUT이
// 프로필을 만든다. 그래서 404는 "없다"가 아니라 "아직 없다"이고, 저장할 대상이
// 없는 것이 아니라 저장이 곧 생성이다. 이때만 instructions/enabledTools를 서버
// 기본값(빈 문자열, 빈 배열)으로 채워 보내는데, 보존할 기존 값 자체가 없으므로
// replace 규칙을 어기는 것이 아니다.
//
// `effortPref`는 이 서버가 아직 모를 수 있는 키다(ADR-0134 D3 신설, 엔진 랜딩은
// MOMO-625). 그래서 값이 있을 때만 싣고, closed-world 디코더가 "모르는 필드"로
// 거절하면 그 자리에서 capability를 내리고(capability.ts의 learned downgrade)
// 저장이 안 됐다고 말한다. 조용히 필드를 빼고 "저장했습니다"라고 답하는 것이
// 여기서 가장 나쁜 실패다.
// =============================================================================

/**
 * 화면에 뜰 실패 문구 하나 + 그 문장이 **어느 상자에 대한 답인가**. 원인 분류는
 * 여기에 두지 않는다(R2 M7).
 *
 * "강도 필드를 모른다"는 사실은 `AgentProfileSaveResult.effortUnsupported`가
 * 저장 호출의 답으로 이미 전달하고, 그 값으로 폼을 되돌리는 것이 호출자의 일이다.
 * 같은 사실을 실패 객체에도 복사해 두면 정본이 둘이 되고, 둘 중 아무도 읽지 않는
 * 쪽이 남는다.
 *
 * `field`는 그 분류가 아니라 **배달 주소**다. 허용목록 밖 모델에 대한 400은 모델을
 * 바꾸라는 요청이므로 폼 맨 아래가 아니라 모델 상자 옆에 서야 한다(2026-07-26 머지
 * 리뷰 F1; 엔진 절반이 지금 이 400을 만드는 중이고, 웹은 그 문장이 도착할 자리를
 * 먼저 만들어 둔다). 알아보지 못하면 `null`이고 지금까지와 똑같이 폼 전체에 붙는다.
 */
export interface AgentProfileSaveFailure {
  message: string;
  field: RoutingRejectionField;
}

export interface AgentProfileSaveResult {
  ok: boolean;
  /** 저장 실패의 원인이 추론 강도 필드였다. 호출자는 그 값을 되돌린다. */
  effortUnsupported: boolean;
}

export interface AgentProfileHandle {
  profile: AgentProfile | null;
  /** 이 에이전트에는 아직 프로필 행이 없다(GET 404). 저장하면 만들어진다. */
  missing: boolean;
  isPending: boolean;
  /** 404를 제외한 진짜 실패만. 404는 `missing`으로 말한다. */
  error: unknown;
  refetch: () => void;
  saving: boolean;
  failure: AgentProfileSaveFailure | null;
  clearFailure: () => void;
  save: (draft: RoutingDraft) => Promise<AgentProfileSaveResult>;
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
  const missing =
    query.error instanceof ApiError && query.error.status === 404;

  const save = useCallback(
    async (draft: RoutingDraft): Promise<AgentProfileSaveResult> => {
      if (agentMemberId === null) return { ok: false, effortUnsupported: false };
      setSaving(true);
      setFailure(null);
      const input: AgentProfileInput = {
        instructions: profile?.instructions ?? "",
        enabledTools: profile?.enabledTools ?? [],
        // 프로필이 들고 있던 triggers를 **그대로** 돌려보낸다(R2 H2). `{ mention:
        // true }`를 새로 지어내면 replace 규칙을 instructions·enabledTools에만
        // 지키고 triggers에서 어기는 것이 되고, 서버 upsert가 `triggers =
        // EXCLUDED.triggers`라 저장돼 있던 schedule이 그 자리에서 사라진다
        // (openapi `AgentProfileTriggers.schedule`은 v0가 실행하지 않을 뿐
        // 정식 필드다). 프로필이 아직 없을 때만 서버 기본값과 같은 모양을 만든다.
        triggers: profile?.triggers ?? { mention: true },
      };
      if (draft.model !== null) input.modelPref = draft.model;
      if (draft.effort !== null) input.effortPref = draft.effort;
      try {
        const saved = await putAgentProfile(workspaceId, agentMemberId, input);
        client.setQueryData(
          ["agent-profile", workspaceId.toLowerCase(), key],
          saved
        );
        return { ok: true, effortUnsupported: false };
      } catch (error) {
        // 모양 거절은 강도를 실었을 때만 강도에 대한 답이다. 강도를 싣지도 않았는데
        // 온 "모르는 필드"는 다른 이야기이므로 그것으로 축을 내리지 않는다.
        if (draft.effort !== null && isUnknownFieldRejection(error)) {
          noteRoutingUnsupported(routingScope(workspaceId));
          setFailure({
            message:
              "이 서버는 아직 추론 강도 저장을 지원하지 않습니다. 고른 강도는 되돌렸고, 모델만 바꿔서 다시 저장할 수 있습니다.",
            field: null,
          });
          return { ok: false, effortUnsupported: true };
        }
        setFailure({
          message:
            error instanceof ApiError || error instanceof Error
              ? error.message
              : "변경을 저장하지 못했습니다.",
          // 서버 원문을 그대로 옮기되 **자리는 옮긴다**. 문구를 다시 쓰지 않는
          // 이유는 이 거절의 내용을 웹이 모르기 때문이다: 허용목록도, 그 안에
          // 무엇이 있는지도 이 클라이언트에 내려오지 않는다. 우리가 아는 것은
          // 어느 상자를 고쳐야 하는가뿐이고, 그것이 여기서 더하는 전부다.
          field:
            error instanceof ApiError
              ? routingRejectionField(error.status, error.message, draft)
              : null,
        });
        return { ok: false, effortUnsupported: false };
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
    missing,
    isPending: agentMemberId !== null && query.isPending,
    error: missing ? null : query.error,
    refetch,
    saving,
    failure,
    clearFailure: useCallback(() => setFailure(null), []),
    save,
  };
}

// ---- 다이얼로그를 어디서든 연다 ---------------------------------------------
// 디렉터리 행과 타임라인 행 메뉴와 컴포저 멘션 줄, 세 곳이 같은 하나의 다이얼로그
// 를 연다. 진입점마다 다이얼로그를 하나씩 두면 폼 상태가 세 벌이 되고 그중 하나는
// 반드시 낡는다(채널 만들기에서 이미 겪은 문제).

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
