// =============================================================================
// 이 서버가 무엇을 할 수 있는가 (ADR-0134, MOMO-626).
//
// 이 화면은 서버 두 세대 앞에 동시에 선다. 그래서 "지원한다"는 말은 한 덩어리가
// 아니라 **세 개의 서로 다른 사실**이고, 여기서는 그 셋을 따로 판정한다. 하나로
// 뭉쳐 두면 한쪽 사실로 다른 쪽을 잠그게 되고, 그것이 R1 리뷰가 잡은 B1·B2다.
//
//   ① 모델 축 (agent_profile.model_pref)
//      ADR-0131 D2. **모든 세대의 서버가 가지고 있다.** PUT profile은 modelPref를
//      받고(momowebqa 실측 200), 멘션 run은 그 값을 실제로 쓴다
//      (MessageRoutes.resolveProfileModel). 그래서 모델 편집은 이 파일의 어떤
//      프로브 결과로도 잠기지 않는다. 여기에 판정 함수가 없는 이유가 그것이다.
//
//   ② effort 축 (provider×model 표 + agent_profile.effort_pref)
//      ADR-0134 D2/D3. 프로브는 `GET /v1/provider/effort-table` 하나다. 부작용이
//      없고, 테넌트 행을 읽지 않으며, 자격증명을 담지 않는다(ADR-0004). 이 경로가
//      있으면 그 서버에는 effort 축이 올라가 있다(MOMO-621).
//
//   ③ 메시지 한 건 오버라이드 (`POST .../messages`의 `routing` 블록)
//      ADR-0134 D1 멘션 tier = MOMO-625. ②와 **별개의 커밋**이고, 실제로 ②만
//      있는 서버가 존재한다(track/engine 현재 형상: PR 812는 머지, PR 816은 미머지).
//      그런 서버는 `routing`을 400으로 거절하지 않고 **조용히 버린다**: 머지 전
//      `SendMessageRequest`는 합성 Decodable이라 모르는 키를 무시한다
//      (main `server/Sources/MomoServer/Routes/DTOs.swift:106` 실측, momowebqa
//      왕복에서도 200). 그러므로 ②의 200을 ③의 근거로 쓰면 화면이 거짓말을 한다.
//      ③은 서버에게 직접 물어봐야 하고, 그 방법이 아래 `probeSendRouting`이다.
//
// 판정의 규칙은 셋 모두 같다: **못 물어본 것과 아니라고 들은 것은 다른 사실이다.**
// 404/405/501만 "없다"로 읽고, 401/403/네트워크/모르는 모양은 "확인하지 못했다"로
// 남긴다. 그리고 어느 쪽으로도 확정되지 않으면 컨트롤은 잠긴 채로 둔다(fail
// closed): 적용되지 않을지도 모르는 선택을 받아 두는 것이 이 표면에서 가장 나쁜
// 실패다.
//
// 배운 판정은 react-query 캐시가 아니라 모듈 스토어에 둔다. 프로브 결과는 서버가
// 준 데이터지만 이 판정은 "우리가 방금 거절당했다"는 클라이언트 사실이고, 쿼리
// 무효화로 지워지면 안 되기 때문이다. 대신 **서버 주소+워크스페이스로 범위를 건다**:
// 로그아웃하고 다른 서버로 들어간 사람에게 앞 서버의 판정을 물려주면, 그 화면은
// 아무도 말한 적 없는 사실을 말하게 된다(R1 M5).
// =============================================================================

import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchEffortTable, probeSendRouting } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import { apiBase } from "@/lib/serverBase";
import { useSession } from "@/app/session";
import { parseEffortTable, type EffortTable } from "./routingModel";

export type RoutingSupport = "checking" | "ready" | "absent" | "unknown";

export interface CapabilityVerdict {
  support: Exclude<RoutingSupport, "checking">;
  /** 사용자에게 보여줄 사유. ready면 null. */
  reason: string | null;
}

/** effort 축 absent 판정의 표준 문장. 표면마다 뒤에 자기 결과를 한 문장 덧붙인다. */
export const UNSUPPORTED_REASON =
  "이 서버는 아직 추론 강도 축을 지원하지 않습니다.";

/** 메시지 한 건 오버라이드가 없는 서버의 표준 문장. */
export const SEND_UNSUPPORTED_REASON =
  "이 서버는 메시지 한 건에만 적용되는 모델·추론 강도를 아직 받지 않습니다.";

const UNREADABLE_REASON =
  "서버가 보낸 모델·추론 강도 표를 읽지 못했습니다. 서버 버전을 확인하세요.";

