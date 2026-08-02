import {logout, restoreSession, type Member} from '@momo/core/lib/api';
import {useQueryClient} from '@tanstack/react-query';
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

export function useAuthGate(): AuthGate {
  const member = useSyncExternalStore(subscribe, readMember);
  const hasAccessToken = useSyncExternalStore(subscribe, readHasAccessToken);
  const authExpired = useSyncExternalStore(subscribe, getAuthExpired);

  // The boot-time rotation. A stored session carries no access token (memory
  // only, ADR-0137 D7), so resuming IS one refresh — and until it answers, this
  // client can neither show a shell (every query would 401) nor a sign-in form
  // (the person is signed in). `restoreSettled` is what buys the third state.
  const [restoreSettled, setRestoreSettled] = useState(() => !hasPersistedSession());

  useEffect(() => {
    if (restoreSettled) return;
    let cancelled = false;
    restoreSession()
      .catch(() => {
        // `restoreSession` already wipes local state when the stored token is
        // dead. A transport failure lands here instead, and the honest reading
        // of it is the same one the gate makes for any unusable session: ask for
        // a sign-in. The person still has the server address, so it is one tap.
        return null;
      })
      .finally(() => {
        if (!cancelled) setRestoreSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreSettled]);

  return useMemo(
    () => authGate({member, hasAccessToken, authExpired, restoreSettled}),
    [member, hasAccessToken, authExpired, restoreSettled],
  );
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
