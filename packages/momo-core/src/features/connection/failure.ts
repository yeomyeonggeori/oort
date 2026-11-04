import { ApiError } from "../../lib/api";
import { NetworkError, type RestResponseOutcome } from "../../lib/http";
import type { ConnectionCause } from "./model";
import { isUnreachableOutcome } from "./restSignal";

// =============================================================================
// 실패 하나가 말하는 원인 (#5221, #5201 S-C, 감사 문서 §4 원칙 5).
//
// 불러오기·올리기·보내기가 실패한 **그 자리**는 전역 연결 상태가 아니라 방금 던져진 실패로 원인을 말한다.
// 전역 신호(연결 카드)는 한 곳에서 말하고, 실패한 곳은 행동과 짧은 이유만 말한다(원칙 3). 그래서 이
// 함수는 모델의 `deriveConnectionState`를 읽지 않고, 실패 객체와 그때의 기기 온라인 여부만 본다.
//
// 분류는 모델과 **같은 규칙**이다: 응답이 없었으면(`NetworkError`) 기기가 꺼져 있을 때 오프라인, 아니면
// 서버에 닿지 못함. 응답이 왔어도 길 위의 장비가 낸 것(502·504, 코드 없는 503)이면 서버에 닿지 못함이고,
// 그 판정은 `restSignal.ts`의 `isUnreachableOutcome` 한 곳에서 빌려 쓴다(나중에 S-E가 그 규칙을 넓히면
// 여기도 같이 따라간다). 그 밖의 응답(4xx, 코드 있는 5xx)은 서버가 직접 답한 것이라 원인이 없다(`null`).
// 문장은 `copyForCause`가 갖는다. 서버 원문·상태 코드는 어떤 문장에도 들어가지 않는다.
// =============================================================================

/**
 * `failure`가 말하는 원인. 연결 쪽 원인이 아니면 `null`(서버가 직접 답했거나, 알 수 없는 오류).
 * `deviceOnline`은 실패한 그때 기기가 아는 사실이다(`true`·`false`·모르면 `null`: 모르면 오프라인이라
 * 하지 않는다).
 */
export function causeOfFailure(failure: unknown, deviceOnline: boolean | null): ConnectionCause | null {
  if (failure instanceof NetworkError) return deviceOnline === false ? "deviceOffline" : "serverUnreachable";
  if (failure instanceof ApiError) {
    const outcome: RestResponseOutcome = {
      kind: "response",
      at: 0,
      method: "",
      target: "",
      status: failure.status,
      ...(failure.code === undefined ? {} : { code: failure.code }),
    };
    return isUnreachableOutcome(outcome) ? "serverUnreachable" : null;
  }
  return null;
}

/**
 * 오류 객체를 **모르는** 자리의 원인(훅이 `isError`만 내놓거나 원천이 여럿이라 하나로 말할 수 없다). 기기가 아는 사실 하나만 안다:
 * 꺼져 있으면 오프라인, 아니면 원인 없음(모르면 `null`, 오프라인이라 하지 않는다).
 */
export function causeOfUnknownFailure(deviceOnline: boolean | null): ConnectionCause | null {
  return deviceOnline === false ? "deviceOffline" : null;
}
