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
  /** Scoped device expression usage; metadata only, never media or credentials (#4678). */
  expressionUsage: 'momo.mobile.expressions.usage.v1',
  /**
   * 대화 행 미디어의 **잰 크기** (#5451): 첨부 id → [그림 가로, 세로](`attachmentSizes`), 메시지 id → [링크 카드 묶음 높이](`unfurlHeights`).
   * 숫자뿐이다 — 키는 서버가 만든 uuid 이고 글·주소·바이트가 없다. 앱을 다시 켠 뒤에도 사진이 제 비율로 첫 프레임부터 서고(16:9 자리표시로 섰다가
   * 바뀌지 않고), 링크 카드가 늦게 와도 그 자리를 미리 비워 두려는 것이다. 잃으면 한 번 더 재면 된다. 계정 정보 없음(`storage/measureMemory.ts`).
   */
  attachmentSizes: 'momo.mobile.timeline.attachment-sizes.v1',
  /**
   * 팀 표현 보관함의 **마지막으로 읽은 목록**(그리는 데 필요한 것만: id·이름·표시 이름·상태·종류·그림 정보 — 그림 파일은 없다, #5451). 대화가 열릴 때 보관함이 아직
   * 안 와도 큰 이모티콘의 칸이 첫 프레임부터 서게 한다. 프롬프트·출처 주소·만든 사람·대상 멤버·태그는 남기지 않는다(#5473 · 형식 번호 2, 옛 형식은 읽을 때 지운다).
   * 읽을 때 워크스페이스·멤버와 계약 검사를 지난 것만 받고, 로그아웃(`useSession.tsx`)·세션 끝(`store.ts` `dispose`)이 지운다(`forgetExpressionShelf`).
   * 잃으면 한 번 늦게 서고 다음 읽기가 채운다.
   */
  expressionShelf: 'momo.mobile.expressions.shelf.v1',
  unfurlHeights: 'momo.mobile.timeline.unfurl-heights.v1',
  /**
   * 마지막으로 본 소프트 키보드 높이(pt, 숫자 하나 — #5452). 이모티콘 창이 키보드가 있던 **그 자리 그 높이**로 서려는 값이라, 키보드를 아직 한 번도 못 본 채(앱을 막 켠 뒤)
   * 창을 열어도 지난번 높이로 선다. 비밀이 아니고 잃으면 창 높이를 화면 비율로 어림잡을 뿐이다.
   */
  keyboardHeight: 'momo.mobile.keyboard.height.v1',
  /**
   * 팀 표현의 즐겨찾기(이 기기 · 이 워크스페이스 · 이 사람 — 서버 계약 없음, #5452). 값의 모양과 바꾸는 법은 코어 `features/expressions/favorites.ts`가 갖는다:
   * 읽을 때 워크스페이스·멤버가 맞는 값만 받고 깨진 값은 빈 목록이다. 등록의 id 목록뿐이라 비밀이 아니다. 로그아웃이 지우지 않는다(이 기기의 취향이다).
   */
  expressionFavorites: 'momo.mobile.expressions.favorites.v1',
  /**
   * 「이모티콘 추천」 켜기·끄기 (이 기기 · 이 워크스페이스 · 이 사람 - 서버 계약 없음, #5493). 입력창 위의 키워드 추천 줄을 통째로 끄는 사람의 선택이다. 값의 모양과 읽는 법은
   * 코어 `features/expressions/suggestSetting.ts`가 갖는다: `워크스페이스:사람` → 값 지도 한 덩이이고, 읽을 때 워크스페이스·멤버가 맞고 `on` 이 `false` 로 분명히 적힌 값만 끔이다
   * (비었거나 깨졌거나 옛 모양이면 켜짐 - 기본은 켜짐). 비밀이 아니고 로그아웃이 지우지 않는다(이 기기의 취향이다). 잃으면 추천 줄이 다시 켜질 뿐이다.
   */
  expressionSuggest: 'momo.mobile.expressions.suggest.v1',
  /** Local emoji usage counts and global tone, shared reaction/status picker (#4322). */
  emojiFrequency: 'momo.mobile.emoji.frequency.v1',
  emojiSkinTone: 'momo.mobile.emoji.skin.v1',
  /** The API base this device chose. Not a secret; it is printed on screen. */
  serverBase: 'momo.mobile.server.v1',
  /**
   * 「이메일 기억하기」(#4669): 서버 주소별로 로그인 때 쓴 이메일과 사람이 고른 켬·끔(`@momo/core` `rememberedLogin`).
   * 이메일은 화면에 찍히는 값이라 비밀이 아니고, **비밀번호와 토큰은 이 키에 닿지 않는다** — 코어가 이메일 모양만
   * 받는다. 로그아웃이 지우지 않는다(같은 서버에 다시 들어오면 채워지는 것이 이 기능이다). 끄면 코어가 이 키의
   * 이메일을 그 자리에서 비운다.
   */
  rememberedLogin: 'momo.mobile.login.remembered.v1',
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
   * 보내지 못한 글 (#5222, #5201 결정 ⑤). 열쇠 `워크스페이스:채널:멱등키` → 한 건의 JSON(코어 `serializeFailedSend`)인 지도 한 덩이이고,
   * 수명·정원·비밀 키 거부·로그아웃 삭제는 `features/conversation/failedSends.ts` 가 진다. 위 초안과 같은 규칙이다.
   *
   * 여기 있어도 되는 이유도 초안과 같다: **사람이 자기 손으로 쓴 글**이 이 기기에 그대로 있는 것이고, 서버가 받았다는 증명이 없는(응답이
   * 유실됐을 수 있는) 글이다. 행 전체(멱등 키 · 첨부 id · 인용)를 남기는 까닭은 웹과 같다 - 키가 살아야 다시 보내도 서버가 중복을 막는다.
   * 토큰과는 다른 종류의 값이고, 잃으면 사람이 쓴 글이 없어진다.
   */
  failedSends: 'momo.mobile.composer.failed-sends.v1',
  /**
   * **옛 키 — 읽어서 옮기고 지우기만 한다** (#5384). 대화 안 검색이 따로 들던 최근 검색어(#5364)다: 열쇠 `워크스페이스:채널` → 말 목록(최근이 앞)인 지도 한 덩이. 홈 검색과 **한 목록**이 되면서
   * (`searchRecents` 키) 이 키에는 더 쓰지 않는다. `features/search/searchRecents.ts` 가 처음 읽는 열쇠(작업공간:멤버)로 옮기고 이 키를 지운다(다른 워크스페이스의 줄은 그 워크스페이스를 처음 읽을 때까지 남는다).
   * 로그아웃(`clearAllSearchRecents`)이 아직 남은 이 키도 함께 지운다 — 무엇을 찾았는지는 다음 사람에게 보일 일이 아니다. 서버로 가지 않는다.
   */
  conversationSearchRecent: 'momo.mobile.conversation-search.recent.v1',
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
  /**
   * 햅틱 단계(`lib/haptics.ts`): 없으면 풍부. **앱은 이 키에 쓰지 않는다** — 설정의 「햅틱」 선택은 owner 10-31(#4936)에
   * 없앴고 앱 햅틱은 늘 「풍부」다. 이 키는 시험이 기본·끔 경로를 따로 재는 이음새일 뿐이다. 예전 판이 고른 「기본」·「끔」은
   * `momo.mobile.haptics.v1` 에 남아 있을 수 있으나 **읽지 않는다**(키를 v2로 올려서 되살아나지 않게 했다). 계정 정보 없음.
   */
  hapticMode: 'momo.mobile.haptics.v2',
  /**
   * 마지막으로 닫은 「업데이트 소식」의 **소식 버전** 하나(`0.1.41`, #4937). 앱 버전·빌드 번호가 아니다: 폰은 빌드 번호로 소식을
   * 고르지만(`@momo/core/features/releaseNotes/model`) 기기에는 소식의 이름을 적는다. 지금 소식이 이 값보다 새로울 때만
   * 업데이트 뒤 처음 열 때 한 번 보인다. 이 폰의 취향이라 로그아웃·계정 전환에도 남는다(테마와 같은 종류). 잃으면 같은
   * 소식을 한 번 더 볼 뿐이다. 계정 정보 없음.
   */
  releaseNotesSeen: 'momo.mobile.release-notes.seen.v1',
  /**
   * 「링크 미리보기」 — 이 폰이 대화의 링크 카드를 어떻게 그리는가 (#4883). 값은 `rich`(크게) ·
   * `compact`(작게) · `off`(끄기) 세 낱말 중 하나이고, 웹의 `momo.web.link-preview.v1` 과 **같은 값 이름**이다.
   * 키가 없거나 모르는 값이면 코어의 `DEFAULT_UNFURL_SIZE`(작게)다. 기기 취향이라 로그아웃에도 남고
   * 서버·다른 멤버 화면과 무관하다. 비밀이 아니다.
   */
  linkPreview: 'momo.mobile.link-preview.v1',
  /**
   * 검색의 「최근 검색」과 「최근 연 대화」 (#5365). 열쇠 `작업공간:멤버` → {검색 최대 6줄, 채널 id 최대 10개}인 지도 한 덩이의
   * JSON 이다. 최근 검색은 홈 검색과 대화 안 검색이 **한 목록**이고(#5384) 한 줄은 `{query, channelId?}` — 한 대화 안에서 찾은 말은 그 대화 id 를 들고 범위 칩과 함께 보인다.
   * 정원·중복·길이 규칙과 옛 저장 옮기기·로그아웃 삭제는 `features/search/searchRecents.ts` 가 진다. 서버는 이 목록을 본 적이 없다.
   *
   * 여기 있어도 되는 이유: 사람이 방금 화면에서 친 글자와 채널 id 일 뿐이다(토큰·본문 없음). 잃으면 목록이 비어 시작할 뿐이다.
   * 다만 타인이 이 폰에 들어왔을 때 앞사람의 검색어가 비치면 안 되므로, 열쇠에 멤버를 넣고 로그아웃이 통째로 비운다.
   */
  searchRecents: 'momo.mobile.search.recents.v1',
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

/**
 * 기기에 남긴 표현 보관함(`expressionShelf`)을 지운다. 세션이 끝나는 길이 모두 이 함수를 부른다 — 표현 저장소의 `dispose`(`features/expressions`)와 로그아웃(`session/useSession.tsx`).
 * 둘 다 같은 키를 지워야 하는데 `useSession` 이 표현 provider 를 가져오면 import 가 돌아서(provider 가 `useSession` 을 쓴다) 키를 아는 이 파일에 둔다.
 */
export function forgetExpressionShelf(): void {
  nonSecretStore().remove(NON_SECRET_KEYS.expressionShelf);
}

/** Test seam: swap the store, or pass null to fall back to the real MMKV. */
export function __setNonSecretStore(store: NonSecretStore | null): void {
  instance = store;
}
