// =============================================================================
// First-owner claim lives outside HashRouter (ADR-0166 / T-1).
//
// Same reason as OAuth consent (oauthConsentPath.ts): the operator sends
// `https://<host>/claim/<token>`, a real path, not a hash route. HashRouter
// only sees the hash, so App branches on `window.location.pathname` first.
//
// The token is read once from the path and is not copied into history,
// telemetry, or logs.
// =============================================================================

export const CLAIM_PATH_PREFIX = "/claim/";

/** Sealed shape: 32 bytes, base64url without padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isClaimPath(pathname: string): boolean {
  return pathname === "/claim" || pathname === "/claim/" || pathname.startsWith(CLAIM_PATH_PREFIX);
}

export function readClaimToken(pathname: string): string | null {
  if (!pathname.startsWith(CLAIM_PATH_PREFIX)) return null;
  let rest = pathname.slice(CLAIM_PATH_PREFIX.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest.includes("/") || !TOKEN_SHAPE.test(rest)) return null;
  return rest;
}
