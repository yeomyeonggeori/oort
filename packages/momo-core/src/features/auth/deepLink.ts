import { normalizeServerUrl } from "../../lib/serverUrl";
// -----------------------------------------------------------------------------
// 실기기 제약 (스파이크 #837 게이트 2) — **RN 호스트는 `react-native-url-polyfill`
// 을 먼저 설치해야 한다.**
//
// RN 코어의 `URL` 은 정규식 기반이고 WHATWG 구현이 아니라 `oort://join?...` 같은
// 커스텀 스킴을 파싱하지 못한다: 같은 케이스 19건이 RN 코어 URL 에서 19/19 실패,
// `react-native-url-polyfill@4.0.0` 에서 19/19 통과했다.
// **이 파일 자체는 무수정으로 통과했다** — 고칠 것은 호스트의 부트스트랩이다.
// -----------------------------------------------------------------------------



// =============================================================================
// Invite deep link (`oort://join`) — the web consumer of the contract in
// docs/onboarding-deeplink.md, which the ops CLI (MOMO-584) and the mac client
// (MomoDeepLinkParser, MOMO-585) already implement byte for byte:
//
//     oort://join?server=<percent-encoded base URL>&code=<invite code>
//
// goal B13: the scheme was `momo://` through MOMO-584/585. The product is oort
// now, so links are MINTED as `oort://` and still ACCEPTED as either — see
// ACCEPTED_SCHEMES. The repo, the crates and the binaries keep the momo
// codename; only the surface a person sees moved.
//
//   - exactly two meaningful parameters, order-independent;
//   - unknown parameters ignored (forward compatibility);
//   - `server` arrives percent-encoded and is re-validated here, because a link
//     is untrusted input no matter who forwarded it.
//
// Two ways in, one parser:
//   desktop  the shell hands over the URL (`momo:deep-link`, lib/tauri.ts);
//   browser  there is no custom scheme, so the same parameters ride the page
//            URL instead: `?server=...&code=...`, `?code=...` alone, or
//            `?join=<percent-encoded oort:// link>` when a whole link was
//            pasted. The HashRouter's own query (`#/path?code=...`) is read too,
//            since that is where a link lands once the router owns the URL.
//
// The invite code is a bearer secret. It is parsed here and handed to the form;
// it is never logged, and the connect screen strips it from the address bar
// once it has been read.
// =============================================================================

export interface JoinPrefill {
  /** Validated API base, or "" when the link only carried a code. */
  serverUrl: string;
  /** Invite code, or "" when the link only carried a server. */
  inviteCode: string;
}

/**
 * The scheme links are MINTED with (goal B13, momo -> oort rebrand).
 * `buildJoinLink` and the ops CLI both emit this one.
 */
export const JOIN_SCHEME = "oort";

/**
 * Every scheme a link is ACCEPTED under.
 *
 * The old name is absorbed rather than ignored, and that is a decision about
 * links that already exist: an invite is handed over out of band — email, Slack,
 * a message — and it stays valid for days. Dropping `momo://` would break links
 * that were correct when they were sent, to no one's benefit, so the OS keeps
 * both registrations (`tauri.conf.json`, both `Info.plist`s) and every consumer
 * keeps both here.
 */
const ACCEPTED_SCHEMES = [JOIN_SCHEME, "momo"] as const;
const JOIN_ACTION = "join";
const LINK_ACTION = "link";

