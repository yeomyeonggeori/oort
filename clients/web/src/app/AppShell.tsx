import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import type { LoginResponse } from "@/lib/api";
import {
  createRealtime,
  resolveSpikeRealtimeUrl,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime";
import { SessionProvider } from "@/app/session";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { InboxHotkeys } from "@/features/inbox/InboxHotkeys";

// =============================================================================
// Signed-in shell: owns the single realtime rail for the session and renders
// the sidebar beside whichever route is active. Channels, inbox, activity and
// settings all mount inside this frame, so the connection survives navigation.
// =============================================================================

export function AppShell({
  session,
  onLogout,
}: {
  session: LoginResponse;
  onLogout: () => void;
}) {
  const [realtime, setRealtime] = useState<RealtimeHandle | null>(null);
  const [connStatus, setConnStatus] = useState<RealtimeStatus>("connecting");
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // The pure-scroll gate (?stress=N) renders synthetic rows and must not open
  // a socket, otherwise the frame profile measures the network too.
  const stress = new URLSearchParams(location.search).has("stress");

  useEffect(() => {
    if (stress) return;
    const handle = createRealtime(
      resolveSpikeRealtimeUrl(session.realtimeWebSocketUrl),
      setConnStatus
    );
    setRealtime(handle);
    return () => {
      handle.dispose();
      setRealtime(null);
    };
  }, [session.realtimeWebSocketUrl, stress]);

  return (
    <SessionProvider
      value={{
        session,
        workspaceId: session.member.workspaceId,
        realtime,
        connStatus,
        logout: onLogout,
      }}
    >
      {/* app-shell is the named two-pane grid from tokens.css (sidebar 240px),
       * so the shell needs no arbitrary grid-cols value. The switcher is a
       * portalled dialog and deliberately sits outside that grid. */}
      <div className="app-shell h-full">
        <Sidebar onOpenQuickSwitcher={() => setSwitcherOpen(true)} />
        <main className="flex min-w-0">
          <Outlet />
        </main>
      </div>
      {/* Global keyboard paths that must work from any route (R-1 §2). */}
      <InboxHotkeys />
      <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </SessionProvider>
  );
}
