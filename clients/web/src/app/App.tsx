import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { queryClient } from "@/app/queryClient";
import { useRestoredSession } from "@/app/session";
import { startUpdateWatch } from "@/features/updates/store";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { AppShell } from "@/app/AppShell";
import { SkeletonRows } from "@/features/common/States";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { ChatShell } from "@/features/chat/ChatShell";
import { InboxRoute } from "@/features/inbox/InboxRoute";
import { ActivityRoute } from "@/features/activity/ActivityRoute";
import { DirectoryRoute } from "@/features/directory/DirectoryRoute";
import { SettingsRoute } from "@/features/settings/SettingsRoute";
import { forgetQuota } from "@/features/settings/quotaModel";
import { forgetUsage } from "@/features/settings/usageModel";

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
        {/* 라우트 실패는 AppShell 안쪽 경계가 받는다. 여기까지 올라온 것은 셸
         * 자체가 서지 못한 경우뿐이라 사이드바도 설정도 남지 않는다. 그래서 이
         * 폴백의 행동은 새로고침이 아니라 입력을 바꾸는 것이어야 한다 — 같은
         * 주소로 다시 열면 방금 무너진 그 상태로 돌아올 뿐이고, 서버를 다시 고를
         * 길은 연결 화면에만 있다. */}
        <Route
          element={
            <RenderErrorBoundary
              title="momo를 열지 못했습니다"
              message="이 서버에서 받은 내용을 읽지 못했습니다. 연결 화면에서 서버 주소를 다시 확인할 수 있습니다."
              retryLabel="연결 화면으로"
              onRetry={() => {
                signOut();
                queryClient.clear();
                forgetUsage();
                forgetQuota();
              }}
            >
              <AppShell
                session={session}
                onLogout={() => {
                  // Cached workspace data belongs to the session that is ending,
                  // so it goes with it: no roster, channel or read-state row from
                  // the previous member survives into the next login.
                  signOut();
                  queryClient.clear();
                  // The 사용량 fallbacks live outside the query cache (they have
                  // to outlive the failing query), so they are cleared by hand
                  // here: the cost ledger and the provider quota gauges alike.
                  forgetUsage();
                  forgetQuota();
                }}
              />
            </RenderErrorBoundary>
          }
        >
          <Route index element={<ChatShell />} />
          <Route path="c/:channelId" element={<ChatShell />} />
          <Route path="inbox" element={<InboxRoute />} />
          <Route path="activity" element={<ActivityRoute />} />
          <Route path="directory" element={<DirectoryRoute />} />
          <Route path="settings" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
