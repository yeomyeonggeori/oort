import {createMMKV} from 'react-native-mmkv';

// =============================================================================
// The NON-SECRET local store (ADR-0137 D7).
//
// MMKV is here for one property: it reads **synchronously**. The core's host
// port is synchronous by design — `apiBase(): string` is called inline on every
// request in `@momo/core/lib/api.ts` — so an async store (AsyncStorage) cannot
// back it without either an await in the request path or a cache that can be
// stale on the first render. MMKV removes that choice.
//
// ## What must never go in here
//
// **Session tokens.** MMKV's encryption is optional and takes an
// `encryptionKey`, which then has to be kept safely somewhere — the same problem
// one layer down, now with the illusion of having solved it. The refresh token
// lives in the iOS keychain (`./secureSession.ts`); this file holds the answers
// to questions like "which server did this device pick", which are recoverable
// by asking the person again and are not worth a secret store.
//
// The rule is mechanical, not a matter of judgement:
// `__tests__/coreRoundTrip.test.ts` asserts that nothing token-shaped is ever
// written through this module.
// =============================================================================

/**
 * The slice of MMKV's surface this app uses. Named so the boundary is visible
 * at every call site and so a test can substitute a plain object.
 */
export interface NonSecretStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  /** MMKV v4's name. v3 called this `delete`; the rename is not cosmetic here,
   *  because a v3-shaped interface silently fails to match the v4 object. */
  remove(key: string): boolean;
}

/**
 * Keys that may be written here. An allow-list rather than a deny-list: the
 * failure being prevented is someone adding a token under a name no deny-list
 * anticipated, and a deny-list is exactly the shape that loses that race.
 */
export const NON_SECRET_KEYS = {
  /** The API base this device chose. Not a secret; it is printed on screen. */
  serverBase: 'momo.mobile.server.v1',
  /**
   * Member identity + the login-returned websocket address (ADR-0110). Not a
   * secret, but the refresh response does not repeat them, so a restored
   * session has to read them from somewhere that survives a restart.
   */
  sessionMetadata: 'momo.mobile.session.meta.v1',
  /**
   * Has this person used the long press at least once? The timeline's one-line
   * hint retires itself once they have. Not a secret and not worth a round trip
   * — the worst case if it is lost is being told once more.
   */
  longPressLearned: 'momo.mobile.timeline.long-press-learned.v1',
} as const;

export type NonSecretKey = (typeof NON_SECRET_KEYS)[keyof typeof NON_SECRET_KEYS];

let instance: NonSecretStore | null = null;

/**
 * Constructed lazily so that importing this module does not require the native
 * side to exist. Unit tests exercising pure logic then do not have to stand up
 * MMKV, and the failure mode if the native module IS missing is a clear error at
 * first use rather than a crash during module evaluation.
 */
export function nonSecretStore(): NonSecretStore {
  // `createMMKV`, not `new MMKV(...)`: v4 moved to nitro modules and now exports
  // `MMKV` as a TYPE only. The v3 constructor form still appears in most guides
  // and fails at typecheck rather than at runtime, which is the good outcome.
  if (instance === null) {
    instance = createMMKV({id: 'momo.mobile.cache'});
  }
  return instance;
}

/** Test seam: swap the store, or pass null to fall back to the real MMKV. */
export function __setNonSecretStore(store: NonSecretStore | null): void {
  instance = store;
}
