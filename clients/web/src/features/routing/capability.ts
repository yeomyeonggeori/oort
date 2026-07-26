// =============================================================================
// 이 서버가 요청 단위 라우팅을 지원하는가 (ADR-0134, MOMO-626).
//
// 왜 감지가 필요한가: 라우팅 엔진층(ADR-0134/0135)은 track/engine에만 있고,
// 지금 살아 있는 서버들은 그 경로를 모른다. 그런 서버 앞에서 이 컨트롤을 그냥
// 켜 두면 사람이 고른 모델·강도가 400으로 튕기고, 숨겨 버리면 "왜 없지"만
// 남는다. 둘 다 틀렸다. 컨트롤은 남기고 이유를 적는다.
//
// 감지 방식(설계 근거):
//   1. 프로브는 `GET /v1/provider/effort-table` 하나다. ADR-0134 D2 표면에서
//      부작용이 없고, 테넌트 행을 읽지 않으며(어떤 인증 주체든 200),
//      자격증명을 담지 않는 유일한 GET이라 프로브로 안전하다. 이 경로가 있으면
//      그 서버에는 0134 엔진층이 올라가 있다.
//   2. 프로브는 판정을 세 갈래로만 낸다. 200+아는 모양 = ready, 404/405/501 =
//      absent(이 서버에는 그 기능이 없다), 그 밖(401/403/네트워크/모르는 모양)
//      = unknown. **unknown을 absent로 접지 않는다**: "지원하지 않습니다"는
//      서버가 그렇게 답했을 때만 할 수 있는 말이고, 못 물어본 것과 아니라고
//      들은 것은 다른 사실이다.
//   3. GET 하나가 PUT/POST를 약속하지는 못한다. 그래서 두 번째 신호를 배운다:
//      라우팅 필드를 실은 쓰기가 "모르는 필드"류 400으로 거절되면 그 순간
//      capability를 absent로 내리고(=learned downgrade) 서버가 준 사유를 그대로
//      들고 온다. 실제로 track/engine 상태가 정확히 그 조합이다 — effort-table은
//      있는데 `agent_profile.effort_pref` writer는 아직 없다(ENGINE_HANDOFF X-14).
//      한 번 내려간 판정은 그 탭이 살아 있는 동안 유지되므로, 같은 거절을 두 번
//      당하지 않는다.
//
// 배운 판정은 react-query 캐시가 아니라 모듈 스토어에 둔다. 프로브 결과는
// 서버에서 온 데이터지만 이 판정은 "우리가 방금 거절당했다"는 클라이언트 사실
// 이고, 쿼리 무효화로 지워지면 안 되기 때문이다.
// =============================================================================

import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchEffortTable } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import { parseEffortTable, type EffortTable } from "./routingModel";

export type RoutingSupport = "checking" | "ready" | "absent" | "unknown";

export interface CapabilityVerdict {
  support: Exclude<RoutingSupport, "checking">;
  /** 사용자에게 보여줄 사유. ready면 null. */
  reason: string | null;
}

/** absent 판정의 표준 문장. 표면마다 뒤에 자기 결과를 한 문장 덧붙인다. */
export const UNSUPPORTED_REASON =
  "이 서버는 아직 요청 단위 모델·추론 강도 라우팅을 지원하지 않습니다.";

const UNREADABLE_REASON =
  "서버가 보낸 모델·추론 강도 표를 읽지 못했습니다. 서버 버전을 확인하세요.";

const FORBIDDEN_REASON =
  "이 계정으로는 모델·추론 강도 표를 읽을 수 없어 지원 여부를 확인하지 못했습니다.";

/** 200 본문을 판정으로. 모르는 모양은 absent가 아니라 unknown이다. */
export function verdictFromBody(raw: unknown): {
  verdict: CapabilityVerdict;
  table: EffortTable | null;
} {
  const table = parseEffortTable(raw);
  if (table === null) {
    return {
      verdict: { support: "unknown", reason: UNREADABLE_REASON },
      table: null,
    };
  }
  return { verdict: { support: "ready", reason: null }, table };
}

/**
 * 프로브가 던진 오류를 판정으로.
 *
 * 404/405/501만 "없다"로 읽는다. 이 세 개는 라우터가 그 경로를 모른다는 서버의
 * 직접 답이다. 401/403은 권한 이야기이고, NetworkError는 아무도 답하지 않은
 * 것이라(lib/http) 둘 다 기능 유무에 대한 진술이 아니다.
 */