function schemeAction(url: URL): string {
  return url.hostname !== ""
    ? url.hostname.toLowerCase()
    : (url.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();
}

function parseAcceptedScheme(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (!ACCEPTED_SCHEMES.some((scheme) => protocol === `${scheme}:`)) return null;
  return url;
}

function firstParam(params: URLSearchParams, name: string): string {
  for (const [key, value] of params) {
    if (key.toLowerCase() === name) return value.trim();
  }
  return "";
}

/** A link's `server` is only accepted once it validates as a base URL. */
function validatedServer(raw: string): string {
  if (raw === "") return "";
  const checked = normalizeServerUrl(raw);
  return checked.ok ? checked.base : "";
}

function prefillFrom(params: URLSearchParams): JoinPrefill | null {
  const serverUrl = validatedServer(firstParam(params, "server"));
  const inviteCode = firstParam(params, "code");
  if (serverUrl === "" && inviteCode === "") return null;
  return { serverUrl, inviteCode };
}

/**
 * Parse a join link under any accepted scheme. Returns null when the URL is not
 * a join link or
 * carries nothing usable, so a stray link is ignored rather than half-applied.
 *
 * The action is the authority (`oort://join`) or, when the link omits it
 * (`oort:join`), the first path segment. Same rule as the mac parser.
 */
export function parseJoinDeepLink(raw: string): JoinPrefill | null {
  const url = parseAcceptedScheme(raw);
  if (!url) return null;
  if (schemeAction(url) !== JOIN_ACTION) return null;
  return prefillFrom(url.searchParams);
}

/**
 * Browser fallback: the same two parameters off the page URL. Reads the real
 * query first, then the hash query the HashRouter leaves behind, and unwraps a
 * whole `oort://join` link passed as `?join=`.
 */
export function parseJoinFromPageUrl(href: string): JoinPrefill | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const hashQueryIndex = url.hash.indexOf("?");
  const hashParams = new URLSearchParams(
    hashQueryIndex >= 0 ? url.hash.slice(hashQueryIndex + 1) : ""
  );

  for (const params of [url.searchParams, hashParams]) {
    const wrapped = firstParam(params, "join");
    if (wrapped !== "") {
      const parsed = parseJoinDeepLink(wrapped);
      if (parsed) return parsed;
    }
    const direct = prefillFrom(params);
    if (direct) return direct;
  }
  return null;
}

/** The parameters the connect screen strips once a prefill has been read. */
export const JOIN_URL_PARAMS = ["join", "server", "code"] as const;

/**
 * Remove the invite parameters from a URL string, preserving everything else.
 * The code is a bearer secret: leaving it in the address bar puts it in history
 * and in the next screenshot.
 */
export function urlWithoutJoinParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  for (const name of JOIN_URL_PARAMS) url.searchParams.delete(name);

  const hashQueryIndex = url.hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const path = url.hash.slice(0, hashQueryIndex);
    const hashParams = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
    for (const name of JOIN_URL_PARAMS) hashParams.delete(name);
    const rest = hashParams.toString();
    url.hash = rest === "" ? path : `${path}?${rest}`;
  }
  return url.toString();
}

/**
 * Device-link deep link (`oort://link?server=…&token=…`, ADR-0180 D2).
 *
 * Same grammar as `join`: two meaningful parameters, order-independent,
 * unknown parameters ignored, `momo://` absorbed. Both `server` and `token`
 * are required; an unusable `server` rejects the whole link (unlike join,
 * which can prefill a code alone).
 */
export interface DeviceLinkPrefill {
  /** Validated API base. */
  serverUrl: string;
  /** Raw 32-byte base64url voucher (43 characters). */
  token: string;
}

/**
 * True when the URL is a device-link *action* (`oort://link` / `momo://link`),
 * even if `server` or `token` is unusable. The connect screen uses this to
 * tell "malformed link" from "not our URL".
 */
export function isDeviceLinkAction(raw: string): boolean {
  const url = parseAcceptedScheme(raw);
  return url !== null && schemeAction(url) === LINK_ACTION;
}

function deviceLinkPrefillFrom(params: URLSearchParams): DeviceLinkPrefill | null {
  const serverUrl = validatedServer(firstParam(params, "server"));
  const token = firstParam(params, "token");
  if (serverUrl === "" || token === "") return null;
  return { serverUrl, token };
}

/**
 * Parse a device-link URL. Null when it is not one, is missing a parameter,
 * or carries a `server` that does not validate as a base URL.
 */
export function parseDeviceLinkDeepLink(raw: string): DeviceLinkPrefill | null {
  const url = parseAcceptedScheme(raw);
  if (!url) return null;
  if (schemeAction(url) !== LINK_ACTION) return null;
  return deviceLinkPrefillFrom(url.searchParams);
}
