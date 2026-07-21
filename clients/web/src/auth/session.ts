import type { components } from "../api/schema";

type Member = components["schemas"]["Member"];
type LoginResponse = components["schemas"]["LoginResponse"];

// =============================================================================
// Session store — ADR-0119 D3-A (internal-alpha browser token policy).
//
//   - access token:  MEMORY ONLY. Never persisted anywhere.
//   - refresh token: localStorage, single-use rotation (POST /v1/auth/refresh
//     revokes the presented token and returns a fresh pair; MOMO-300).
//   - logout: server-side revocation of both tokens, then local wipe.
//
// The non-secret session metadata (member identity, workspace id, and the
// server-owned realtimeWebSocketUrl from the login response — ADR-0110: the
// ONLY websocket address authority) is persisted next to the refresh token so
// a page reload can resume the session through one refresh rotation.
//
// PUBLIC-DEPLOY GATE: this storage model is gated to the internal alpha.
// Before any public deployment the refresh token must move to an httpOnly
// Secure SameSite=Strict cookie (ADR-0119 D3-B). See clients/web/README.md —
// that document, not this comment, is the canonical statement of the gate.
// =============================================================================

const STORAGE_KEY = "momo.web.session.v1";

export interface SessionData {
  refreshToken: string;
  realtimeWebSocketUrl: string;
  member: Member;
}

let accessToken: string | null = null;
let session: SessionData | null = loadPersisted();
let authExpired = false;
const listeners = new Set<() => void>();

function loadPersisted(): SessionData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionData>;
    if (
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.realtimeWebSocketUrl !== "string" ||
      typeof parsed.member?.id !== "string" ||
      typeof parsed.member?.workspaceId !== "string"
    ) {
      return null;
    }
    return parsed as SessionData;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode etc.): the session simply will not
    // survive a reload. In-memory state keeps working.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot for useSyncExternalStore: null when logged out. */
export function getSession(): SessionData | null {
  return session;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return session?.refreshToken ?? null;
}

export function getAuthExpired(): boolean {
  return authExpired;
}

export function markAuthExpired(): void {
  authExpired = true;
  notify();
}

export function rotateSessionData(
  current: SessionData,
  newRefresh: string
): SessionData {
  return { ...current, refreshToken: newRefresh };
}

/** Full login response -> session (access stays in memory only). */
export function applyLogin(response: LoginResponse): void {
  accessToken = response.accessToken;
  authExpired = false;
  session = {
    refreshToken: response.refreshToken,
    realtimeWebSocketUrl: response.realtimeWebSocketUrl,
    member: response.member,
  };
  persist();
  notify();
}

/** Refresh rotation result -> new pair (metadata unchanged). */
export function applyRotation(newAccess: string, newRefresh: string): void {
  if (!session) return;
  accessToken = newAccess;
  authExpired = false;
  session = rotateSessionData(session, newRefresh);
  persist();
  notify();
}

export function clearSession(): void {
  accessToken = null;
  authExpired = false;
  session = null;
  persist();
  notify();
}