export function verdictFromError(error: unknown): CapabilityVerdict {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return { support: "absent", reason: UNSUPPORTED_REASON };
    }
    if (error.status === 401 || error.status === 403) {
      return { support: "unknown", reason: FORBIDDEN_REASON };
    }
    return { support: "unknown", reason: `지원 여부를 확인하지 못했습니다. ${error.message}` };
  }
  if (error instanceof NetworkError) {
    return { support: "unknown", reason: error.message };
  }
  return { support: "unknown", reason: "지원 여부를 확인하지 못했습니다." };
}

/**
 * 라우팅 필드를 실은 쓰기가 "이 서버는 그 필드를 모른다"고 거절당한 것인가.
 *
 * 400 가운데 **모양 거절만** 골라낸다. 서버의 closed-world 디코더는 모르는 키를
 * "unknown … field"로 답하고(AgentProfileInput / CreateAgentRunRequest /
 * RunRoutingInput), 정당한 게이트 거절은 "routing.model is not in
 * workspace.settings.allowed_agent_models"처럼 다른 문장이다. 후자까지 capability
 * 강등으로 읽으면, 허용목록 밖 모델을 한 번 고른 것 때문에 기능 전체가 없는
 * 것처럼 화면이 바뀐다.
 */
export function isUnknownFieldRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404) return true;
  return error.status === 400 && /unknown/i.test(error.message);
}

// ---- 배운 판정 (learned downgrade) -----------------------------------------

interface LearnedState {
  reason: string;
}

let learned: LearnedState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 라우팅 필드를 실은 쓰기가 모양 거절을 당했다. 그 사실을 세션 동안 기억한다.
 *
 * `serverMessage`는 서버가 준 영어 원문이라 그대로 화면에 올리지 않는다.
 * 사람에게는 표준 문장을 주고, 원문은 콘솔에도 남기지 않는다(원문이 필요한
 * 사람은 네트워크 탭을 본다).
 */
export function noteRoutingUnsupported(): void {
  if (learned !== null) return;
  learned = { reason: UNSUPPORTED_REASON };
  emit();
}

/** 지금까지 배운 사유. 훅 밖에서도 읽을 수 있어야 판정이 한 벌로 남는다. */
export function learnedRoutingReason(): string | null {
  return learned?.reason ?? null;
}

/** 테스트용. 프로덕션 경로에서는 호출하지 않는다. */
export function resetLearnedRoutingSupport(): void {
  learned = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): LearnedState | null {
  return learned;
}

// ---- 훅 --------------------------------------------------------------------

export interface RoutingCapability {
  support: RoutingSupport;
  table: EffortTable | null;
  reason: string | null;
  /** 다시 물어본다. 서버를 새로 올렸을 때 새로고침 없이 회복하는 경로. */
  recheck: () => void;
}

/**
 * 프로브 한 번, 세션 내내 공유. staleTime을 무한대로 두는 이유는 이것이
 * 데이터가 아니라 서버의 형상이기 때문이다: 채널을 옮길 때마다 다시 물어볼
 * 값이 아니고, 바뀌었다면 [다시 확인]이 있다.
 */
export function useRoutingCapability(): RoutingCapability {
  const learnedState = useSyncExternalStore(subscribe, snapshot, snapshot);
  const query = useQuery({
    queryKey: ["routing", "effort-table"],
    queryFn: async ({ signal }) => fetchEffortTable(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    // 실패도 답이다. 기본값은 오류가 난 쿼리를 새 구독자가 붙을 때마다 다시
    // 던지는데, 이 프로브에서는 그것이 곧 채널을 옮기고 다이얼로그를 열 때마다
    // 404를 다시 받는다는 뜻이다(momowebqa 실측: 한 페이지에서 3회). 서버의
    // 형상은 그렇게 자주 바뀌지 않고, 바뀌었을 때의 회복 경로는 [다시 확인]이다.
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });

  const recheck = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (learnedState !== null) {
    return { support: "absent", table: null, reason: learnedState.reason, recheck };
  }
  if (query.isPending) {
    return { support: "checking", table: null, reason: null, recheck };
  }
  if (query.error) {
    const verdict = verdictFromError(query.error);
    return { support: verdict.support, table: null, reason: verdict.reason, recheck };
  }
  const { verdict, table } = verdictFromBody(query.data);
  return { support: verdict.support, table, reason: verdict.reason, recheck };
}
