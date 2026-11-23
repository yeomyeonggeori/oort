import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { sha256Utf8 } from "../../lib/sha256";
import type { PlainMessageKey } from "../../i18n/keys";
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

// 문구는 `i18n/catalogs/<언어>/auth.json`의 `auth.deviceLink.*`에 있다. 화면이 그릴 때 지금 언어로 푼다.
export const DEVICE_LINK_EXPIRED_KEY = "auth.deviceLink.expired" satisfies PlainMessageKey;
export const DEVICE_LINK_USED_KEY = "auth.deviceLink.used" satisfies PlainMessageKey;
export const DEVICE_LINK_MALFORMED_KEY = "auth.deviceLink.malformed" satisfies PlainMessageKey;
export const DEVICE_LINK_SAS_WAIT_KEY = "auth.deviceLink.sasWait" satisfies PlainMessageKey;
export const DEVICE_LINK_PERMISSION_KEY = "auth.deviceLink.permission" satisfies PlainMessageKey;
export const DEVICE_LINK_UNREACHABLE_KEY = "auth.deviceLink.unreachable" satisfies PlainMessageKey;
export const DEVICE_LINK_RETRY_KEY = "auth.deviceLink.retryLabel" satisfies PlainMessageKey;
export const DEVICE_LINK_QR_KEY = "auth.deviceLink.qrLabel" satisfies PlainMessageKey;
export const DEVICE_LINK_ADDRESS_FALLBACK_KEY = "auth.deviceLink.addressFallbackLabel" satisfies PlainMessageKey;
export const DEVICE_LINK_SETTINGS_KEY = "auth.deviceLink.settingsLabel" satisfies PlainMessageKey;
export const DEVICE_LINK_QR_INSTRUCTION_KEY = "auth.deviceLink.qrInstruction" satisfies PlainMessageKey;
export const DEVICE_LINK_CAMERA_OPENING_KEY = "auth.deviceLink.cameraOpening" satisfies PlainMessageKey;
export const DEVICE_LINK_CAMERA_ERROR_KEY = "auth.deviceLink.cameraError" satisfies PlainMessageKey;

export class DeviceLinkFormatError extends Error {
  constructor() {
    // 사람이 읽지 않는 진단 글이다. 화면은 `deviceLinkFailureCopy`로 문장을 짓는다.
    super("not a device link code");
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
    return { message: { raw: cause.message }, suggestSignIn: false, retryable: true };
  }
  if (cause instanceof ApiError) return null;
  return null;
}

export function deviceLinkFailureCopy(cause: unknown): ConnectFailure {
  if (cause instanceof DeviceLinkFormatError) {
    return {
      message: { key: DEVICE_LINK_MALFORMED_KEY },
      suggestSignIn: false,
      retryable: false,
    };
  }
  const transport = transportFailure(cause);
  if (transport) return transport;
  if (!(cause instanceof ApiError)) {
    return {
      message: { key: DEVICE_LINK_MALFORMED_KEY },
      suggestSignIn: false,
      retryable: false,
    };
  }
  const failure = cause;
  switch (failure.status) {
    case 401:
      return {
        message: { key: DEVICE_LINK_EXPIRED_KEY },
        suggestSignIn: false,
        retryable: false,
      };
    case 409:
      return {
        message: { key: DEVICE_LINK_USED_KEY },
        suggestSignIn: false,
        retryable: false,
      };
    case 400:
      return {
        message: { key: DEVICE_LINK_MALFORMED_KEY },
        suggestSignIn: false,
        retryable: false,
      };
    case 429:
      return {
        message: { key: "auth.failure.tooManyRequests" },
        suggestSignIn: false,
        retryable: false,
      };
    default:
      return {
        message:
          failure.status >= 500
            ? { key: "auth.failure.serverError" }
            : { key: DEVICE_LINK_MALFORMED_KEY },
        suggestSignIn: false,
        retryable: failure.status >= 500,
      };
  }
}
