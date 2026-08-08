// =============================================================================
// Server address validation — the pure half of the web client's serverBase.ts
// (ADR-0137 D3, goal RN-C1).
//
// Split, not rewritten: the storage half (which server this device chose, and
// where that choice is kept) stays in the host, because it is localStorage on
// web and MMKV on RN. What moved here is the part that has no platform in it —
// deciding whether a string a person typed, a deep link carried, or an mDNS
// record advertised is a usable API base, and folding it to the one shape every
// request concatenates onto.
//
// The host installs its storage-backed reader through `runtime/host.ts`; this
// module knows nothing about it.
// =============================================================================

export type ServerUrlCheck =
  | { ok: true; base: string }
  | { ok: false; message: string };

/** Neutral example, never a real host: RFC 2606 reserves example.com. */
export const SERVER_URL_PLACEHOLDER = "https://oort.example.com";

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Validate and normalise a server address (the web sibling of the mac client's
 * `MomoServerSessionForm.validatedBaseURL()`).
 *
 * Accepts a bare host (`momo.example.com:28000`) by reading it as https, which
 * is the safer of the two guesses: a plaintext guess would silently downgrade a
 * TLS server. A LAN server that only speaks http is reached by typing `http://`
 * or by taking the discovery card's suggestion, which carries its own scheme.
 *
 * Returns the origin plus any path prefix (a reverse proxy may mount the API
 * under `/momo`), with the trailing slash, query and fragment dropped so the
 * value concatenates cleanly with `/v1/...`.
 *
 * RN NOTE (spike #837 게이트 2): `new URL` here is the platform's, and React
 * Native's core URL is not WHATWG-complete. The RN host must install
 * `react-native-url-polyfill` before anything calls this.
 */
export function normalizeServerUrl(raw: string): ServerUrlCheck {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, message: "서버 주소를 입력하세요." };
  }
  const candidate = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      message: `주소를 확인하세요. 예: ${SERVER_URL_PLACEHOLDER}`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
    };
  }
  if (url.hostname === "") {
    return {
      ok: false,
      message: `호스트가 없습니다. 예: ${SERVER_URL_PLACEHOLDER}`,
    };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, base: `${url.origin}${path}` };
}
