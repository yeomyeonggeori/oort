import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { sha256Utf8 } from "../../lib/sha256";
import type { ConnectFailure } from "./connectModel";

// =============================================================================
// Device-link copy and token shape (ADR-0180 D2·D3·D4). The phone ConnectScreen
// and any later web consumer share these sentences so 401/409/malformed cannot
// drift into three different stories about the same voucher.
// =============================================================================

/** 32 CSPRNG bytes, base64url, no padding. */
export const DEVICE_LINK_TOKEN_LEN = 43;

/** ADR-0180 D1. Redeemed voucher / SAS hold lives this long. */
export const DEVICE_LINK_TTL_MS = 120_000;

export const DEVICE_LINK_POLL_MS = 2_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const DEVICE_LINK_EXPIRED_COPY =
  "이 연결 코드는 만료되었거나 알 수 없습니다.";
export const DEVICE_LINK_USED_COPY =
  "이 연결 코드는 이미 사용되었습니다.";
export const DEVICE_LINK_MALFORMED_COPY =
  "연결 코드 형식이 아닙니다. QR을 다시 찍으세요.";
export const DEVICE_LINK_SAS_WAIT_COPY =
  "데스크톱에서 확인을 누르면 진행됩니다.";
export const DEVICE_LINK_PERMISSION_COPY =
  "카메라 권한이 없어 QR을 찍을 수 없습니다. 주소로 연결하세요.";
export const DEVICE_LINK_UNREACHABLE_COPY =
  "서버에 닿지 못했습니다. 네트워크가 연결되면 다시 기다립니다.";
export const DEVICE_LINK_RETRY_LABEL = "QR 다시 찍기";
export const DEVICE_LINK_QR_LABEL = "QR로 연결";
export const DEVICE_LINK_ADDRESS_FALLBACK_LABEL = "주소로 연결";
export const DEVICE_LINK_SETTINGS_LABEL = "설정에서 허용";

export class DeviceLinkFormatError extends Error {
  constructor() {
    super(DEVICE_LINK_MALFORMED_COPY);
    this.name = "DeviceLinkFormatError";
  }
}

export function isDeviceLinkToken(raw: string): boolean {
  return TOKEN_RE.test(raw);
}

/**
 * Four-digit SAS the issuer also shows. Same formula as the server INSERT:
 * `lpad(((get_byte(digest,0)*256 + get_byte(digest,1)) % 10000)::text, 4, '0')`
 * on `digest(token, 'sha256')`. Used when redeem omits `sas` (OpenAPI does).
 */
export function deviceLinkSasDigits(token: string): string {
  const digest = sha256Utf8(token);
  const n = ((digest[0] ?? 0) * 256 + (digest[1] ?? 0)) % 10000;
  return n.toString().padStart(4, "0");
}

function transportFailure(cause: unknown): ConnectFailure | null {
  if (cause instanceof NetworkError) {
    return { message: cause.message, suggestSignIn: false, retryable: true };
  }
  if (cause instanceof ApiError) return null;
  return null;
}

export function deviceLinkFailureCopy(cause: unknown): ConnectFailure {
  if (cause instanceof DeviceLinkFormatError) {
    return {
      message: DEVICE_LINK_MALFORMED_COPY,
      suggestSignIn: false,
      retryable: false,
    };
  }
  const transport = transportFailure(cause);
  if (transport) return transport;
  if (!(cause instanceof ApiError)) {
    return {
      message: DEVICE_LINK_MALFORMED_COPY,
      suggestSignIn: false,
      retryable: false,
    };
  }
  const failure = cause;
  switch (failure.status) {
    case 401:
      return {
        message: DEVICE_LINK_EXPIRED_COPY,
        suggestSignIn: false,
        retryable: false,
      };
    case 409:
      return {
        message: DEVICE_LINK_USED_COPY,
        suggestSignIn: false,
        retryable: false,
      };
    case 400:
      return {
        message: DEVICE_LINK_MALFORMED_COPY,
        suggestSignIn: false,
        retryable: false,
      };
    case 429:
      return {
        message: "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
        suggestSignIn: false,
        retryable: false,
      };
    default:
      return {
        message:
          failure.status >= 500
            ? "서버에서 오류가 났습니다. 잠시 뒤에 다시 시도하세요."
            : DEVICE_LINK_MALFORMED_COPY,
        suggestSignIn: false,
        retryable: failure.status >= 500,
      };
  }
}
