import type {LoginResponse} from '@momo/core/lib/api';
import {
  parsePersistedMetadata,
  parsePersistedSession,
  sessionMetadataOf,
  type PersistedSession,
} from '@momo/core/lib/sessionModel';
import type {SessionPort} from '@momo/core/runtime/host';
import {ACCESSIBLE, getGenericPassword, resetGenericPassword, setGenericPassword} from 'react-native-keychain';
import {refreshKeySupported, signRefreshProof} from '../deviceKey/refreshKey';
import {keychainAccessGroup} from '../push/native';
import {withBackgroundTask} from '../lib/backgroundTask';
import {appOnlyGroupFrom} from './keychainGroups';
import {NON_SECRET_KEYS, nonSecretStore} from './kv';

// Kept exported from here: `gate/harness` and tests import it from this module.
export {NSE_KEYCHAIN_ACCESS_GROUP} from './keychainGroups';

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
// ## The NSE seam — settled by 이행 순서 5 (RN-N1), narrowed by #3121
//
// The notification extension reads ONE keychain item, through the shared access
// group (`src/push/pushFetchSession.ts`, `ios/MomoPushKit/PushNotification.swift`).
// Since #3121 that item is NOT this session: it is a `push_fetch` token minted
// by `POST /v1/auth/push-fetch-token` — two read routes, no refresh half
// (ADR-0188 §8.7). The access token stays in memory, and the REFRESH token below
// is written to the APP-ONLY group (`app.momo.ios.devicekey`, declared by the
// app's entitlements and not the extension's), so the extension has no credential
// that can be spent for a new session.
//
// Why the group is named on every call: with a `keychain-access-groups`
// entitlement present, an item written WITHOUT an explicit group lands in the
// first group listed, and the first group listed is the shared one (its order is
// pinned so that pre-#3121 items did not move). Leaving the group implicit would
// put the refresh token exactly where this change is taking it out of.
//
// Installs from before #3121 hold the refresh token in the shared group. The
// first launch after the upgrade copies it to the app-only group and only then
// deletes the shared copy (`migrateFromShared`); if any step fails the session
// simply keeps working from where it is and the next launch tries again. A
// failed move never signs anyone out.
// =============================================================================

/** Keychain service name. Distinct from the Swift kit's so the two can coexist
 *  during the RN transition rather than fighting over one item.
 *
 *  Exported for `gate/harness.tsx` (goal RN-G1), which has to read and clear the
 *  stored item DIRECTLY: every function in this module catches keychain failures
 *  on purpose, so asking it whether the write worked can only ever get an answer
 *  laundered through the same catch that hid the failure. */
export const KEYCHAIN_SERVICE = 'app.momo.ios.rn.session';

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

/** The two team-prefixed groups, or null where the native side cannot name them
 *  (a simulator without the plist key, Jest). Null means "no group", as before. */
function resolveGroups(): {shared: string; appOnly: string} | null {
  const shared = keychainAccessGroup();
  const appOnly = appOnlyGroupFrom(shared);
  return shared && appOnly ? {shared, appOnly} : null;
}

async function storeToken(token: string): Promise<boolean> {
  try {
    const groups = resolveGroups();
    const result = await setGenericPassword(KEYCHAIN_ACCOUNT, token, {
      service: KEYCHAIN_SERVICE,
      accessible: KEYCHAIN_ACCESSIBLE,
      ...(groups ? {accessGroup: groups.appOnly} : {}),
    });
    return result !== false;
  } catch {
    return false;
  }
}

async function readFrom(accessGroup?: string): Promise<string | null> {
  try {
    const result = await getGenericPassword({
      service: KEYCHAIN_SERVICE,
      ...(accessGroup ? {accessGroup} : {}),
    });
    return result === false ? null : result.password;
  } catch {
    return null;
  }
}

/** Where a loaded token was found. `shared` is the pre-#3121 location. */
type Loaded = {token: string; source: 'app-only' | 'shared' | 'default'};

async function loadToken(): Promise<Loaded | null> {
  const groups = resolveGroups();
  if (!groups) {
    const token = await readFrom();
    return token ? {token, source: 'default'} : null;
  }
  const appOnly = await readFrom(groups.appOnly);
  if (appOnly) {
    return {token: appOnly, source: 'app-only'};
  }
  const shared = await readFrom(groups.shared);
  if (shared) {
    return {token: shared, source: 'shared'};
  }
  // An item from a build older than the shared group sits in the app's own
  // default group, which the extension cannot read: usable, nothing to move.
  const legacy = await readFrom();
  return legacy ? {token: legacy, source: 'default'} : null;
}

