import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import type { LoginResponse } from "@momo/core/lib/api";
import {
  createRealtime,
  resolveSpikeRealtimeUrl,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime";
import { SessionProvider } from "@/app/session";
import {
  ShellNavProvider,
  useInertWhile,
  useIsMobileShell,
} from "@/app/shellNav";
import { restoreDialogOpenerFocus } from "@/design/ui/dialog";
import { queryClient } from "@/app/queryClient";
import { resetRouteQueries } from "@/app/retryScope";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { ConnectionBanner } from "@/features/common/ConnectionBanner";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
import { AgentProfileProvider } from "@/features/routing/AgentProfileDialog";
import { InboxHotkeys } from "@/features/inbox/InboxHotkeys";
import { DesktopNotifications } from "@/features/notifications/DesktopNotifications";
import { AgentWorkingRail } from "@/features/agents/AgentWorkingRail";
import { AgentWorkPanel } from "@/features/agents/AgentWorkPanel";
import { useWorkPanelTarget } from "@/features/agents/workLogStore";
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

  // ── 사이드바 서랍 (goal B6) ────────────────────────────────────────────────
  //
  // 폰 폭에서 사이드바는 열이 아니라 채널 표면을 덮는 서랍이다(tokens.css
  // `sidebar-drawer`). 상태는 여기 한 벌만 있고, 여는 컨트롤은 각 표면의 헤더가
  // `SidebarDrawerToggle`로 그린다.
  const isMobile = useIsMobileShell();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  // 덮인 본문은 탭 순서에서 함께 빠진다. 이것이 초점 트랩이다 (shellNav.tsx).
  const mainRef = useInertWhile(isMobile && drawerOpen);
  // 작업 패널도 폰 폭에서는 라우트를 덮으므로 같은 규칙을 받는다. 두 문턱이
  // 우연히 같은 것이 아니라 같은 값이다(MOBILE_SHELL_QUERY = work-panel-pane).
  const workPanelOpen = useWorkPanelTarget() !== null;
  const routeRef = useInertWhile<HTMLDivElement>(isMobile && workPanelOpen);

  const openDrawer = useCallback((opener?: HTMLElement | null) => {
    drawerOpenerRef.current = opener ?? null;
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    const opener = drawerOpenerRef.current;
    drawerOpenerRef.current = null;
    // 캐럿은 서랍을 연 컨트롤로 돌아간다. 그 컨트롤은 방금까지 `inert`였던 본문
    // 안에 있고 React는 이 커밋이 끝나야 속성을 걷으므로, 여기서 먼저 걷는다
    // (WorkPanel.onClose가 같은 순서를 지키는 이유와 같다). 아래 효과가 다시
    // 맞추면서 할 일이 없다는 것을 확인한다.
    mainRef.current?.removeAttribute("inert");
    restoreDialogOpenerFocus(opener);
  }, [mainRef]);

  // 표면을 옮기면 서랍은 할 일을 마쳤다. 채널을 고르는 것이 이 서랍의 유일한
  // 목적이므로, 고른 뒤에도 덮여 있으면 방금 연 채널을 가린 채 남는다.
  useEffect(() => setDrawerOpen(false), [routePath]);
  // 창이 넓어져 사이드바가 다시 열로 서면 서랍이라는 상태 자체가 사라진다.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // Esc로 닫는다. **캡처 단계**에서 듣고 전파를 멈추는 것이 이 핸들러의 요점이다:
  // 설정 라우트도 window에서 Esc를 듣고 뒤로 가는데(SettingsRoute), 그 리스너는
  // 마운트 시점이 더 빨라 버블 단계에서 먼저 실행된다. 그대로 두면 서랍을 닫으려
  // 누른 Esc 한 번이 설정에서 빠져나가는 것까지 함께 해버린다. 캡처 리스너는
  // 대상에 닿기 전에 돌므로, 덮고 있는 층이 먼저 자기 것을 가져간다.
  //
  // 다이얼로그가 열려 있으면 비켜준다: 그때 가장 위에 있는 층은 서랍이 아니라
  // 그 다이얼로그이고(⌘K 팔레트, 채널 만들기, 에이전트 프로필 모두 Radix라
  // `[role=dialog][data-state=open]`으로 한 번에 알 수 있다), Esc는 언제나 가장
  // 위 층의 것이다.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.stopPropagation();
      event.preventDefault();
      closeDrawer();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drawerOpen, closeDrawer]);

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
      <ShellNavProvider value={{ isMobile, drawerOpen, openDrawer, closeDrawer }}>
      <CreateChannelProvider>
        <AgentProfileProvider>
          <div className="app-shell">
            <Sidebar onOpenQuickSwitcher={() => setSwitcherOpen(true)} />
            {/* 스크림은 사이드바 **다음**에 있어야 한다: 서랍이 열린 동안 탭이 갈
             * 수 있는 곳은 서랍과 이 버튼뿐이고(본문은 inert), DOM 순서가 곧 그
             * 순환이다. 아이콘도 글자도 없는 표면이지만 진짜 버튼인 이유는
             * 바깥을 눌러 닫는 것이 이 앱에서 유일하게 마우스로만 가능한 행동이
             * 되면 안 되기 때문이다. */}
            {isMobile && drawerOpen && (
              <button
                type="button"
                className="sidebar-scrim"
                onClick={closeDrawer}
                aria-label="채널 목록 닫기"
                data-testid="sidebar-scrim"
              />
            )}
            <main ref={mainRef} className="flex min-h-0 min-w-0 flex-col">
              {/* 실시간이 죽었다는 사실은 채널만의 사실이 아니다 (goal B8 B2):
               * 인박스도 활동도 갱신이 멈추고, 조용한 하루와 구별되지 않는다.
               * 그래서 이 줄은 라우트 위, 셸 안에 한 벌만 있다. */}
              <ConnectionBanner />
              {/* 라우트 하나가 던져도 사이드바·⌘K·설정·로그아웃은 살아 있어야
               * 한다. 앱 루트 경계만 있으면 채팅에서 난 오류가 셸을 통째로
               * 지워 사용자가 다른 화면으로 갈 길까지 사라진다. 실패는 그것을
               * 소유한 표면 안에 머문다. */}
              {/* `relative`는 폰 폭에서 작업 패널이 라우트를 덮을 때 필요한
               * 앵커다(tokens.css `work-panel-pane`). 채팅 표면은 자기 안에 같은
               * 앵커를 이미 갖고 있으므로 스레드·작업 세션 패널의 자리는 그대로다. */}
              <div className="relative flex min-h-0 min-w-0 flex-1">
                <div ref={routeRef} className="flex min-h-0 min-w-0 flex-1">
                  <RenderErrorBoundary
                    resetKey={routePath}
                    title="이 화면을 열지 못했습니다"
                    message="서버에서 받은 내용을 읽지 못했습니다. 다른 화면은 그대로 쓸 수 있습니다."
                    retryLabel="다시 시도"
                    onRetry={() => resetRouteQueries(queryClient)}
                  >
                    <Outlet />
                  </RenderErrorBoundary>
                </div>
                {/* 작업 패널(goal WEB-WP1)은 라우트 옆에 한 벌만 있다. 진입점이
                 * 대화 활동 줄과 에이전트 허브 둘이라 어느 한 라우트 안에 두면
                 * 다른 쪽에서 열 수 없고, 두 벌을 두면 같은 run에 대해 두 로그가
                 * 생긴다. */}
                {!stress && <AgentWorkPanel />}
              </div>
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
      </ShellNavProvider>
    </SessionProvider>
  );
}
