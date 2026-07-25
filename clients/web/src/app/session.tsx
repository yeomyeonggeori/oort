import { createContext, useContext } from "react";
import type { LoginResponse } from "@/lib/api";
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
