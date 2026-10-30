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
  /** Local emoji usage counts and global tone, shared reaction/status picker (#4322). */
  emojiFrequency: 'momo.mobile.emoji.frequency.v1',
  emojiSkinTone: 'momo.mobile.emoji.skin.v1',
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
   * 「이 폰으로는 푸시를 받지 않는다」고 **사람이 스위치로 껐다** (#3924, ADR-0204 D1).
   * 값은 껐던 사람의 멤버 id 하나다 — 없으면 끈 적이 없다. `PushProvider` 가 이 값이 지금
   * 로그인한 멤버와 같으면 다음 실행에도 이 기기를 서버에 다시 등록하지 않는다.
   *
   * 멤버 id 인 이유: 로그아웃 없이 세션이 끝난 뒤(토큰 만료) 다른 사람이 이 폰에 들어오면
   * 앞 사람의 「껐다」가 그 사람의 알림을 막으면 안 된다. 명시적 로그아웃은 이 값을
   * 지운다(`session/useSession.tsx`).
   *
   * 비밀이 아니다(멤버 id 는 `sessionMetadata` 에도 평문으로 있다). 잃으면 이 폰이 다음
   * 실행에 다시 등록될 뿐이고, 사람이 스위치를 한 번 더 끄면 된다. MMKV 는 앱을 지우면
   * 함께 지워진다 — 재설치한 폰이 새로 시작해야 하는 것과 같은 수명이다.
   */
  pushOptOut: 'momo.mobile.push.opt-out.v1',
  /**
   * 「메시지 미리보기」 (#4316, ADR-0204 증보 5, 설정 › 알림). 값 `'0'` 이 **끔**이고, 키가 없으면 켬이다 —
   * 한 번도 건드리지 않은 폰이 켠 채로 오게 하려고 「끈 것」만 적는다. 이 폰의 선택이라 로그아웃에도 남는다
   * (테마와 같은 종류: 사람 데이터가 아니라 기기 취향). 확장은 MMKV 를 읽지 못해서, 바꿀 때마다
   * `src/push/presentation.ts` 가 App Group 으로도 쓴다. 비밀이 아니다.
   */
  pushPreview: 'momo.mobile.push.preview.v1',
  /** 「보낸 사람 표시」 (#4316). 위와 같은 규칙(`'0'` = 끔, 없으면 켬). 끄면 건넨 캐시도 지운다. */
  pushShowSender: 'momo.mobile.push.show-sender.v1',
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
   * 라이트/다크/시스템 중 사람이 고른 것 (U2, 옛 키 — 읽기 전용). 값은 `ThemeChoice` 세
   * 낱말 중 하나다. **키가 없다는 것과 「시스템」을 골랐다는 것은 다르다**: 이 키와 새 키
   * (`appearance`)가 모두 없을 때만 폰의 기본(라이트)이고, 하나라도 있으면 거기 적힌 선택이
   * 그대로다(`design/theme.tsx` `readStoredAppearance`, #4526).
   *
   * 여기여야 하는 이유는 **첫 페인트**다. 이 값이 비동기로 오면 앱은 매 실행
   * 기본으로 한 프레임 그렸다가 고른 색으로 뒤집힌다. 잃어도 되는 값이지만(다시
   * 고르면 된다) 늦게 오면 안 되는 값이라, 서버도 키체인도 아닌 여기에 산다.
   */
  themeChoice: 'momo.mobile.theme.v1',
  /**
   * 외양 레코드 — 스킴·테마·신호색(ADR-0189 D3 · #2719). core `AppearanceV2` 의 JSON.
   * 옛 `themeChoice` 는 읽기만 하고(스킴만 이어받는다) 새 키로 옮겨 쓴다. 사람이 고른
   * 취향이고 서버가 본 적 없다. 잃으면 기본 모양(폰은 라이트)으로 돌아갈 뿐이다.
   * 이 레코드가 **있다는 것**이 「한 번이라도 고른 폰」이라는 표시다 — 스킴은 언제나 함께 적힌다.
   */
  appearance: 'momo.mobile.appearance.v1',
  /**
   * 커스텀 배경의 선택 (ADR-0189 증보 2, #3907) — 없음·단색·기본 제공 id, 또는 내 사진의
   * **파일 이름**(경로 아님). 사진 본체는 앱 샌드박스 파일이고 여기에는 이름만 있다.
   * 로그아웃 때 사진 선택은 지워진다(`design/background/store.ts`).
   */
  background: 'momo.mobile.background.v1',
  /**
   * 홈에서 접어 둔 섹션 (DS2-3 #2715). 워크스페이스 id → 접힌 섹션 키 목록의 JSON.
   * 화면 배치에 대한 사람의 선택일 뿐이고, 잃으면 섹션이 다시 펼쳐져 있을 뿐이다.
   */
  homeCollapsedSections: 'momo.mobile.home.collapsed.v1',
  /**
   * 마지막 읽음 투영에서 「닫힘」이던 DM 의 id (#4367). 워크스페이스 id → DM id 목록의 JSON. **원장이 아니다**: 판정은
   * 언제나 서버 투영이고, 이 값은 다음 투영이 오기 전 첫 프레임에 닫은 DM 이 잠깐 보이지 않게 하는 캐시일 뿐이다(웹 D8 캐시와 같은
   * 원칙). 투영이 올 때마다 통째로 덮어쓰고, 잃으면 첫 프레임에 한 번 보였다 사라질 뿐이다.
   */
  dmClosedCache: 'momo.mobile.sidebar.dm-closed-cache.v1',
  /**
   * 「작업 맡기기」 시트가 마지막에 쓴 에이전트·채널 (#3588). 워크스페이스 id → {에이전트 id,
   * 채널 id}의 JSON — **id 둘뿐**이다. 제목·설명 같은 글은 여기에 쓰지 않는다(그 글은 같은
   * 앱 실행 안의 메모리에서만 산다). 잃으면 처음처럼 아무것도 미리 고르지 않을 뿐이다.
   */
  delegateLastTarget: 'momo.mobile.delegate.last-target.v1',
  /**
   * 「내 맥에 보내기」 시트(#3597 T6b)가 마지막에 쓴 선택: 워크스페이스 id → {하네스 키,
   * 폴더 id, 폴더별 채널 id}. 전부 **선택(id)** 이고 글이 아니다. 잃으면 처음처럼 미리 고른 것이
   * 없을 뿐이다(ADR-0198 N5 3·집 채널 규칙: 서버는 대응을 저장하지 않고 기기에만 기억한다).
   */
  askMacLast: 'momo.mobile.ask-mac.last.v1',
  /**
   * 「작업」 화면에서 마지막으로 고른 필터(ADR-0202 D2): `mine` 또는 `team` 한 낱말. 기기별
   * 편의일 뿐이고, 잃으면 기본값 「내 것」으로 열린다.
   */
  workFilter: 'momo.mobile.work.filter.v1',
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