/**
 * Move a refresh token found in the shared group to the app-only group.
 *
 * Order is the whole point: write the new copy, READ IT BACK, and only then
 * delete the shared one — and that delete names the shared group explicitly,
 * because a delete with no group would sweep both. Any failure returns with the
 * shared copy intact; the caller has already adopted the token, so nobody is
 * signed out, and the next launch retries.
 */
async function migrateFromShared(token: string): Promise<void> {
  const groups = resolveGroups();
  if (!groups) {
    return;
  }
  try {
    if (!(await storeToken(token))) {
      return;
    }
    if ((await readFrom(groups.appOnly)) !== token) {
      return;
    }
    await sweepShared();
  } catch {
    // Retried at the next launch.
  }
}

/** Delete a leftover shared-group copy. Names the shared group explicitly, so
 *  it can never touch the app-only copy. */
async function sweepShared(): Promise<void> {
  const groups = resolveGroups();
  if (!groups) {
    return;
  }
  try {
    await resetGenericPassword({
      service: KEYCHAIN_SERVICE,
      accessGroup: groups.shared,
    });
  } catch {
    // Retried at the next launch.
  }
}

/** Delete every copy, in whichever group it sits: with no group named the
 *  delete matches across all the groups this app can see, which is what a
 *  sign-out wants (and what a migration must never do). */
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
  const loaded = await loadToken();
  if (loaded) {
    persisted = {refreshToken: loaded.token, ...metadata};
    notify();
    if (loaded.source === 'shared') {
      queueKeychain(() => migrateFromShared(loaded.token));
    } else if (loaded.source === 'app-only') {
      // A previous launch may have written the new copy and died before the
      // delete. The app-only copy is the truth; drop any shared leftover.
      queueKeychain(sweepShared);
    }
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

/**
 * How long a rotation waits for its keychain write before letting go of the
 * background task anyway. Same bound and same reason as the web client's
 * KEYCHAIN_WAIT_MS: the core's single flight is held until this returns, so a
 * write that never answers must not stall every later 401 with it.
 */
export const ROTATION_KEYCHAIN_WAIT_MS = 5_000;

const noop = (): void => {};

function keychainSettledWithin(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>(settle => {
    timer = setTimeout(settle, ms);
  });
  return Promise.race([keychainWrites.then(noop, noop), late]).finally(
    () => clearTimeout(timer),
  );
}

/** The background task's name, as it shows in iOS diagnostics. */
export const ROTATION_TASK_NAME = 'oort.refresh-rotation';

/**
 * SessionPort.exclusiveRotation for the phone (#3098). This process has one JS
 * context, so there is no cross-context lock to take; what the phone needs is
 * TIME. The whole rotation — the refresh POST, its response, and the keychain
 * write of the new token — runs inside one iOS background task, begun before
 * the POST leaves and ended only once the write has landed. Without it, going
 * to the background mid-rotation froze the app about five seconds later with
 * the old token already revoked by the server and the new one never stored.
 */
export function exclusiveRotation<T>(work: () => Promise<T>): Promise<T> {
  return withBackgroundTask(ROTATION_TASK_NAME, async () => {
    try {
      return await work();
    } finally {
      // `applyRotation` only queued the write; the task has to outlive it.
      await keychainSettledWithin(ROTATION_KEYCHAIN_WAIT_MS);
    }
  });
}

/** The core's port, assembled from the functions above. `signRefreshProof`
 *  (#3106): every refresh carries the refresh key's proof, and a host that has
 *  one also gets the bind refresh right after each sign-in (core `adoptSignIn`).
 *  Inside `exclusiveRotation`, so a proof's retries share the background task.
 *  Only where an enclave exists: a simulator (and the gate builds on one) has
 *  no key, so it gets neither a proof nor an extra bind refresh. */
export const sessionPort: SessionPort = {
  getAccessToken,
  getRefreshToken,
  getPersistedSession,
  applyLogin,
  applyRotation,
  markAuthExpired,
  clearSession,
  exclusiveRotation,
  ...(refreshKeySupported() ? {signRefreshProof: signRefreshProof} : {}),
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
