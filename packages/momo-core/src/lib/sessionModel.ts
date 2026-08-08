import type { LoginResponse, Member } from "./api";

// =============================================================================
// The shape of a persisted session, and the guards that decide whether a stored
// blob may be trusted — the pure half of the web client's session.ts
// (ADR-0137 D3, goal RN-C1).
//
// What did NOT move: where the refresh token is kept. That is localStorage in a
// browser, the OS keychain in the desktop shell, and `react-native-keychain` on
// RN (ADR-0137 D7: MMKV is not a secret store). The host owns it and exposes it
// to the core through `SessionPort` in `runtime/host.ts`.
//
// What moved is the part that is the same everywhere: a half-written or
// older-shaped record is "no session" rather than a crash on boot, and a
// token-less desktop metadata record must never be mistaken for a full session.
// =============================================================================

/** Everything that survives a reload. The access token deliberately does not. */
export interface PersistedSession {
  refreshToken: string;
  realtimeWebSocketUrl: string;
  member: Member;
}

/** The non-secret half of a persisted session: everything but the token. */
export type PersistedMetadata = Omit<PersistedSession, "refreshToken">;

/** Which of the two storage paths is in force. */
export type SessionStorageMode = "web" | "keychain";

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
 * The same guard for the desktop metadata record. Its ABSENT refresh token is
 * the point, so it gets its own validator rather than a loosened version of the
 * one above — a token-less blob must never be mistaken for a full session.
 */
export function parsePersistedMetadata(raw: string | null): PersistedMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      typeof parsed.realtimeWebSocketUrl !== "string" ||
      typeof parsed.member?.id !== "string" ||
      typeof parsed.member?.workspaceId !== "string"
    ) {
      return null;
    }
    return { realtimeWebSocketUrl: parsed.realtimeWebSocketUrl, member: parsed.member };
  } catch {
    return null;
  }
}

/** The non-secret half of a session, for a store that must not hold the token. */
export function sessionMetadataOf({
  realtimeWebSocketUrl,
  member,
}: PersistedSession): PersistedMetadata {
  return { realtimeWebSocketUrl, member };
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
