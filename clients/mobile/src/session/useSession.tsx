import {logout, refreshSessionOutcome, type Member} from '@momo/core/lib/api';
import {onlineManager, useQueryClient} from '@tanstack/react-query';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  clearSession,
  getAccessToken,
  getAuthExpired,
  getPersistedSession,
  hasPersistedSession,
  subscribeSession,
} from '../storage/secureSession';
import {authGate, type AuthGate} from './authGate';
import {forgetDeviceKeyOnSignOut} from '../deviceKey/enrollment';
import {clearAllDrafts} from '../features/conversation/drafts';
import {
  closeFailedSendsForSignOut,
  openFailedSendsForSession,
} from '../features/conversation/failedSends';
import {clearAllSearchRecents} from '../features/search/searchRecents';
import {clearAllAttachmentDrafts} from '../features/attachments/draftStore';
import {forgetBackgroundOnSignOut} from '../design/background/store';
import {clearEntryDrafts} from '../lib/entryDrafts';
import {clearMemberAvatarCache} from '../features/conversation/memberAvatarImage';
import {
  destroyExpressionDisks,
  forgetExpressionDisk,
} from '../features/expressions/disk/signOut';
import {forgetExpressionShelf} from '../storage/kv';
import {forgetMeasuredSizes} from '../storage/measureMemory';
import {revokeDevice} from '../push/devices';
import {dismissDeliveredNotifications} from '../push/dismissDelivered';
import {clearPushActionSession} from '../push/pushActionSession';
import {clearPresentationState} from '../push/presentation';
import {clearPushOptOut} from '../push/pushOptOut';
import {registeredPushDeviceId} from '../push/registration';

// =============================================================================
// The session, as React sees it.
//
// `secureSession.ts` is an imperative module store — the core writes to it
// through `SessionPort` from inside `login()`, `refreshSession()` and `logout()`,
// none of which know React exists. `useSyncExternalStore` is the supported way to
// read a store like that without tearing, and it is what the web client uses for
// the same store for the same reason.
//
// ## Three subscriptions rather than one snapshot object
//
// A single `getSnapshot` returning `{member, hasToken, expired}` would allocate a
// fresh object on every call, and `useSyncExternalStore` compares snapshots by
// identity — that is an infinite render loop, not a performance note. Caching the
// object would work and would need invalidation on every write path. Three reads
// of individually stable values need neither.
//
// **`hasAccessToken` is a boolean on purpose.** Returning the token itself would
// put a live bearer credential into React state, where it rides every DevTools
// inspection and every error-boundary dump. Nothing in the tree needs its value:
// the core reads it inline from the store when it builds a request.
// =============================================================================

function subscribe(listener: () => void): () => void {
  return subscribeSession(listener);
}

/** Stable across rotations: `applyRotation` replaces the session but not the member. */
function readMember(): Member | null {
  return getPersistedSession()?.member ?? null;
}

function readHasAccessToken(): boolean {
  return getAccessToken() !== null;
}

export interface AuthGateState {
  gate: AuthGate;
  /** Ask for the boot rotation again. Wired to the retry a person can press. */
  retry: () => void;
}