const FORBIDDEN_REASON =
  "이 계정으로는 모델·추론 강도 표를 읽을 수 없어 지원 여부를 확인하지 못했습니다.";

const SEND_UNKNOWN_REASON =
  "메시지 한 건 오버라이드를 이 서버가 받는지 확인하지 못했습니다.";

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
 * 프로필 쓰기가 "이 서버는 그 필드를 모른다"고 거절당한 것인가.
 *
 * 400 가운데 **모양 거절만** 골라낸다. 서버의 closed-world 디코더는 모르는 키를
 * "unknown … field"로 답하고(AgentProfileInput / CreateAgentRunRequest /
 * RunRoutingInput), 정당한 게이트 거절은 "routing.model is not in
 * workspace.settings.allowed_agent_models"처럼 다른 문장이다. 후자까지 capability
 * 강등으로 읽으면, 허용목록 밖 모델을 한 번 고른 것 때문에 기능 전체가 없는
 * 것처럼 화면이 바뀐다.
 *
 * 404는 **여기에 들어오지 않는다**(R1 M3). 이 판정을 쓰는 유일한 호출자는 프로필
 * PUT이고, 그 경로의 404는 "그 사이에 에이전트가 사라졌다"는 뜻이지 "이 서버에
 * effort 축이 없다"는 뜻이 아니다. 경로 자체가 없는 서버는 effort-table 프로브가
 * 이미 404로 답한다.
 */
export function isUnknownFieldRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 400 && /unknown/i.test(error.message);
}

/**
 * 전송 표면 프로브의 답을 판정으로. 순수 함수라 단위 테스트가 계약을 고정한다.
 *
 * 프로브는 "이 서버가 `routing` 블록을 읽고 검사하는가"만 묻는다. 물음의 형태는
 * **반드시 거절당하는 요청**이다(존재할 수 없는 rootId + 유효하지 않은 effort
 * 토큰). 두 세대의 답이 갈리는 지점이 정확히 그 사이에 있기 때문이다:
 *
 *   MOMO-625 이후  decode 직후 `RunRoutingInput.validate`가 돌아 400을 던진다.
 *                  트랜잭션이 열리기 전이라 아무것도 쓰이지 않는다.
 *   MOMO-625 이전  `routing`은 모르는 키라 무시되고, 다음 검사인 rootId 조회가
 *                  404로 답한다. 이때도 아무것도 쓰이지 않는다
 *                  (momowebqa 실측: 404 "thread root not found", seq 증가 없음).
 *
 * 어느 쪽으로도 확정되지 않으면 unknown이고, unknown이면 컨트롤은 잠긴다.
 */
export function verdictFromSendProbe(error: unknown): CapabilityVerdict {
  if (error instanceof ApiError) {
    // 서버가 routing을 이름으로 부르며 거절했다 = 그 블록을 읽었다.
    if (error.status === 400 && /routing/i.test(error.message)) {
      return { support: "ready", reason: null };
    }
    // routing을 한 번도 언급하지 않고 다음 검사로 넘어갔다 = 조용히 버렸다.
    if (error.status === 404) {
      return { support: "absent", reason: SEND_UNSUPPORTED_REASON };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        support: "unknown",
        reason: `${SEND_UNKNOWN_REASON} 이 채널에 글을 쓸 권한이 있는지 확인하세요.`,
      };
    }
    return { support: "unknown", reason: `${SEND_UNKNOWN_REASON} ${error.message}` };
  }
  if (error instanceof NetworkError) {
    return { support: "unknown", reason: error.message };
  }
  // 프로브가 성공했다는 것은 우리가 만든 없는 rootId가 통과했다는 뜻이고, 그것은
  // 우리가 서버 형상을 잘못 읽고 있다는 신호다. 그 상태에서 ready를 주장하지 않는다.
  return { support: "unknown", reason: SEND_UNKNOWN_REASON };
}

// ---- 서버 한 대에 대해 배운 것 ------------------------------------------------

/**
 * 판정의 범위. 주소가 바뀌면 다른 서버이고, 워크스페이스가 바뀌면 허용목록과
 * 에이전트가 다르다. 둘 중 하나만 달라도 앞서 배운 것은 이 화면의 사실이 아니다.
 */
export function routingScope(workspaceId: string): string {
  return `${apiBase()}|${workspaceId.toLowerCase()}`;
}

interface ServerFacts {
  scope: string;
  /** 프로필 effort 쓰기가 모양 거절을 당했다. */
  effortWriterAbsent: boolean;
  /** 전송 표면 프로브의 확정 판정. 아직 물어보지 않았으면 null. */
  send: CapabilityVerdict | null;
  /** 프로브가 지금 날아가 있는가. 중복 발사를 막는다. */
  sendProbing: boolean;
}

