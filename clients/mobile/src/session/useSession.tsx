import {logout, restoreSession, type Member} from '@momo/core/lib/api';
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
  getAccessToken,
  getAuthExpired,
  getPersistedSession,
  hasPersistedSession,
  subscribeSession,
} from '../storage/secureSession';
import {authGate, type AuthGate} from './authGate';

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
    // ## Why this refuses to even ATTEMPT while offline
    //
    // `restoreSession()` (core) runs one rotation and then does
    // `if (!rotated) { clearSession(); return null; }`. `refreshSession()`
    // returns false for BOTH "the server refused this token" and "nothing
    // answered" — it catches the transport failure with a comment that says the
    // session is deliberately *not* declared dead — but `restoreSession()` then
    // declares it dead anyway and deletes the refresh token from the keychain.
    //
    // So on this path a single launch with no signal costs the person their
    // session and their password. That is a core bug and it is reported rather
    // than patched here (the core is frozen for this batch and the web client
    // has the same call). What the host CAN do is not hand it the chance: with
    // no network there is nothing to gain from trying and a session to lose.
    if (!onlineManager.isOnline()) {
      setRestoreUnreachable(true);
      setRestoreSettled(true);
      return;
    }
    let cancelled = false;
    restoreSession()
      .then(() => {
        // Settled: either a live session, or the core decided the stored token
        // was dead and wiped local state. The gate reads the store to tell them
        // apart.
        if (!cancelled) setRestoreUnreachable(false);
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
