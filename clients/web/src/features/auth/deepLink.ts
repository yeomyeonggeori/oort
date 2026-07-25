import { normalizeServerUrl } from "@/lib/serverBase";

// =============================================================================
// Invite deep link (`momo://join`) — the web consumer of the contract in
// docs/onboarding-deeplink.md, which the ops CLI (MOMO-584) and the mac client
// (MomoDeepLinkParser, MOMO-585) already implement byte for byte:
//
//     momo://join?server=<percent-encoded base URL>&code=<invite code>
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
//            `?join=<percent-encoded momo:// link>` when a whole link was
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

const SCHEME = "momo";
const JOIN_ACTION = "join";

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
 * Parse a `momo://join` link. Returns null when the URL is not a join link or
 * carries nothing usable, so a stray link is ignored rather than half-applied.
 *
 * The action is the authority (`momo://join`) or, when the link omits it
 * (`momo:join`), the first path segment. Same rule as the mac parser.
 */
export function parseJoinDeepLink(raw: string): JoinPrefill | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== `${SCHEME}:`) return null;
  const action =
    url.hostname !== ""
      ? url.hostname.toLowerCase()
      : (url.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();
  if (action !== JOIN_ACTION) return null;
  return prefillFrom(url.searchParams);
}

/**
 * Browser fallback: the same two parameters off the page URL. Reads the real
 * query first, then the hash query the HashRouter leaves behind, and unwraps a
 * whole `momo://join` link passed as `?join=`.
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
