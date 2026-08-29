import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { queryClient } from "@/app/queryClient";
import { useRestoredSession } from "@/app/session";
import { startUpdateWatch } from "@/features/updates/store";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { ClaimPage } from "@/features/auth/ClaimPage";
import { isClaimPath } from "@/features/auth/claimPath";
import { AppShell } from "@/app/AppShell";
import { SkeletonRows } from "@/features/common/States";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { ChatShell } from "@/features/chat/ChatShell";
import { InboxRoute } from "@/features/inbox/InboxRoute";
import { ActivityRoute } from "@/features/activity/ActivityRoute";
import { DirectoryRoute } from "@/features/directory/DirectoryRoute";
import { SettingsRoute } from "@/features/settings/SettingsRoute";
import { AgentHubRoute } from "@/features/agentHub/AgentHubRoute";
import { WorkstreamListRoute } from "@/features/workstreams/WorkstreamListRoute";
import { WorkstreamDetailRoute } from "@/features/workstreams/WorkstreamDetailRoute";
import { SearchRoute } from "@/features/search/SearchRoute";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableRoute } from "@/features/capabilities/SurfaceUnavailable";
import { forgetQuota } from "@momo/core/features/settings/quotaModel";
import { forgetUsage } from "@momo/core/features/settings/usageModel";
import { resetAdeDrawer } from "@/features/ade/adeDrawerStore";
import { WorkConsoleRoute } from "@/features/workConsole/WorkConsoleRoute";
import { OAuthConsentRoute } from "@/features/hostedAgents/OAuthConsentRoute";
import { isOauthConsentPath } from "@/features/hostedAgents/oauthConsentPath";

// HashRouter, not BrowserRouter: the Tauri release build loads the bundle from
// `tauri://localhost` with no server to rewrite deep paths, so the same routes
// have to resolve identically in both runtimes (ADR-0133 "one codebase").
export function App() {
  const { status, session, signIn, signOut, replaceSessionMember } =
    useRestoredSession();

  // Above the signed-in/anonymous split on purpose (MOMO-606): someone stuck on
  // the connect screen is the reader most likely to need the build that fixes
  // why they are stuck. No-op in a browser tab.
  useEffect(() => startUpdateWatch(), []);

  useEffect(() => {
    if (session && isClaimPath(window.location.pathname)) {
      window.history.replaceState(null, "", "/");
    }
  }, [session]);

  // OAuth resource-owner consent 는 HashRouter 밖의 실경로다(#1369). provider
  // 리다이렉트가 `/oauth/consent?request=...` 로 떨어뜨리는데, 그 쿼리는 해시가
  // 아니라 진짜 쿼리 문자열에 있어 `<Routes>` 가 잡지 못한다(oauthConsentPath.ts).
  // 그래서 세션 게이트보다 먼저 여기서 갈라진다: 이 화면은 자기 로딩/로그인/본문을
  // 직접 든다.
  if (isOauthConsentPath(window.location.pathname)) {
    return (
      <OAuthConsentRoute status={status} session={session} onLoggedIn={signIn} />
    );
  }

  if (status === "restoring") {
    // Height-preserving bars, not a spinner or a splash: the shell that is
    // about to appear occupies this space, so nothing jumps when it does.
    return (
      <div data-testid="session-restoring">
        <SkeletonRows rows={4} className="p-6" />
      </div>
    );
  }

  if (isClaimPath(window.location.pathname) && !session) {
    return <ClaimPage onLoggedIn={signIn} />;
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
              title="oort를 열지 못했습니다"
              // 이 행동은 화면 이동이 아니라 로그아웃이다(서버 refresh token
              // 폐기 + 캐시 비우기). 그렇게 말하지 않으면 사용자는 돌아왔을 때
              // 왜 다시 로그인해야 하는지 모른다.
              message="이 서버에서 받은 내용을 읽지 못했습니다. 로그아웃하면 연결 화면에서 서버 주소를 다시 고를 수 있습니다."
              retryLabel="로그아웃하고 연결 화면 열기"
              onRetry={() => {
                signOut();
                queryClient.clear();
                forgetUsage();
                forgetQuota();
                resetAdeDrawer();
              }}
            >
              <AppShell
                session={session}
                replaceSessionMember={replaceSessionMember}
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
                  // 관제 서랍의 열림 상태도 모듈 스코프라 세션보다 오래 산다
                  // (design-review ADE 2단계 M1). 열어 둔 채 로그아웃하면 다음
                  // 사람이 로그인하자마자 라우트가 inert인 채 덮여 있는 화면을
                  // 받는다 — 자기가 열지 않은 서랍에.
                  resetAdeDrawer();
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
          <Route path="agents" element={<AgentHubRoute />} />
          <Route path="work" element={<WorkConsoleRoute />} />
          {/* 메시지 검색 (goal B12 H5). 서버가 이미 싣고 있는 경로 위에 선다. */}
          <Route
            path="search"
            element={
              isSurfaceProvided("messageSearch") ? (
                <SearchRoute />
              ) : (
                <SurfaceUnavailableRoute surface="messageSearch" />
              )
            }
          />
          {/* 작업 흐름 (MOMO-677). Two routes, not a pane inside one channel:
              the detail has to be linkable on its own, because handing a
              stopped goal to someone else is the entire point of the surface
              and "여기 좀 이어받아 줘" travels as a URL.

              라우트는 **남긴다**(goal B12). 이 서버가 작업 흐름을 싣지 않아도
              그 주소를 북마크했거나 링크로 받은 사람은 존재하고, 그 사람을 `/`로
              튕겨내면 화면은 아무 말도 하지 않은 채 다른 곳에 데려다 놓는다.
              주소는 그대로 열리고, 열린 자리에서 못 하는 이유를 말한다. */}
          <Route
            path="workstreams"
            element={
              isSurfaceProvided("workstreams") ? (
                <WorkstreamListRoute />
              ) : (
                <SurfaceUnavailableRoute surface="workstreams" />
              )
            }
          />
          <Route
            path="workstreams/:workstreamId"
            element={
              isSurfaceProvided("workstreams") ? (
                <WorkstreamDetailRoute />
              ) : (
                <SurfaceUnavailableRoute surface="workstreams" />
              )
            }
          />
          <Route path="settings" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
