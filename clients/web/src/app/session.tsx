import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { logout, restoreSession, type LoginResponse } from "@momo/core/lib/api";
import {
  clearSession,
  getAuthExpired,
  hasPersistedSession,
  subscribeSession,
} from "@/lib/session";
import type { RealtimeHandle, RealtimeStatus } from "@/lib/realtime";

/**
 * Everything a route needs from the signed-in session. The realtime handle is
 * owned by the shell (one rail per session), not by a route, so switching
 * channels or opening settings never tears the connection down.
 */
export interface SessionContextValue {
  session: LoginResponse;
  workspaceId: string;
  realtime: RealtimeHandle | null;
  connStatus: RealtimeStatus;
  logout: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const SessionProvider = SessionContext.Provider;

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

// ---- session lifecycle (M9) -------------------------------------------------

/**
 * `restoring` only ever appears when there is something stored to resume, so a
 * first-time visitor sees the login form immediately rather than a flash of a
 * placeholder followed by the same form.
 */
export type SessionRestoreStatus = "restoring" | "anonymous" | "signed-in";

export interface SessionLifecycle {
  status: SessionRestoreStatus;
  session: LoginResponse | null;
  signIn: (session: LoginResponse) => void;
  signOut: () => void;
}

/**
 * Owns sign-in, resume-after-reload and sign-out for the whole app (M9).
 *
 * A reload keeps only the refresh token (the access token is memory-only by
 * design), so resuming is one rotation against the server rather than a local
 * "am I still logged in" guess. Sign-out flips the UI back to the login form
 * synchronously while `logout()` wipes local state and revokes server-side.
 */
export function useRestoredSession(): SessionLifecycle {
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [status, setStatus] = useState<SessionRestoreStatus>(() =>
    hasPersistedSession() ? "restoring" : "anonymous"
  );

  useEffect(() => {
    if (!hasPersistedSession()) return;
    let cancelled = false;
    restoreSession()
      .then((restored) => {
        if (cancelled) return;
        setSession(restored);
        setStatus(restored ? "signed-in" : "anonymous");
      })
      .catch(() => {
        // restoreSession already wiped local state on a dead token; anything
        // left here is a transport failure, and the login form is the honest
        // next step rather than an indefinite placeholder.
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 that survived a rotation means the refresh token is gone for good.
  // Returning to the login form is the honest response; leaving the shell up to
  // fail every request one surface at a time is not.
  const expired = useSyncExternalStore(subscribeSession, getAuthExpired);
  useEffect(() => {
    if (!expired) return;
    clearSession();
    setSession(null);
    setStatus("anonymous");
  }, [expired]);

  const signIn = useCallback((next: LoginResponse) => {
    setSession(next);
    setStatus("signed-in");
  }, []);

  const signOut = useCallback(() => {
    // Fire and forget on purpose: the local wipe inside logout() is synchronous
    // and unconditional, so the user is out of the session before the network
    // call resolves, and a failed revoke cannot pin them inside the app.
    void logout();
    setSession(null);
    setStatus("anonymous");
  }, []);

  return { status, session, signIn, signOut };
}
