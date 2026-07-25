import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { queryClient } from "@/app/queryClient";
import { useRestoredSession } from "@/app/session";
import { startUpdateWatch } from "@/features/updates/store";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { AppShell } from "@/app/AppShell";
import { SkeletonRows } from "@/features/common/States";
import { ChatShell } from "@/features/chat/ChatShell";
import { InboxRoute } from "@/features/inbox/InboxRoute";
import { ActivityRoute } from "@/features/activity/ActivityRoute";
import { SettingsRoute } from "@/features/settings/SettingsRoute";

// HashRouter, not BrowserRouter: the Tauri release build loads the bundle from
// `tauri://localhost` with no server to rewrite deep paths, so the same routes
// have to resolve identically in both runtimes (ADR-0133 "one codebase").
export function App() {
  const { status, session, signIn, signOut } = useRestoredSession();

  // Above the signed-in/anonymous split on purpose (MOMO-606): someone stuck on
  // the connect screen is the reader most likely to need the build that fixes
  // why they are stuck. No-op in a browser tab.
  useEffect(() => startUpdateWatch(), []);

  if (status === "restoring") {
    // Height-preserving bars, not a spinner or a splash: the shell that is
    // about to appear occupies this space, so nothing jumps when it does.
    return (
      <div data-testid="session-restoring">
        <SkeletonRows rows={4} className="p-6" />
      </div>
    );
  }

  if (!session) {
    return <ConnectPage onLoggedIn={signIn} />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route
          element={
            <AppShell
              session={session}
              onLogout={() => {
                // Cached workspace data belongs to the session that is ending,
                // so it goes with it: no roster, channel or read-state row from
                // the previous member survives into the next login.
                signOut();
                queryClient.clear();
              }}
            />
          }
        >
          <Route index element={<ChatShell />} />
          <Route path="c/:channelId" element={<ChatShell />} />
          <Route path="inbox" element={<InboxRoute />} />
          <Route path="activity" element={<ActivityRoute />} />
          <Route path="settings" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