export function useAuthGate(): AuthGateState {
  const member = useSyncExternalStore(subscribe, readMember);
  const hasAccessToken = useSyncExternalStore(subscribe, readHasAccessToken);
  const authExpired = useSyncExternalStore(subscribe, getAuthExpired);

  // The boot-time rotation. A stored session carries no access token (memory
  // only, ADR-0137 D7), so resuming IS one refresh — and until it answers, this
  // client can neither show a shell (every query would 401) nor a sign-in form
  // (the person is signed in). `restoreSettled` is what buys the third state.
  const [restoreSettled, setRestoreSettled] = useState(
    () => !hasPersistedSession(),
  );
  const [restoreUnreachable, setRestoreUnreachable] = useState(false);
  // Bumped to re-arm the effect. A launch with no signal must not cost the
  // session for the life of the process.
  const [attempt, setAttempt] = useState(0);

  const retryRestore = useCallback(() => {
    setRestoreUnreachable(false);
    setRestoreSettled(false);
    setAttempt(current => current + 1);
  }, []);

  useEffect(() => {
    if (restoreSettled) return;
    if (!hasPersistedSession()) {
      // Nothing to resume. Settling immediately keeps the sign-in form one
      // render away instead of behind a rotation that has no token to present.
      setRestoreSettled(true);
      return;
    }
    // ## Why this refuses to even ATTEMPT while offline
    //
    // A rotation with no radio can only fail, and a session is what it risks.
    // `onlineManager` already knows the answer, so the attempt is skipped and
    // the gate is told which KIND of failure this is.
    if (!onlineManager.isOnline()) {
      setRestoreUnreachable(true);
      setRestoreSettled(true);
      return;
    }
    let cancelled = false;
    // ## Why the ROTATION and not `restoreSession()` (성재, iPhone 17: 서버에 못
    // 닿는 시작이 로그인 화면을 띄운다)
    //
    // `restoreSession()` answers `LoginResponse | null`, and **null is three
    // different sentences**: nothing to resume, the stored token was refused,
    // and nothing answered. The core stopped throwing on the third one when it
    // learned to keep the credentials (`RefreshOutcome`) — which fixed the
    // credentials and broke the screen, because the `.catch` that used to raise
    // `restoreUnreachable` here stopped running and the gate fell through to
    // `signedOut`. So a launch on a plane kept the session and showed a sign-in
    // form for it: 자격증명은 살아남는데 화면이 거짓말을 했다.
    //
    // `refreshSessionOutcome()` is the same single-flight rotation with the
    // reason attached, so the host reads the verdict instead of inferring it
    // from a null. What `restoreSession()` did on top of it — wipe local state
    // when the token was REFUSED — is done here explicitly, against this
    // client's own store, which is the store `sessionPort` hands the core
    // anyway. Its return value was never read on this client: every screen
    // below reads the store through `useSyncExternalStore`.
    refreshSessionOutcome()
      .then(outcome => {
        if (cancelled) return;
        if (outcome === 'unreachable') {
          // **Nothing answered ⇒ nothing is proven.** The session stays, and the
          // screen says so rather than asking for a password it already has.
          setRestoreUnreachable(true);
          return;
        }
        setRestoreUnreachable(false);
        // Refused — or rotated into a state that cannot make a request. Either
        // way there is nothing here to resume, and a stored token beside a
        // sign-in form is the one combination that must not survive. (The core
        // has already called `markAuthExpired()` for a 401, and it notifies
        // BEFORE this wipe clears the flag, so the gate still gets to say
        // 로그인이 만료되었습니다 on its way past.)
        if (
          outcome !== 'rotated' ||
          getPersistedSession() === null ||
          getAccessToken() === null
        ) {
          clearSession();
        }
      })
      .catch(() => {
        // The core resolves rather than throws today, so this is belt-and-braces
        // — but a throw here means the request never got a verdict, and that is
        // never a reason to show a sign-in form.
        if (!cancelled) setRestoreUnreachable(true);
      })
      .finally(() => {
        if (!cancelled) setRestoreSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreSettled, attempt]);

  // Try again the moment the radio comes back. `onlineManager` is already fed by
  // NetInfo through `installReactQueryBridges`, so this costs no second
  // subscription to the platform and cannot disagree with what react-query
  // thinks about connectivity.
  useEffect(() => {
    if (!restoreUnreachable) return;
    return onlineManager.subscribe(online => {
      if (online) retryRestore();
    });
  }, [restoreUnreachable, retryRestore]);

  const gate = useMemo(
    () =>
      authGate({
        member,
        hasAccessToken,
        authExpired,
        restoreSettled,
        restoreUnreachable,
      }),
    [member, hasAccessToken, authExpired, restoreSettled, restoreUnreachable],
  );

  // 로그인 화면으로 돌아오는 순간은 모두 같은 경계다 — 로그아웃, 토큰 만료, 복원이 거절된 시작(#5058). 알림에 밀려 시트가 걷히며 맡겨
  // 둔 글(`lib/entryDrafts.ts`)은 앞 사람의 것이므로, 같은 실행에서 같은 워크스페이스로 다음 사람이 들어와도 보이지 않게 여기서도
  // 비운다. `signOut` 안의 같은 호출은 사람이 나가는 즉시 비우는 길이고, 이것은 `signOut` 을 거치지 않는 길(만료)까지 덮는다.
  // 게이트의 종류(`gate.kind`)가 아니라 그 재료로 가른다: 종류를 문자열로 견주면 문구 장부(`direct-copy`)가 영어 낱말 하나를 더 센다.
  // 세션이 없거나(`member` 없음 — 로그아웃·복원 거절) 만료됐으면 사람은 로그인 화면에 있다. `restoring`(세션이 살아 있는 동안)은
  // 둘 다 아니라 지우지 않는다. `SessionProvider` 의 언마운트에 걸지 않은 까닭: 그 트리가 내려가는 일이 모두 세션의 끝은 아니다.
  const leftSession = member === null || authExpired;
  useEffect(() => {
    if (leftSession) {
      clearEntryDrafts();
      // 토큰 만료·복원이 거절된 시작은 `signOut` 을 거치지 않는다: 표현 그림의 기기 캐시(모든 보관 칸)·기기에 남긴 표현 보관함·잰 크기도 여기서 지운다(ADR-0218 §14 M2.5, #5455).
      // `ExpressionProvider` 의 `dispose` 에만 걸지 않는다 — 만료된 채 앱이 켜져 로그인 화면으로 가면 그 provider 가 뜨지 않아 `dispose` 가 돌지 않는다.
      forgetExpressionDisk();
      forgetExpressionShelf();
      forgetMeasuredSizes();
    }
  }, [leftSession]);

  return useMemo(() => ({gate, retry: retryRestore}), [gate, retryRestore]);
}

export interface SignedInSession {
  member: Member;
  workspaceId: string;
  signOut: () => void;
}

const SessionContext = createContext<SignedInSession | null>(null);

/**
 * Wraps the signed-in half of the tree. Mounted only under a `signedIn` gate, so
 * every screen below can take a member for granted instead of threading a
 * nullable one through four levels of props.
 */
export function SessionProvider({
  member,
  children,
}: {
  member: Member;
  children: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const attachmentSessionKey = `${member.workspaceId}|${member.id}`;

  useEffect(() => {
    // explicit signOut만 경계가 아니다. 토큰 만료는 이 provider를 바로 내리고,
    // 같은 프로세스에서 다른 계정이 들어오면 member identity가 바뀐다. 두 경우 모두
    // 이전 세대의 draft/native PUT/create 응답을 다음 계정보다 먼저 끊는다 (#1703).
    return () => {
      clearAllAttachmentDrafts();
      // 토큰 만료·계정 교체도 이 경계다 — 앞 사람의 얼굴 파일을 디스크에 남기지 않는다.
      clearMemberAvatarCache();
      // 표현 그림의 기기 캐시(모든 보관 칸)와 기기에 남긴 표현 보관함·잰 크기도 같은 경계에서 지운다(ADR-0218 §14 M2.5). 세대는 올리지 않는다: 계정 교체로 이미 만들어진 새 저장소를 막지 않는다
      // (앞 저장소는 이 효과보다 먼저 `dispose` 로 놓인다).
      destroyExpressionDisks();
      forgetExpressionShelf();
      forgetMeasuredSizes();
      // 알림 확장에게 건넨 얼굴·채널 이름과, 시스템에 기부한 커뮤니케이션 기록도 같은 경계에서 지운다(#4316).
      void clearPresentationState();
    };
  }, [attachmentSessionKey]);

  // 세션이 섰다: 로그아웃이 닫은 「보내지 못한 글」 저장을 이 세션에 다시 연다(#5799). provider 는 로그인마다 새로 선다(`App.tsx` Gate).
  useEffect(() => {
    openFailedSendsForSession();
  }, []);

  // 세션 provider 가 내려갈 때(로그아웃·토큰 만료) 내 사진 배경을 지운다 (ADR-0189 증보 2).
  // 위 효과처럼 workspace/member 키에 묶지 않는다 — 그러면 같은 사람이 워크스페이스를
  // 바꿀 때마다 사진이 사라진다. 사진은 계정이 아니라 **세션의 끝**에서 지운다.
  useEffect(() => forgetBackgroundOnSignOut, []);

  const workspaceId = member.workspaceId;
  const signOut = useCallback(() => {
    // Fire and forget, exactly as the web client does and for the reason the
    // core's `logout()` documents: the local wipe inside it is synchronous and
    // unconditional, so the person is out before the revocation resolves and a
    // dead network cannot trap them inside a session they asked to leave.
    //
    // 이 폰의 푸시 등록도 여기서 지운다 (#2677, ADR-0120 D4). 지우지 않으면 로그아웃한
    // 폰이 앞 사람의 「oort / 새 알림」과 배지를 계속 받는다 — 알림 확장은 세션이
    // 없으면 relay 자리표시를 그대로 띄운다. 요청은 코어의 `beforeRevoke` 창에서
    // 간다: 로컬 세션은 이미 지워졌고(사람은 기다리지 않는다) 서버 세션은 아직
    // 살아 있는, 떠나는 토큰이 마지막으로 인증되는 순간이다. 새 서버는 세션이 끝날
    // 때 등록을 스스로 끝내므로 이 호출은 보조다 — 옛 셀프호스트 서버에서도 같은
    // 결과를 내고, 어느 쪽이든 서버의 기록을 곧바로 참으로 만든다.
    const deviceId = registeredPushDeviceId();
    void logout(
      deviceId === null
        ? {}
        : {
            beforeRevoke: accessToken =>
              revokeDevice(workspaceId, deviceId, accessToken),
          },
    );
    // Every cached answer in here was fetched with the credential that was just
    // destroyed, and some of it (channel names, member names) is the previous
    // person's. Clearing is not an optimisation.
    queryClient.clear();
    // 초안도 함께 지운다 (U4-6 리뷰 H-2). 위 한 줄과 같은 이유인데 초안 쪽이 더
    // 무겁다: react-query 의 캐시는 메모리라 프로세스와 함께 사라지지만, 초안은
    // **MMKV 에 남아** 다음 사람의 첫 입력창에 복원된다. 로그아웃은 「이 기기에서
    // 내 흔적을 지운다」이고, 쓰다 만 글은 보낸 메시지보다 사적이다 — 보낸 것은
    // 지워도 원장에 남지만 안 보낸 글은 이 기기에만 있다. 웹이 같은 자리에서 같은
    // 일을 한다(`clients/web/src/app/session.tsx`).
    clearAllDrafts();
    // 보내지 못한 글도 같은 이유로 지운다(#5222): 안 보낸 글은 보낸 메시지보다 사적이고 이 기기에만 있다. 다음 사람의 같은 채널에서 되살아나지 않게.
    // 지운 뒤 다음 세션까지 닫는다(#5799): 세션 트리는 이 함수 **뒤에** 내려가며 날아가던 전송을 다시 남기려 한다.
    closeFailedSendsForSignOut();
    // 최근 검색(홈 검색과 대화 안 검색이 한 목록, #5384)·최근 연 대화도 지운다(#5364·#5365): 앞 사람이 친 말이 이 폰에 들어온 다음 사람의 검색 첫 화면에 비치면 안 된다.
    // 옮기기 전의 옛 대화 안 검색 저장이 남아 있어도 같은 호출이 함께 지운다.
    clearAllSearchRecents();
    // 잰 사진 크기·링크 카드 높이(`storage/measureMemory.ts`)와 기기에 남긴 표현 보관함도 지운다(#5473): 서버가 만든 id → 숫자·표현 이름이라 비밀은 아니지만,
    // 로그아웃은 「이 기기에서 내 흔적을 지운다」이고 두 지도는 계정 구분이 없다.
    forgetMeasuredSizes();
    forgetExpressionShelf();
    // 이모티콘 그림의 기기 캐시(모든 보관 칸)도 지운다(ADR-0218 §14 M2.5, #5455 B-2): 세대를 먼저 올려, 로그아웃과 겹쳐 늦게 닿은 저장이 지워진 칸을 되살리지 못하게 한다.
    forgetExpressionDisk();
    // 알림이 걷어 간 시트의 글(`lib/entryDrafts.ts`)도 같은 이유로 지운다 (#5058). 메모리에만 있어 프로세스와 함께 사라지지만,
    // 같은 실행에서 같은 워크스페이스로 다른 사람이 이어 들어오면 앞 사람의 새 채널 이름·내 맥 질문이 그 사람의 시트에 나타난다.
    clearEntryDrafts();
    // 지시 기기 키도 지운다 (#3026, ADR-0146 개정 D-7). 서버는 이 로그인 계보가
    // 끝나며 키 행을 폐기하고, 어떤 행도 받아 주지 않는 키가 다음 사람의 로그인까지
    // 남을 까닭이 없다. 다음 QR 연결이 새 키를 만들고 맥이 다시 승인한다.
    forgetDeviceKeyOnSignOut();
    // 「이 폰의 푸시를 껐다」는 기억도 지운다 (#3924, ADR-0204 D1). 로그아웃은 서버의 이
    // 기기 등록도 끝내고(위 `beforeRevoke`), 껐다는 것은 그 로그인에서 사람이 한 선택이다 —
    // 다음 로그인(다른 사람이든 같은 사람이든)은 처음 보는 폰처럼 등록한다.
    clearPushOptOut();
    // 잠금 화면 승인의 자격도 **이 자리에서** 지운다 (#3931, ADR-0204 D6). 서버의 토큰은 이
    // 로그인 계보가 끝날 때 함께 죽지만, 폰에 남은 사본은 그 사이 앞 사람 이름으로 승인을
    // 결정할 수 있다. `PushProvider` 가 내려갈 때도 같은 것을 지우나(토큰 만료 같은 다른 길),
    // 그것은 트리가 내려간 **뒤**다 — 사람이 나가는 순간에는 기다리지 않는다.
    void clearPushActionSession();
    // 이미 와 있는 알림도 비운다 (#3931). 승인 요청은 버튼을 단 채 앞 사람의 이름으로 잠금 화면에
    // 남아 있다 — 자격이 없어 눌러도 결정은 되지 않지만, 로그아웃한 폰에 앞 사람의 요청과 메시지
    // 미리보기가 남아 있을 이유가 없다.
    void dismissDeliveredNotifications();
    // 첨부 초안은 더 위험하다: 메모리 안에 구 bearer로 만든 upload session id와
    // native PUT이 살아 있을 수 있다. 화면만 비우지 않고 진행 중 PUT도 취소하며,
    // 늦게 도착한 create/complete 응답도 세션 세대 경계에서 버린다 (#1703).
    clearAllAttachmentDrafts();
    // 멤버 아바타 파일 캐시도 지운다(메모리 색인 + 디스크).
    clearMemberAvatarCache();
    // 알림 확장에게 건넨 얼굴·채널 이름(App Group)도 지우고, 시스템에 기부한 커뮤니케이션 기록을 지우라고
    // 한다(#4316, ADR-0204 증보 5). 지우지 못하면 앞 사람 이름의 알림 기록이 이 폰에 남는다 — 끝나지 못한
    // 지우기는 네이티브가 다음 실행에 다시 한다. 「메시지 미리보기」·「보낸 사람 표시」는 이 폰의 취향이라 남는다.
    void clearPresentationState();
    // 내 사진 배경은 이 기기의 사람 데이터다 — 다음 사람의 기기에 남기지 않는다
    // (ADR-0189 증보 2). 단색·기본 제공 선택은 취향이라 남는다.
    forgetBackgroundOnSignOut();
  }, [queryClient, workspaceId]);

  const value = useMemo<SignedInSession>(
    () => ({member, workspaceId: member.workspaceId, signOut}),
    [member, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SignedInSession {
  const value = useContext(SessionContext);
  if (value === null) {
    // A programming error, not a user-facing one: this hook is only reachable
    // from inside the signed-in tree.
    throw new Error('useSession() was called outside SessionProvider');
  }
  return value;
}