let facts: ServerFacts | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 이 범위에 대해 지금까지 아는 것. 범위가 다르면 빈 상태를 **읽기만** 하고
 * 저장하지는 않는다.
 */
function factsFor(scope: string): ServerFacts {
  if (facts !== null && facts.scope === scope) return facts;
  return { scope, effortWriterAbsent: false, send: null, sendProbing: false };
}

/**
 * 스토어는 항상 새 객체로 갈아 끼운다.
 *
 * `useSyncExternalStore`는 스냅샷을 `Object.is`로 비교해서 같은 참조면 렌더를
 * 건너뛴다. 그래서 제자리 변경은 화면에 도달하지 못한다: 프로브가 답을 받아도
 * 컴포저는 "확인 중"에 멈춰 있었다.
 */
function setFacts(next: ServerFacts): void {
  facts = next;
  emit();
}

/**
 * effort를 실은 프로필 쓰기가 모양 거절을 당했다. 그 사실을 이 서버에 대해 기억한다.
 *
 * 같은 커밋(MOMO-625)이 effort writer와 전송 표면 `routing`을 함께 올렸으므로,
 * 이 거절은 두 축 모두에 대한 답이다. 서버가 준 영어 원문은 그대로 화면에 올리지
 * 않는다(사람에게는 표준 문장을, 원문이 필요한 사람은 네트워크 탭을 본다).
 */
export function noteRoutingUnsupported(scope: string): void {
  const state = factsFor(scope);
  if (state.effortWriterAbsent && state.send !== null) return;
  setFacts({
    ...state,
    effortWriterAbsent: true,
    send: { support: "absent", reason: SEND_UNSUPPORTED_REASON },
  });
}

/** 지금까지 배운 사유. 훅 밖에서도 읽을 수 있어야 판정이 한 벌로 남는다. */
export function learnedRoutingReason(scope: string): string | null {
  if (facts === null || facts.scope !== scope) return null;
  return facts.effortWriterAbsent ? UNSUPPORTED_REASON : null;
}

/** 테스트용. 프로덕션 경로에서는 호출하지 않는다. */
export function resetLearnedRoutingSupport(): void {
  facts = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ServerFacts | null {
  return facts;
}

// ---- effort 축 --------------------------------------------------------------

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
  const { workspaceId } = useSession();
  const scope = routingScope(workspaceId);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const query = useQuery({
    queryKey: ["routing", "effort-table", scope],
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

  const learned =
    state !== null && state.scope === scope && state.effortWriterAbsent;
  if (learned) {
    return { support: "absent", table: null, reason: UNSUPPORTED_REASON, recheck };
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

// ---- 메시지 한 건 오버라이드 tier ---------------------------------------------

export type SendRoutingSupport = "idle" | "checking" | "ready" | "absent" | "unknown";

export interface SendRoutingCapability {
  support: SendRoutingSupport;
  reason: string | null;
  /** 아직 안 물어봤으면 물어본다. 세션당 한 번, 서버당 한 번. */
  prove: () => void;
}

/**
 * 전송 표면이 `routing`을 받는가.
 *
 * 프로브는 사람이 [이번만 바꾸기]를 누를 때만 날아간다. 아무도 오버라이드를 쓰지
 * 않는 세션에서는 요청이 0건이고, 쓰는 순간 딱 한 번이다. 결과는 서버 범위로
 * 기억하므로 채널을 옮겨도 다시 묻지 않는다.
 */
export function useSendRoutingCapability(
  channelId: string | null
): SendRoutingCapability {
  const { workspaceId } = useSession();
  const scope = routingScope(workspaceId);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  const prove = useCallback(() => {
    if (channelId === null) return;
    const current = factsFor(scope);
    if (current.send !== null || current.sendProbing) return;
    setFacts({ ...current, sendProbing: true });
    void (async () => {
      let verdict: CapabilityVerdict;
      try {
        await probeSendRouting(workspaceId, channelId);
        verdict = verdictFromSendProbe(null);
      } catch (error) {
        verdict = verdictFromSendProbe(error);
      }
      setFacts({ ...factsFor(scope), sendProbing: false, send: verdict });
    })();
  }, [scope, workspaceId, channelId]);

  const mine = state !== null && state.scope === scope ? state : null;
  if (mine?.send) {
    return { support: mine.send.support, reason: mine.send.reason, prove };
  }
  if (mine?.sendProbing) {
    return { support: "checking", reason: null, prove };
  }
  return { support: "idle", reason: null, prove };
}
