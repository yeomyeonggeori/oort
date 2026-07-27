import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import type { LoginResponse } from "@/lib/api";
import {
  createRealtime,
  resolveSpikeRealtimeUrl,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime";
import { SessionProvider } from "@/app/session";
import { queryClient } from "@/app/queryClient";
import { resetRouteQueries } from "@/app/retryScope";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
import { AgentProfileProvider } from "@/features/routing/AgentProfileDialog";
import { InboxHotkeys } from "@/features/inbox/InboxHotkeys";
import { DesktopNotifications } from "@/features/notifications/DesktopNotifications";
import { AgentWorkingRail } from "@/features/agents/AgentWorkingRail";
import { AgentTurnFixture } from "@/features/agents/AgentTurnFixture";
import { agentTurnFixtureMode } from "@/features/agents/turnFixture";

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
  // The route boundary resets when the user navigates: a failed channel must
  // not keep the next one from rendering.
  const routePath = useLocation().pathname;

  // The pure-scroll gate (?stress=N) renders synthetic rows and must not open
  // a socket, otherwise the frame profile measures the network too.
  const stress = new URLSearchParams(location.search).has("stress");
  // The design capture seam (?agentwork=live|offline) seeds fixed agent turns
  // instead of watching for real ones, so the sidebar pill and the composer
  // activity line are reviewable in artifacts/design (SKILL §11). The rail is
  // swapped out, not the socket: the timeline still loads its history through
  // the ordinary path, and the turn store keeps exactly one writer.
  //
  // It exists only in a dev or `--mode design` build (turnFixture.ts), and where
  // it exists the sidebar prints a warn line naming the mode, because unlike
  // ?stress=N these fixtures are indistinguishable from the real thing on sight.
  const turnFixture = agentTurnFixtureMode();

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
        // `?agentwork=live` shoots the connected surface without a socket and
        // `?agentwork=offline` shoots the rail-down one. Both are stated
        // outright rather than left to the environment: measured against a real
        // momowebqa the socket connects, so an `offline` capture that merely
        // "let the status be" produced a fully live screen. The override reaches
        // every consumer of connStatus, including the offline banner, which is
        // why the sidebar notice says so in as many words.
        connStatus:
          turnFixture === "live"
            ? "connected"
            : turnFixture === "offline"
              ? "disconnected"
              : connStatus,
        logout: onLogout,
      }}
    >
      {/* app-shell is the named two-pane grid from tokens.css (sidebar 240px,
       * viewport height), so the shell needs no arbitrary grid-cols value. The
       * switcher is a portalled dialog and deliberately sits outside that grid.
       *
       * min-h-0 on <main> is load-bearing (MOMO-610): without it a grid item
       * whose overflow is visible takes its content height as its minimum, so a
       * long route — 설정 > 멤버와 초대 was the reported one — grew the row past
       * the window and the whole page scrolled, carrying the sidebar off screen.
       * With the floor at zero the route is handed the window height and has to
       * scroll its own pane. */}
      {/* 채널 만들기 is offered from three places (사이드바 헤더 +, 빈 워크스페이스,
       * ⌘K 팔레트) and all three open ONE dialog owned here, so the form has one
       * piece of state and no entry point can go stale (MOMO-614). The provider
       * wraps the switcher too, because the palette is the house keyboard path
       * to every action and this one had no seat in it. */}
      {/* 에이전트 프로필도 같은 규칙이다(MOMO-626): 디렉터리 행, 타임라인의
       * 에이전트 이름, 컴포저의 멘션 줄 셋이 하나의 다이얼로그를 연다. 진입점
       * 마다 다이얼로그를 두면 폼 상태가 세 벌이 되고 그중 하나는 낡는다. */}
      <CreateChannelProvider>
        <AgentProfileProvider>
          <div className="app-shell">
            <Sidebar onOpenQuickSwitcher={() => setSwitcherOpen(true)} />
            <main className="flex min-h-0 min-w-0">
              {/* 라우트 하나가 던져도 사이드바·⌘K·설정·로그아웃은 살아 있어야
               * 한다. 앱 루트 경계만 있으면 채팅에서 난 오류가 셸을 통째로
               * 지워 사용자가 다른 화면으로 갈 길까지 사라진다. 실패는 그것을
               * 소유한 표면 안에 머문다. */}
              <RenderErrorBoundary
                resetKey={routePath}
                title="이 화면을 열지 못했습니다"
                message="서버에서 받은 내용을 읽지 못했습니다. 다른 화면은 그대로 쓸 수 있습니다."
                retryLabel="다시 시도"
                onRetry={() => resetRouteQueries(queryClient)}
              >
                <Outlet />
              </RenderErrorBoundary>
            </main>
          </div>
          {/* Global keyboard paths that must work from any route (R-1 §2). */}
          <InboxHotkeys />
          {/* Renders nothing; watches the rail so a mention or an approval
           * request reaches the OS while the window is in the background
           * (MOMO-607). */}
          {!stress && <DesktopNotifications />}
          {/* Renders nothing; watches every agent's progress channel so the
           * sidebar badge and the composer line describe the same turn
           * (MOMO-613). Exactly one writer to the turn store is ever mounted. */}
          {!stress && turnFixture === null && <AgentWorkingRail />}
          {turnFixture !== null && <AgentTurnFixture mode={turnFixture} />}
          <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
        </AgentProfileProvider>
      </CreateChannelProvider>
    </SessionProvider>
  );
}
