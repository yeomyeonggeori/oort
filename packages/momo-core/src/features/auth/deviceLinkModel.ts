import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import type { ConnectFailure } from "./connectModel";

// =============================================================================
// Device-link copy and token shape (ADR-0180 D2·D3·D4). The phone ConnectScreen
// and any later web consumer share these sentences so 401/409/malformed cannot
// drift into three different stories about the same voucher.
// =============================================================================

/** 32 CSPRNG bytes, base64url, no padding. */
export const DEVICE_LINK_TOKEN_LEN = 43;

export const DEVICE_LINK_EXPIRED_COPY =
  "이 연결 코드는 만료됐거나 알 수 없습니다.";
export const DEVICE_LINK_USED_COPY =
  "이 연결 코드는 이미 사용되었습니다.";
export const DEVICE_LINK_MALFORMED_COPY =
  "연결 코드 형식이 아닙니다. QR을 다시 찍으세요.";
export const DEVICE_LINK_SAS_WAIT_COPY =
  "데스크톱에서 확인을 누르면 진행돼요.";
export const DEVICE_LINK_PERMISSION_COPY =
  "카메라 권한이 없어 QR을 찍을 수 없습니다. 주소로 연결하세요.";
export const DEVICE_LINK_RETRY_LABEL = "QR 다시 찍기";
export const DEVICE_LINK_QR_LABEL = "QR로 연결";
export const DEVICE_LINK_ADDRESS_FALLBACK_LABEL = "주소로 연결";

export function isDeviceLinkToken(raw: string): boolean {
  void raw;
  return false;
}

export function deviceLinkSasDigits(token: string): string {
  void token;
  return "0000";
}

export function deviceLinkFailureCopy(cause: unknown): ConnectFailure {
  void cause;
  return {
    message: "not implemented",
    suggestSignIn: false,
    retryable: false,
  };
}

/** Transport copy is shared with the connect screen; keep the type imported. */
export function deviceLinkTransportFailure(
  cause: unknown
): ConnectFailure | null {
  if (cause instanceof NetworkError) {
    return { message: cause.message, suggestSignIn: false, retryable: true };
  }
  if (cause instanceof ApiError) return null;
  return {
    message: DEVICE_LINK_MALFORMED_COPY,
    suggestSignIn: false,
    retryable: false,
  };
}
