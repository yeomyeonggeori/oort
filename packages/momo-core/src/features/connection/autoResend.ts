import { NetworkError } from "../../lib/http";
import { AUTO_RESEND_MAX_ATTEMPTS, AUTO_RESEND_WINDOW_MS } from "./thresholds";

// =============================================================================
// 못 보낸 글을 저절로 다시 보내도 되나 — 판정 함수 (#5219, #5201 결정 ⑤).
//
// 결정 ⑤: **네트워크로 못 보낸 글(`NetworkError`)만** 연결이 돌아오면 같은 멱등 키(`client_msg_id`)로 자동
// 재전송한다. 한 글당 3회, 첫 실패로부터 5분 안에서만. 서버가 거절한 글(`ApiError`: 4xx, 5xx 응답)은
// 몰래 다시 보내지 않고 손으로 보내게 둔다.
//
// 여기에는 **판정만** 있다. 실제 재전송 배선(언제 부르고, 시도 횟수를 어디에 세는지)은 웹 S-C·폰 S-D가
// 한다. 대기 행의 모델(`features/timeline/model.ts`)은 다른 칸이 고치고 있어 건드리지 않고 이 파일에 둔다.
//
// 응답이 없었던 보내기(`timeout`)도 다시 보내도 된다: 서버가 이미 받았을 수 있지만 같은 멱등 키가 중복을
// 막는다. 502·504·코드 없는 503처럼 **응답이 온** 실패는 `NetworkError`가 아니므로 이 판정에서는 손으로
// 보내는 쪽이다(결정 ⑤의 문자 그대로).
// =============================================================================

export interface AutoResendInput {
  /** 보내기가 던진 것. */
  readonly failure: unknown;
  /** 이 글을 이미 저절로 다시 보낸 횟수. 첫 실패 직후는 0. */
  readonly attempts: number;
  /** 이 글이 처음 보내지 못한 때(epoch ms). */
  readonly firstFailedAt: number;
  readonly now: number;
}

export interface AutoResendJudgement {
  /** 묻지 않고 다시 보내도 되는 종류의 실패인가(`NetworkError`만). */
  readonly retryable: boolean;
  /** 지금 하려는 자동 재전송이 몇 번째인가(1부터). */
  readonly attempt: number;
  /** 상한을 넘었나. 어느 상한인지는 `limit`. */
  readonly exhausted: boolean;
  readonly limit: "attempts" | "window" | null;
  /** 지금 다시 보낸다: `retryable`이고 상한 안이다. */
  readonly resend: boolean;
}

export function judgeAutoResend(input: AutoResendInput): AutoResendJudgement {
  const retryable = input.failure instanceof NetworkError;
  const limit: AutoResendJudgement["limit"] =
    input.attempts >= AUTO_RESEND_MAX_ATTEMPTS
      ? "attempts"
      : input.now - input.firstFailedAt >= AUTO_RESEND_WINDOW_MS
        ? "window"
        : null;
  return {
    retryable,
    attempt: input.attempts + 1,
    exhausted: limit !== null,
    limit,
    resend: retryable && limit === null,
  };
}
