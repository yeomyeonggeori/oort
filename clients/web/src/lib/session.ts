import type { LoginResponse, Member } from "./api";
import { desktopKeychain, isDesktop } from "./tauri";

// =============================================================================
// Session persistence (M9). Split by secrecy, not by convenience:
//
//   access token   MEMORY ONLY. Never written where a script can read it back
//                  after a reload; it lives 15 minutes and is re-minted by a
//                  refresh rotation instead.
//   refresh token  the OS keychain in the desktop shell, localStorage in a
//                  browser (see "Where the refresh token lives" below).
//                  Single-use rotation (POST /v1/auth/refresh revokes the
//                  presented token and returns a fresh pair, AuthRoutes.swift /
//                  MOMO-300). This is the one thing that makes a reload or a
//                  webview restart resume.
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
// -----------------------------------------------------------------------------
// Where the refresh token lives (ADR-0133 P2, MOMO-603)
//
// Detected at RUNTIME, not at build time, because one bundle serves both:
//
//   desktop + keychain   token in the OS credential store, metadata in
//                        `momo.desktop.session.v1`. An injected script can no
//                        longer read the token back — it can still ASK the shell
//                        to use it, which is a real and smaller residual risk.
//   browser, or a shell  the pre-existing `momo.web.session.v1` record, token
//   whose keychain       included. Unchanged, and honest: a Linux box with no
//   will not answer      Secret Service still signs in, it just does not gain a
//                        guarantee it cannot provide. `getSessionStorageMode()`
//                        reports which of the two is in force.
//
// The keychain is async and the rest of this module is deliberately synchronous
// (every caller in ./api.ts reads the token inline), so hydration is a one-shot
// `initSessionStore()` that boot awaits BEFORE the first render — see main.tsx.
// =============================================================================

const STORAGE_KEY = "momo.web.session.v1";
/** Desktop metadata record. Separate key, because it never holds the token. */
const DESKTOP_METADATA_KEY = "momo.desktop.session.v1";

/** Everything that survives a reload. The access token deliberately does not. */
export interface PersistedSession {
  refreshToken: string;
  realtimeWebSocketUrl: string;
  member: Member;
}

/** The non-secret half of a persisted session: everything but the token. */
export type PersistedMetadata = Omit<PersistedSession, "refreshToken">;

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

function metadataOf({ realtimeWebSocketUrl, member }: PersistedSession): PersistedMetadata {
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

function readRaw(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota, embedded webview policy): the
    // session simply will not survive a reload. In-memory state keeps working.
  }
}

/** Which of the two storage paths is in force. See the header. */
export type SessionStorageMode = "web" | "keychain";

let storageMode: SessionStorageMode = "web";

/**
 * Where the refresh token is being kept, after `initSessionStore()` has settled.
 * Exposed so the shell can be honest about a degraded run rather than implying a
 * guarantee it is not delivering.
 */
export function getSessionStorageMode(): SessionStorageMode {
  return storageMode;
}

// Keychain writes are async while this module's surface is deliberately not, so
// they are serialised instead of fired in parallel: two rotations overlapping
// could otherwise land out of order and leave the REVOKED token stored, which
// costs a sign-in on next launch.
let keychainWrites: Promise<unknown> = Promise.resolve();

function queueKeychain(work: () => Promise<unknown>): void {
  keychainWrites = keychainWrites.then(work, work);
}

function readStorage(): PersistedSession | null {
  return parsePersistedSession(readRaw(STORAGE_KEY));
}

function writeStorage(value: PersistedSession | null): void {
  if (storageMode === "keychain") {
    writeRaw(DESKTOP_METADATA_KEY, value ? JSON.stringify(metadataOf(value)) : null);
    queueKeychain(() =>
      value ? desktopKeychain.store(value.refreshToken) : desktopKeychain.clear()
    );
    return;
  }
  writeRaw(STORAGE_KEY, value ? JSON.stringify(value) : null);
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

let initPromise: Promise<void> | null = null;

/**
 * Settle where the refresh token lives, and load it if it lives somewhere async.
 *
 * MUST be awaited before the first render (see `main.tsx`). `hasPersistedSession()`
 * is read synchronously on the first render to decide "restoring" vs "anonymous",
 * and that decision is final — rendering before the keychain answers would drop a
 * signed-in person on the login screen and leave them there.
 *
 * Idempotent, and a no-op in the browser: web storage was already read
 * synchronously at import, so this resolves on the first microtask.
 */
export function initSessionStore(): Promise<void> {
  initPromise ??= hydrate();
  return initPromise;
}

async function hydrate(): Promise<void> {
  if (!isDesktop()) return;
  if (!(await desktopKeychain.available())) return; // degraded: stay on web storage

  // A record left by a browser-mode run of this same bundle: an earlier build, or
  // a run where the keychain was unavailable. Move it, and only then drop the
  // web copy — losing the token here would sign someone out for no reason, and
  // leaving it behind would defeat the point of moving it at all.
  const legacy = persisted;
  if (legacy) {
    if (!(await desktopKeychain.store(legacy.refreshToken))) return;
    storageMode = "keychain";
    writeRaw(DESKTOP_METADATA_KEY, JSON.stringify(metadataOf(legacy)));
    writeRaw(STORAGE_KEY, null);
    return;
  }

  storageMode = "keychain";
  const metadata = parsePersistedMetadata(readRaw(DESKTOP_METADATA_KEY));
  const refreshToken = await desktopKeychain.load();
  if (metadata && refreshToken) {
    persisted = { refreshToken, ...metadata };
    notify();
    return;
  }
  // Half a session is no session: metadata alone cannot resume, and a token
  // alone has no websocket address to dial (ADR-0110). Clear both rather than
  // carry a fragment that can only fail later.
  if (metadata || refreshToken) {
    writeRaw(DESKTOP_METADATA_KEY, null);
    queueKeychain(() => desktopKeychain.clear());
  }
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
 *
 * In keychain mode the in-memory half is gone the instant this returns; the
 * credential-store delete is queued behind any write still in flight, so the
 * ordering holds even when a rotation was mid-air when logout was clicked.
 */
export function clearSession(): void {
  accessToken = null;
  persisted = null;
  authExpired = false;
  writeStorage(null);
  notify();
}
