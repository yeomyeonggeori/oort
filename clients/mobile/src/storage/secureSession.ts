import type {LoginResponse} from '@momo/core/lib/api';
import {
  parsePersistedMetadata,
  parsePersistedSession,
  sessionMetadataOf,
  type PersistedSession,
} from '@momo/core/lib/sessionModel';
import type {SessionPort} from '@momo/core/runtime/host';
import {ACCESSIBLE, getGenericPassword, resetGenericPassword, setGenericPassword} from 'react-native-keychain';
import {NON_SECRET_KEYS, nonSecretStore} from './kv';

// =============================================================================
// Session persistence on iOS (ADR-0137 D7). Split by SECRECY, not convenience —
// the same three-way split the web client documents, resolved to this platform:
//
//   access token   MEMORY ONLY. It lives 15 minutes and is re-minted by a
//                  refresh rotation; writing it anywhere durable buys nothing
//                  and adds a place it can leak from.
//   refresh token  the iOS KEYCHAIN, via `react-native-keychain`. Single-use
//                  rotation (MOMO-300): the server revokes the presented token
//                  as it issues the next pair, so the stored copy must be
//                  replaced in step or the next launch signs the person out.
//   metadata       member identity + the login-returned `realtimeWebSocketUrl`
//                  (ADR-0110). Not secret, and the refresh response does not
//                  repeat them, so a resumed session reads them from MMKV.
//
// ## Why not MMKV for the token
//
// Because MMKV's encryption takes an `encryptionKey` that then has to be kept
// safely somewhere — which is the problem we started with, now with a false
// sense of having solved it. The ADR spells this out (D7) and the core's own
// README repeats it. The keychain is the platform's answer and it is already
// what the Swift kit uses.
//
// ## The synchronous/asynchronous seam
//
// `SessionPort` is synchronous: `@momo/core/lib/api.ts` reads the token inline
// on every request. The keychain is asynchronous. The web client hit exactly
// this on desktop and solved it with a one-shot hydrate awaited before first
// render, plus a serialised write queue — that shape is reused here rather than
// reinvented, including the reason for the queue: two rotations overlapping
// could otherwise land out of order and leave the REVOKED token stored, which
// costs a sign-in on the next launch.
//
// ## Left for the NSE batch (ADR-0137 이행 순서 5) — deliberately not done here
//
// The Swift NSE reads the token through a keychain ACCESS GROUP
// (`kSecAttrAccessGroup` = `$(AppIdentifierPrefix)app.momo.ios.shared`,
// `MomoiOSPushKit/PushNotification.swift:73`). Passing `accessGroup` here today
// would need a matching `keychain-access-groups` entitlement, and without one
// `SecItemAdd` fails with errSecMissingEntitlement (-34018) **on device only** —
// the simulator is permissive, so it would pass every check available in this
// batch and break on the first real install. The constant below names the group
// so the NSE batch has one place to change and one test to update; it is not
// passed to the keychain until the entitlement lands with it.
// =============================================================================

/** Keychain service name. Distinct from the Swift kit's so the two can coexist
 *  during the RN transition rather than fighting over one item.
 *
 *  Exported for `gate/harness.tsx` (goal RN-G1), which has to read and clear the
 *  stored item DIRECTLY: every function in this module catches keychain failures
 *  on purpose, so asking it whether the write worked can only ever get an answer
 *  laundered through the same catch that hid the failure. */
export const KEYCHAIN_SERVICE = 'app.momo.ios.rn.session';

/**
 * The access group the Swift NSE reads from. **Not yet applied** — see the note
 * above. Exported so the NSE batch changes one constant and so
 * `__tests__/projectShape.test.ts` can assert it still matches the Swift side.
 */
export const NSE_KEYCHAIN_ACCESS_GROUP = 'app.momo.ios.shared';

/** The keychain stores one credential; the username half is a fixed label. */
const KEYCHAIN_ACCOUNT = 'refreshToken';

/**
 * Two independent choices, both load-bearing:
 *
 *   AFTER_FIRST_UNLOCK rather than WHEN_UNLOCKED — a silent push wakes the NSE
 *   while the phone is locked (ADR-0120: id-only -> fetch -> display) and it
 *   must be able to read this token to make that fetch. WHEN_UNLOCKED would
 *   break the notification path exactly when it matters, on a locked screen.
 *
 *   THIS_DEVICE_ONLY — the refresh token is device-scoped and single-use. Left
 *   syncable it would ride an iCloud keychain backup to a second device, where
 *   the two copies would rotate against each other and revoke one another's
 *   session. It also must not survive into an encrypted device backup.
 */
const KEYCHAIN_ACCESSIBLE = ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

function readMetadata(): ReturnType<typeof parsePersistedMetadata> {
  try {
    return parsePersistedMetadata(
      nonSecretStore().getString(NON_SECRET_KEYS.sessionMetadata) ?? null,
    );
  } catch {
    return null;
  }
}

