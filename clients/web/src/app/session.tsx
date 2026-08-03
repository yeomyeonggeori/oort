import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BOOT_RESTORE_BUDGET_MS } from "@/app/boot";
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

  // DESK-1: whether there is something to resume is a LIVE question, not a
  // one-shot read. Boot no longer blocks the first paint on the desktop keychain
  // (main.tsx), so the answer can arrive after this hook has already mounted and
  // said "anonymous" — `hydrate()` notifies the session store when it does.
  const resumable = useSyncExternalStore(subscribeSession, hasPersistedSession);

  // One resume attempt per app lifetime. Without this the effect would re-fire
  // on the store notification that a fresh sign-in emits, and rotate a token
  // that was issued one millisecond ago.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current || !resumable) return;
    attempted.current = true;
    let cancelled = false;
    let settled = false;
    setStatus("restoring");

    // DESK-1: the screen is not allowed to wait for this. `restoreSession()` is
    // one `/v1/auth/refresh` rotation bounded only by REQUEST_TIMEOUT_MS
    // (15 000 ms), and against an unreachable or unresolvable host it spends
    // every one of them — which is the second half of the ~30 s the packaged app
    // was showing. When the budget elapses the connect screen takes over; the
    // rotation is NOT cancelled, so one that lands late still signs the person
    // in rather than making them retype a password they never needed to.
    const release = setTimeout(() => {
      if (!cancelled && !settled) setStatus("anonymous");
    }, BOOT_RESTORE_BUDGET_MS);

    restoreSession()
      .then((restored) => {
        settled = true;
        if (cancelled) return;
        setSession(restored);
        setStatus(restored ? "signed-in" : "anonymous");
      })
      .catch(() => {
        // restoreSession already wiped local state on a dead token; anything
        // left here is a transport failure, and the login form is the honest
        // next step rather than an indefinite placeholder.
        settled = true;
        if (!cancelled) setStatus("anonymous");
      })
      .finally(() => clearTimeout(release));

    return () => {
      cancelled = true;
      clearTimeout(release);
    };
  }, [resumable]);

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
