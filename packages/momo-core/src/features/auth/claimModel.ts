import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";

export interface ClaimFailure {
  message: string;
  /** Used or already-passworded: the next step is the sign-in form. */
  suggestSignIn: boolean;
  retryable: boolean;
  /** Keep the password fields. False when the token itself cannot be consumed. */
  keepForm: boolean;
}

function transportFailure(cause: unknown): ClaimFailure | null {
  if (cause instanceof NetworkError) {
    return {
      message: cause.message,
      suggestSignIn: false,
      retryable: true,
      keepForm: true,
    };
  }
  if (cause instanceof ApiError) return null;
  return {
    message: "서버 응답을 읽지 못했습니다. 주소를 확인하고 다시 시도하세요.",
    suggestSignIn: false,
    retryable: true,
    keepForm: true,
  };
}

/**
 * Claim-token failures to distinct copy. Status is the split (404 invalid,
 * 410 expired, 409 used). Unrecognised messages fall back to per-status copy,
 * never a raw English string in front of the user.
 */
export function claimFailureCopy(cause: unknown): ClaimFailure {
  const transport = transportFailure(cause);
  if (transport) return transport;
  const failure = cause as ApiError;
  switch (failure.status) {
    case 404:
      return {
        message: "이 링크는 유효하지 않습니다. 받은 주소를 그대로 여세요.",
        suggestSignIn: false,
        retryable: false,
        keepForm: false,
      };
    case 410:
      return {
        message:
          "이 링크는 만료되었습니다. 설치를 실행한 쪽에 새 링크를 요청하세요.",
        suggestSignIn: false,
        retryable: false,
        keepForm: false,
      };
    case 409:
      return {
        message: "이 링크는 이미 사용되었습니다. 로그인하세요.",
        suggestSignIn: true,
        retryable: false,
        keepForm: false,
      };
    case 400:
      return {
        message: "비밀번호를 다시 확인하세요. 비어 있거나 너무 깁니다.",
        suggestSignIn: false,
        retryable: false,
        keepForm: true,
      };
    case 429:
      return {
        message: "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
        suggestSignIn: false,
        retryable: false,
        keepForm: true,
      };
    default:
      return {
        message:
          failure.status >= 500
            ? "서버에서 오류가 났습니다. 잠시 뒤에 다시 시도하세요."
            : "요청을 처리하지 못했습니다. 받은 주소를 확인하고 다시 시도하세요.",
        suggestSignIn: false,
        retryable: failure.status >= 500,
        keepForm: true,
      };
  }
}
