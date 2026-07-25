import { useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { setAccessToken, type LoginResponse } from "@/lib/api";
import { LoginPage } from "@/features/auth/LoginPage";
import { AppShell } from "@/app/AppShell";
import { ChatShell } from "@/features/chat/ChatShell";
import { InboxRoute } from "@/features/inbox/InboxRoute";
import { ActivityRoute } from "@/features/activity/ActivityRoute";
import { SettingsRoute } from "@/features/settings/SettingsRoute";

// HashRouter, not BrowserRouter: the Tauri release build loads the bundle from
// `tauri://localhost` with no server to rewrite deep paths, so the same routes
// have to resolve identically in both runtimes (ADR-0133 "one codebase").
export function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);

  if (!session) {
    return <LoginPage onLoggedIn={setSession} />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route
          element={
            <AppShell
              session={session}
              onLogout={() => {
                setAccessToken(null);
                setSession(null);
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
