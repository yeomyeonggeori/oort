import { ApiError } from "../../lib/api";
import { issueForStatus, type UploadIssue } from "../attachments/model";
import { copyForCause, type ConnectionCause } from "./model";
import { causeOfFailure } from "./failure";

// =============================================================================
// 올리기가 실패한 이유를 「분류」로 말한다 (#5221, #5201 S-C, 감사 문서 §2.3·§3·§5).
//
// 지금까지 502·503은 「파일 보관소가 연결돼 있지 않습니다. 서버 관리자에게 알리세요」였다. 배포 중 api가 잠깐 내려가거나
// 길 위의 장비가 502를 내도 같은 문장이 나와서, 기다리면 되는 일에 관리자를 부르게 했다. 이제는 **닿지 못함**(오프라인 ·
// 서버에 닿지 못함: `causeOfFailure`의 분류)이면 보관소 이야기를 하지 않고 그 원인으로 말한다 — 칩은 「다시 올리기」가 선다
// (`unavailable`). 우리 서버가 코드를 붙여 직접 낸 503(보관소 미연결)만 `no-archive`로 남는다(S-E가 구분 코드를 준다).
//
// 문장은 모델의 표(`copyForCause(cause).uploadFailed`)가 갖는다. 상태 코드는 어디에도 없다.
// =============================================================================

export interface UploadFailureVerdict {
  /** 칩의 상태가 되는 이유(재시도 가능 여부 등이 여기서 갈린다). */
  readonly issue: UploadIssue;
  /** 실패가 닿지 못함일 때만. 화면은 이 원인의 문장을 쓴다. */
  readonly cause: ConnectionCause | null;
}

/** 요청(`ApiError`·`NetworkError`)이 던진 실패. */
export function verdictForRequestFailure(failure: unknown, deviceOnline: boolean | null): UploadFailureVerdict {
  const cause = causeOfFailure(failure, deviceOnline);
  if (cause !== null) return { issue: "unavailable", cause };
  if (failure instanceof ApiError) return { issue: issueForStatus(failure.status), cause: null };
  return { issue: "unavailable", cause: null };
}

/**
 * 바이트를 올리는 쪽(XHR)의 실패: 막힘(CSP) · 상대가 답한 코드 · 연결 실패. 종류를 모르거나 취소(`aborted`, 실패가 아니라 보통 여기
 * 오지 않는다)는 연결 실패로 접는다: 응답이 없었다는 것만 안다.
 */
export function verdictForTransferFailure(
  failure: "blocked" | "status" | "network" | "aborted" | undefined,
  status: number | undefined,
  deviceOnline: boolean | null
): UploadFailureVerdict {
  if (failure === "blocked") return { issue: "blocked", cause: null };
  if (failure === "status" && status !== undefined) {
    return verdictForRequestFailure(new ApiError(status, ""), deviceOnline);
  }
  // 연결 실패: XHR은 응답이 없었다는 것만 안다.
  return {
    issue: "unavailable",
    cause: deviceOnline === false ? "deviceOffline" : "serverUnreachable",
  };
}

/** 이 원인이 올리기 실패를 설명하면 그 문장의 사전 키, 아니면 `null`(칩의 기존 문장을 쓴다). */
export function uploadReasonKey(cause: ConnectionCause | undefined) {
  return cause === undefined ? null : copyForCause(cause).uploadFailed;
}