function writeMetadata(value: PersistedSession | null): void {
  try {
    if (value === null) {
      nonSecretStore().remove(NON_SECRET_KEYS.sessionMetadata);
      return;
    }
    nonSecretStore().set(
      NON_SECRET_KEYS.sessionMetadata,
      JSON.stringify(sessionMetadataOf(value)),
    );
  } catch {
    // Metadata is recoverable by signing in again; a failed write must not take
    // down the sign-in that is currently succeeding.
  }
}

// Keychain writes are async while this module's surface deliberately is not, so
// they are serialised instead of fired in parallel.
let keychainWrites: Promise<unknown> = Promise.resolve();

function queueKeychain(work: () => Promise<unknown>): void {
  keychainWrites = keychainWrites.then(work, work);
}

/** Awaitable in tests, so a written token can be observed rather than raced. */
export function keychainSettled(): Promise<unknown> {
  return keychainWrites;
}

async function storeToken(token: string): Promise<boolean> {
  try {
    const result = await setGenericPassword(KEYCHAIN_ACCOUNT, token, {
      service: KEYCHAIN_SERVICE,
      accessible: KEYCHAIN_ACCESSIBLE,
    });
    return result !== false;
  } catch {
    return false;
  }
}

async function loadToken(): Promise<string | null> {
  try {
    const result = await getGenericPassword({service: KEYCHAIN_SERVICE});
    return result === false ? null : result.password;
  } catch {
    return null;
  }
}

async function clearToken(): Promise<boolean> {
  try {
    return await resetGenericPassword({service: KEYCHAIN_SERVICE});
  } catch {
    return false;
  }
}

let accessToken: string | null = null;
let persisted: PersistedSession | null = null;
let authExpired = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let initPromise: Promise<void> | null = null;

/**
 * Load the refresh token from the keychain and pair it with the stored metadata.
 *
 * MUST be awaited before the first render. `hasPersistedSession()` is read
 * synchronously to decide "restoring" vs "signed out", and that decision is
 * final: rendering before the keychain answers would drop a signed-in person on
 * the connect screen and leave them there.
 */
export function initSessionStore(): Promise<void> {
  initPromise ??= hydrate();
  return initPromise;
}

async function hydrate(): Promise<void> {
  const metadata = readMetadata();
  // Nothing stored: do not touch the keychain at all. There is no session to
  // resume, and on a device a keychain query for an item written by a build with
  // a different signature is a prompt, not an error.
  if (!metadata) {
    return;
  }
  const refreshToken = await loadToken();
  if (refreshToken) {
    persisted = {refreshToken, ...metadata};
    notify();
    return;
  }
  // Half a session is no session: metadata alone cannot resume, and a token
  // alone has no websocket address to dial (ADR-0110). Clear both rather than
  // carry a fragment that can only fail later.
  writeMetadata(null);
  queueKeychain(clearToken);
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

/** True when a relaunch has something to resume from, read before any await. */
export function hasPersistedSession(): boolean {
  return persisted !== null;
}

/** Set when a 401 survived a rotation attempt: the session is over, not slow. */
export function getAuthExpired(): boolean {
  return authExpired;
}

export function markAuthExpired(): void {
  if (authExpired) {
    return;
  }
  authExpired = true;
  notify();
}

export function applyLogin(response: LoginResponse): void {
  accessToken = response.accessToken;
  authExpired = false;
  persisted = {
    refreshToken: response.refreshToken,
    realtimeWebSocketUrl: response.realtimeWebSocketUrl,
    member: response.member,
  };
  writeMetadata(persisted);
  queueKeychain(() => storeToken(response.refreshToken));
  notify();
}

export function applyRotation(newAccess: string, newRefresh: string): void {
  if (!persisted) {
    return;
  }
  accessToken = newAccess;
  authExpired = false;
  persisted = {...persisted, refreshToken: newRefresh};
  writeMetadata(persisted);
  queueKeychain(() => storeToken(newRefresh));
  notify();
}

/**
 * Complete local erasure. The in-memory half is gone the instant this returns;
 * the keychain delete is queued behind any write still in flight, so the
 * ordering holds even when a rotation was mid-air when logout was tapped.
 */
export function clearSession(): void {
  accessToken = null;
  persisted = null;
  authExpired = false;
  writeMetadata(null);
  queueKeychain(clearToken);
  notify();
}

/** The core's port, assembled from the functions above. */
export const sessionPort: SessionPort = {
  getAccessToken,
  getRefreshToken,
  getPersistedSession,
  applyLogin,
  applyRotation,
  markAuthExpired,
  clearSession,
};

/** Test seam: forget everything in memory, including the hydrate latch. */
export function __resetSessionStore(): void {
  accessToken = null;
  persisted = null;
  authExpired = false;
  initPromise = null;
  keychainWrites = Promise.resolve();
  listeners.clear();
}

/** Test seam: adopt a stored blob the way a hydrate would have. */
export function __adoptPersisted(raw: string | null): void {
  persisted = parsePersistedSession(raw);
}
