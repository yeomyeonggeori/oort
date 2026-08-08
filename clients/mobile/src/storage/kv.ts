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
  /**
   * This install's device id for push registration (goal RN-N1). A random UUID
   * minted once and kept; the server treats it as the identity of the
   * registration, so a fresh one per launch would pile up dead device rows and
   * multiply every push.
   *
   * Not a secret, and deliberately NOT in the keychain: keychain items survive
   * app deletion on iOS, so a reinstall would silently reclaim the previous
   * install's device row and whatever APNs token it still carried. MMKV is wiped
   * with the app, which is the lifetime this identifier should have.
   */
  pushDeviceId: 'momo.mobile.push.device-id.v1',
  /**
   * 아직 보내지 않은 글 (goal U4-6M · 감사 H-10). 채널·스레드별 한 덩이의 JSON
   * 지도이고, 접기·수명 규칙은 `features/conversation/drafts.ts` 가 진다.
   *
   * 여기 있어도 되는 이유는 하나다 — 이것은 **이미 화면에 떠 있던 글자**다.
   * 사람이 자기 손으로 친 것을 자기 기기에 그대로 두는 것이고, 보내지기 전에는
   * 서버가 본 적도 없다. 토큰과는 다른 종류의 값이다. 다만 「잃어도 되는 것」도
   * 아니라서, 잃으면 사람이 쓴 글이 없어진다 — 그것이 이 키가 생긴 이유다.
   */
  composerDrafts: 'momo.mobile.composer.drafts.v1',
  /**
   * 라이트/다크/시스템 중 사람이 고른 것 (U2). 값은 `ThemeChoice` 세 낱말 중
   * 하나이고, 없으면 `system` 이다 — 저장이 없다는 것과 「시스템을 따르라」는
   * 것은 같은 뜻이라 폴백에 정보가 없다(`design/theme.tsx`).
   *
   * 여기여야 하는 이유는 **첫 페인트**다. 이 값이 비동기로 오면 앱은 매 실행
   * 다크로 한 프레임 그렸다가 라이트로 뒤집힌다. 잃어도 되는 값이지만(다시
   * 고르면 된다) 늦게 오면 안 되는 값이라, 서버도 키체인도 아닌 여기에 산다.
   */
  themeChoice: 'momo.mobile.theme.v1',
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
