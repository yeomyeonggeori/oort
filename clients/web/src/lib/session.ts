import type { LoginResponse, Member } from "./api";

// =============================================================================
// Session persistence (M9). Split by secrecy, not by convenience:
//
//   access token   MEMORY ONLY. Never written where a script can read it back
//                  after a reload; it lives 15 minutes and is re-minted by a
//                  refresh rotation instead.
//   refresh token  localStorage, single-use rotation (POST /v1/auth/refresh
//                  revokes the presented token and returns a fresh pair,
//                  AuthRoutes.swift / MOMO-300). This is the one thing that
//                  makes a reload or a webview restart resume.
//   metadata       member identity plus the server-owned realtimeWebSocketUrl
//                  (ADR-0110: the ONLY websocket address authority). Not
//                  secret, but the refresh response does not repeat them, so a
//                  restored session has to read them from here.
//
// Ported from clients/web-legacy/src/auth/session.ts, which is the working
// reference implementation of the same rotation (ADR-0119 D3-A).
//
// XSS: localStorage is readable by any script that reaches this origin, so a
// successful injection steals the refresh token and can keep rotating it for
// 30 days. Two things bound that today and neither is a fix:
//   - CSP (style-src 'self', no external origins, no CDN) is the actual
//     mitigation, which is why the design pre-flight treats an inline style or
//     a remote asset as a hard failure rather than a style preference;
//   - single-use rotation makes theft detectable, because the legitimate
//     client's next rotation fails once the thief has spent the token.
// The real fix is an httpOnly Secure SameSite=Strict cookie. That needs a
// server change, and this ticket ships against an unchanged server, so it is
// stated here rather than pretended away.
//
// P2, DEFERRED (ADR-0133 §2): inside the Tauri shell the refresh token belongs
// in the OS keychain through the Rust plugin layer, not in localStorage. It is
// a desktop-only capability, it requires the Rust side that this build does
// not have yet, and native integrations are explicitly the plugin layer's job
// rather than the React tree's. Until that lands both runtimes share the web
// storage path above.
// =============================================================================

const STORAGE_KEY = "momo.web.session.v1";

/** Everything that survives a reload. The access token deliberately does not. */
export interface PersistedSession {
  refreshToken: string;
  realtimeWebSocketUrl: string;
  member: Member;
}

/**
 * Validate a stored blob before trusting it. A half-written or older-shaped
 * record is treated as "no session" instead of crashing the boot: the worst
 * case is one extra login, and there is no state worth salvaging.
 */
export function parsePersistedSession(raw: string | null): PersistedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      typeof parsed.refreshToken !== "string" ||
      parsed.refreshToken === "" ||
      typeof parsed.realtimeWebSocketUrl !== "string" ||
      typeof parsed.member?.id !== "string" ||
      typeof parsed.member?.workspaceId !== "string"
    ) {
      return null;
    }
    return parsed as PersistedSession;
  } catch {
    return null;
  }
}

/**
 * Rebuild the login-shaped value the app tree runs on from what survived the
 * reload plus a freshly rotated access token. The websocket address comes from
 * the stored login response, never from the page origin (ADR-0110).
 */
export function restoredLoginResponse(
  persisted: PersistedSession,
  accessToken: string
): LoginResponse {
  return {
    accessToken,
    refreshToken: persisted.refreshToken,
    member: persisted.member,
    realtimeWebSocketUrl: persisted.realtimeWebSocketUrl,
  };
}

function readStorage(): PersistedSession | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return parsePersistedSession(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStorage(value: PersistedSession | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota, embedded webview policy): the
    // session simply will not survive a reload. In-memory state keeps working.
  }
}

let accessToken: string | null = null;
let persisted: PersistedSession | null = readStorage();
let authExpired = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return persisted?.refreshToken ?? null;
}

export function getPersistedSession(): PersistedSession | null {
  return persisted;
}

/** True when a reload has something to resume from, checked before any await. */
export function hasPersistedSession(): boolean {
  return persisted !== null;
}

/** Set when a 401 survived a rotation attempt: the session is over, not slow. */
export function getAuthExpired(): boolean {
  return authExpired;
}

export function markAuthExpired(): void {
  if (authExpired) return;
  authExpired = true;
  notify();
}

/** Full login response to session state (the access token stays in memory). */
export function applyLogin(response: LoginResponse): void {
  accessToken = response.accessToken;
  authExpired = false;
  persisted = {
    refreshToken: response.refreshToken,
    realtimeWebSocketUrl: response.realtimeWebSocketUrl,
    member: response.member,
  };
  writeStorage(persisted);
  notify();
}

/** Rotation result to a new pair; identity and websocket address are unchanged. */
export function applyRotation(newAccess: string, newRefresh: string): void {
  if (!persisted) return;
  accessToken = newAccess;
  authExpired = false;
  persisted = { ...persisted, refreshToken: newRefresh };
  writeStorage(persisted);
  notify();
}

/**
 * Complete local erasure: the in-memory access token, the stored refresh token
 * and every byte of stored metadata. Called unconditionally on logout, before
 * the network revocation is even attempted, so a failed or slow revoke can
 * never leave a usable token behind on this device.
 */
export function clearSession(): void {
  accessToken = null;
  persisted = null;
  authExpired = false;
  writeStorage(null);
  notify();
}
