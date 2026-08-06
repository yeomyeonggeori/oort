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
import {clearAllDrafts} from '../features/conversation/drafts';

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
  const [restoreSettled, setRestoreSettled] = useState(() => !hasPersistedSession());
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

  const signOut = useCallback(() => {
    // Fire and forget, exactly as the web client does and for the reason the
    // core's `logout()` documents: the local wipe inside it is synchronous and
    // unconditional, so the person is out before the revocation resolves and a
    // dead network cannot trap them inside a session they asked to leave.
    void logout();
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
  }, [queryClient]);

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
