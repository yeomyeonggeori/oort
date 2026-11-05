import type { RestOutcome } from "../../lib/http";
import { SERVER_UNREACHABLE_STREAK } from "./thresholds";

// =============================================================================
// 「서버에 닿지 못함」의 판정 — REST 결과를 접어 만든 한 줄 (#5219, 감사 문서 §4).
//
// 소켓 상태로는 알 수 없다. 배포 중 api가 9초 내려가도 소켓은 살아 있어 어디에도 안 뜨던 것이 이 모델이
// 메우려는 빈칸이다. `lib/http.ts`가 모든 REST 결과를 알려 주고(`subscribeRestOutcome`), 여기서는 순수
// 함수로 접는다.
//
// 규칙(감사 문서 §4):
//   - 닿지 못함으로 세는 것: 응답이 없음(`NetworkError`), 502, 504, **`error.code`가 없는** 503.
//   - 그 밖의 모든 응답(200, 4xx, 500, 429, `error.code`가 있는 503)은 서버가 직접 답한 것이다. 닿았다는
//     증거이므로 세지 않고, 연속도 끊는다.
//   - **서로 다른 요청** 3건이 연달아 닿지 못했고 그 뒤 응답이 없으면 선언한다. 한 요청이 세 번 재시도하는
//     것은 한 건이다. 응답 한 건으로 풀린다. 앱이 스스로 보내는 확인 요청(`restProbe.ts`, #5407)은 풀기만 하고 실패는 쌓지 않는다.
// 정상 운영에서도 503을 내는 길이 있어(허들 미구성 인스턴스의 `…/huddles/active`) 한 건으로는 판정하지
// 않는다. 그런 503은 다른 요청의 성공이 곧바로 끊는다.
//
// 「요청이 같다」의 기준은 메서드 + 쿼리 없는 주소다(`GET https://…/v1/…/messages`). 채널이 다르면 주소가
// 달라 다른 요청으로 센다.
// =============================================================================

export interface RestSignal {
  /**
   * 마지막 응답 뒤로 닿지 못한 서로 다른 요청(`메서드 주소`). 선언에 필요한 수까지만 든다 — 그 이상은
   * 알아도 판정이 같다.
   */
  readonly unanswered: readonly string[];
}

export const INITIAL_REST_SIGNAL: RestSignal = { unanswered: [] };

/**
 * 앱이 스스로 보내는 확인 요청(`restProbe.ts`, #5407)의 주소 꼬리. 서버가 이미 공개해 둔 살아 있음 확인이다(인증 없음). 요청의 「같음」은 메서드 + 쿼리 없는 주소라
 * 이 한 건은 몇 번을 보내도 한 건이다.
 */
export const REST_PROBE_PATH = "/healthz";

/** 이 결과가 확인 요청(`GET …/healthz`)의 것인가. */
export function isRestProbeOutcome(outcome: RestOutcome): boolean {
  return outcome.method === "GET" && outcome.target.endsWith(REST_PROBE_PATH);
}

/** 이 결과가 「서버에 닿지 못함」 한 건인가. */
export function isUnreachableOutcome(outcome: RestOutcome): boolean {
  if (outcome.kind === "network") return true;
  if (outcome.status === 502 || outcome.status === 504) return true;
  // 503은 `error.code`가 없을 때만이다. 코드가 있으면 우리 서버가 직접 이름을 붙여 거절한 것이다
  // (예: 보관소 미연결). 길 위의 장비가 낸 503이 아니다.
  return outcome.status === 503 && outcome.code === undefined;
}

/** 결과 한 건을 접는다. 닿지 못한 서로 다른 요청이면 쌓고, 그 밖의 응답이면 연속을 끊는다. */
export function foldRestOutcome(state: RestSignal, outcome: RestOutcome): RestSignal {
  if (!isUnreachableOutcome(outcome)) {
    return state.unanswered.length === 0 ? state : INITIAL_REST_SIGNAL;
  }
  // 확인 요청의 실패는 쌓지 않는다(#5407): 확인은 이미 선 판정을 다시 묻는 것이지 새 증거가 아니다. 쌓으면 「알 수 없음」(실패 1~2건)이 확인 한 번에
  // 선언(3건)으로 올라 보내기를 막는다. 풀기만 한다 - 서버가 답한 확인(위 가지)은 어떤 응답이든 기억을 지운다.
  if (isRestProbeOutcome(outcome)) return state;
  const request = `${outcome.method} ${outcome.target}`;
  if (state.unanswered.includes(request)) return state;
  if (state.unanswered.length >= SERVER_UNREACHABLE_STREAK) return state;
  return { unanswered: [...state.unanswered, request] };
}

/** 서버에 닿지 못함이 확정인가(보내기·올리기·승인을 막아도 되는 근거). */
export function restUnreachableDeclared(state: RestSignal): boolean {
  return state.unanswered.length >= SERVER_UNREACHABLE_STREAK;
}

/** 아직 선언은 아니지만 응답 없이 닿지 못한 요청이 있다(「알 수 없음」의 근거). */
export function restHasUnansweredFailure(state: RestSignal): boolean {
  return state.unanswered.length > 0;
}
