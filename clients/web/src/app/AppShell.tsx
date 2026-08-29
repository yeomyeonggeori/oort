import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { Outlet, useLocation } from "react-router-dom";
import type { LoginResponse, Member } from "@momo/core/lib/api";
import {
  createRealtime,
  resolveSpikeRealtimeUrl,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime";
import { SessionProvider } from "@/app/session";
import {
  ROUTE_REGION_DOM_ID,
  ShellNavProvider,
  useInertWhile,
  useIsMobileShell,
} from "@/app/shellNav";
import { restoreDialogOpenerFocus } from "@/design/ui/dialog";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { queryClient } from "@/app/queryClient";
import { resetRouteQueries } from "@/app/retryScope";
import { RenderErrorBoundary } from "@/features/common/RenderErrorBoundary";
import { ConnectionBanner } from "@/features/common/ConnectionBanner";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { AppTitlebar } from "@/app/AppTitlebar";
import { useSidebarCollapsePaint } from "@/app/useSidebarCollapsePaint";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
import { AddWorkspaceProvider } from "@/features/workspace/AddWorkspaceDialog";
import { AddChannelMemberProvider } from "@/features/channels/AddChannelMemberDialog";
import { AgentProfileProvider } from "@/features/routing/AgentProfileDialog";
import { MemberProfileProvider } from "@/features/directory/MemberProfileDialog";
import { InboxHotkeys } from "@/features/inbox/InboxHotkeys";
import { DesktopNotifications } from "@/features/notifications/DesktopNotifications";
import { AgentWorkingRail } from "@/features/agents/AgentWorkingRail";
import { AgentWorkPanel } from "@/features/agents/AgentWorkPanel";
import { useWorkPanelTarget } from "@/features/agents/workLogStore";
import { AgentTurnFixture } from "@/features/agents/AgentTurnFixture";
import { agentTurnFixtureMode } from "@/features/agents/turnFixture";
import { AdeSummaryLine } from "@/features/ade/AdeSummaryLine";
import { AdeDrawer } from "@/features/ade/AdeDrawer";
import {
  closeAdeDrawer,
  useAdeDrawerOpen,
} from "@/features/ade/adeDrawerStore";

// =============================================================================
// Signed-in shell: owns the single realtime rail for the session and renders
// the sidebar beside whichever route is active. Settings (#1867) still mounts
// inside this frame so the connection survives, but it replaces the app
// sidebar and titlebar with its own layout.
// =============================================================================

export function AppShell({
  session,
  onLogout,
  replaceSessionMember,
}: {
  session: LoginResponse;
  onLogout: () => void;
  replaceSessionMember: (member: Member) => void;
}) {
  const [realtime, setRealtime] = useState<RealtimeHandle | null>(null);
  const [connStatus, setConnStatus] = useState<RealtimeStatus>("connecting");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // 데스크톱 사이드바 접힘 (#1864). 저장소나 URL에 쓰지 않는 셸 수명 상태다:
  // 라우트를 오가는 동안은 선택을 지키되 새 창·새 로그인까지 과거의 접힌
  // 상태를 가져가지 않는다.
  const [sidebarPaneCollapsed, setSidebarPaneCollapsed] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const desktopToggleFocusedRef = useRef(false);
  // The route boundary resets when the user navigates: a failed channel must
  // not keep the next one from rendering.
  const routePath = useLocation().pathname;
  const isSettingsSurface = routePath === "/settings";

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
  const sidebarPaint = useSidebarCollapsePaint({
    collapsed: sidebarPaneCollapsed,
    asDrawer: isMobile,
    setCollapsed: setSidebarPaneCollapsed,
  });
  const previousMobileRef = useRef(isMobile);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  // 덮인 본문은 탭 순서에서 함께 빠진다. 이것이 초점 트랩이다 (shellNav.tsx).
  const mainRef = useInertWhile(isMobile && drawerOpen);
  // 작업 패널도 좁은 창에서는 라우트를 덮으므로 같은 규칙을 받는다. 문턱은
  // 사이드바 문턱(600px)이 아니라 tokens.css `work-panel-pane`의 900px이다:
  // 이 패널은 사이드바 옆 라우트 상자에 붙어서, 601px 창이면 라우트에 41px밖에
  // 남지 않는다. ChatShell이 작업 세션 패널에 같은 쿼리를 같은 이유로 쓴다.
  const workPanelOpen = useWorkPanelTarget() !== null;
  const [paneDrawerWidth, setPaneDrawerWidth] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(width < 900px)");
    const sync = () => setPaneDrawerWidth(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // ADE 관제 서랍(ADR-0154 D2)도 라우트를 덮으므로 같은 규칙을 받는다. 다만
  // 문턱이 없다: 이 서랍은 어느 폭에서든 절대 위치로 덮는다(tokens.css
  // `ade-drawer` — 열고 닫을 때 라우트를 밀지 않는 것이 그 유틸리티의 존재
  // 이유다). 셸이 이 상태에서 읽는 것은 이 불리언 하나뿐이라(스토어에 사는
  // 이유는 `adeDrawerStore` 주석) 시계가 셸을 다시 그리지 않는다.
  const adeDrawerOpen = useAdeDrawerOpen();
  const routeRef = useInertWhile<HTMLDivElement>(
    (paneDrawerWidth && workPanelOpen) || adeDrawerOpen
  );

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
  //
  // 관제 서랍도 **같은 판정**을 받는다 (design-review ADE 2단계 M2). 재료는
  // 워크스페이스 전역이라 "라우트를 옮겨도 이 목록은 여전히 참"이라고 말할 수는
  // 있지만, 참인 것과 그 자리에 있어야 하는 것은 다르다: 사이드바에서 채널을
  // 고르면(서랍은 라우트만 덮으므로 사이드바는 살아 있다) 방금 고른 그 채널이
  // 서랍 뒤에 가려진 채 열린다 — 위 서랍이 고치려던 그 결함 그대로다. 한 셸에
  // 서랍이 둘인데 규칙이 둘이면 사람은 어느 쪽도 못 배운다.
  useEffect(() => {
    setDrawerOpen(false);
    closeAdeDrawer();
  }, [routePath]);
  // 창이 넓어져 사이드바가 다시 열로 서면 서랍이라는 상태 자체가 사라진다.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // Esc로 닫는다. 캡처 단계·다이얼로그 예외·「Esc는 언제나 가장 위 층의 것」이라는
  // 규칙은 전부 `design/ui/escapeLayer`에 한 벌로 있다. 이 셸이 그 리스너를 직접
  // 달고 있던 동안, 같은 문장을 적어 둔 다른 두 층(작업 패널·관제 서랍)도 각자
  // 달았고, 같은 타깃 같은 단계의 리스너는 서로를 막지 못해 한 번의 Esc가 두 층을
  // 닫았다(design-review ADE 2단계 H1 ①). 스택이 그 문장을 자료구조로 만든다.
  useEscapeLayer(drawerOpen, closeDrawer);

  const onDesktopToggleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const next = event.relatedTarget;
    if (
      next instanceof HTMLElement &&
      next !== document.body &&
      next.getClientRects().length > 0
    ) {
      desktopToggleFocusedRef.current = false;
    }
  };

  // 폭이 서랍으로 바뀌면 타이틀바 토글이 `display: none`이 되어 포커스가
  // 고립된다. 그때만 폰 opener로 넘기고, 본문이 이미 살아 있는 포커스를
  // 갖고 있으면 빼앗지 않는다. 넓은 창으로 돌아오는 반대 왕복도 같다.
  useEffect(() => {
    const movedToDrawer = !previousMobileRef.current && isMobile;
    const returnedToDesktop = previousMobileRef.current && !isMobile;
    previousMobileRef.current = isMobile;
    const active = document.activeElement;
    const focusStranded =
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement && active.getClientRects().length === 0);
    if (isMobile) {
      if (movedToDrawer && desktopToggleFocusedRef.current && focusStranded) {
        const opener = document.querySelector<HTMLButtonElement>(
          '[data-testid="open-sidebar-drawer"]'
        );
        if (opener?.getClientRects().length) opener.focus();
      }
      desktopToggleFocusedRef.current = false;
      return;
    }
    if (!returnedToDesktop || !focusStranded) return;
    sidebarToggleRef.current?.focus();
  }, [isMobile]);

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
        replaceSessionMember,
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
      {/* 에이전트 라우팅도 같은 규칙이다(MOMO-626): 공용 멤버 프로필의 보조 액션,
       * 컴포저의 멘션 줄과 ⌘K가 하나의 다이얼로그를 연다. 진입점
       * 마다 다이얼로그를 두면 폼 상태가 세 벌이 되고 그중 하나는 낡는다. */}
      <ShellNavProvider value={{ isMobile, drawerOpen, openDrawer, closeDrawer }}>
      <CreateChannelProvider>
      {/* 워크스페이스 추가도 같은 규칙이다 (검수 피드백 #4a-2). 레일의 [+]가
       * 설정으로 새던 것을 하나의 다이얼로그로 모으고, 스위처·인박스 단축키가
       * 이 모달 위에서 물러설 수 있게 열림 상태를 함께 내린다. */}
      <AddWorkspaceProvider>
        {/* 채널에 멤버 추가 다이얼로그도 셸에 한 벌만 있다(검수 #2): 빈 채널의
         * 멤버 추가 진입점이 이 하나를 열고, 헤더 메뉴가 생기면 그것도 같은
         * 하나를 연다. 채널 만들기와 같은 이유로 폼 상태가 여러 벌이 되지
         * 않는다. (낱말은 #1573 예약 · #1584 — 이 주석을 인용하는 짝은
         * `packages/momo-core/src/features/timeline/model.ts` 머리말이다.) */}
        <AddChannelMemberProvider>
        <AgentProfileProvider>
        <MemberProfileProvider>
          <div
            ref={sidebarPaint.shellRef}
            className="app-shell"
            data-sidebar-collapsed={
              isSettingsSurface
                ? undefined
                : sidebarPaint.trackCollapsed
                  ? ""
                  : undefined
            }
            data-settings-surface={isSettingsSurface ? "" : undefined}
          >
            {!isSettingsSurface && (
              <AppTitlebar
                collapsed={sidebarPaneCollapsed}
                onCollapsedChange={sidebarPaint.requestCollapsedChange}
                toggleRef={sidebarToggleRef}
                onToggleFocus={() => {
                  desktopToggleFocusedRef.current = true;
                }}
                onToggleBlur={onDesktopToggleBlur}
              />
            )}
            {!isSettingsSurface && (
              <Sidebar
                onOpenQuickSwitcher={() => setSwitcherOpen(true)}
                channelPaneCollapsed={sidebarPaneCollapsed}
                treeHidden={sidebarPaint.treeHidden}
              />
            )}
            {/* 스크림은 사이드바 **다음**에 있어야 한다: 서랍이 열린 동안 탭이 갈
             * 수 있는 곳은 서랍과 이 버튼뿐이고(본문은 inert), DOM 순서가 곧 그
             * 순환이다. 아이콘도 글자도 없는 표면이지만 진짜 버튼인 이유는
             * 바깥을 눌러 닫는 것이 이 앱에서 유일하게 마우스로만 가능한 행동이
             * 되면 안 되기 때문이다. */}
            {isMobile && drawerOpen && !isSettingsSurface && (
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
              {!isSettingsSurface && <ConnectionBanner />}
              {/* ADE 관제 요약 한 줄 (ADR-0154 D2, 이슈 1135). 연결 배너와 같은
               * 자리에 있고 이유도 같다: 재료의 절반이 워크스페이스 전역이라
               * 채널 헤더에 두면 지금 보고 있는 방 밖의 작업이 화면에서 사라진다.
               * 살아 있는 작업이 없으면 이 컴포넌트는 아무것도 그리지 않는다 —
               * 빈 자리도 남기지 않는다(근거는 코어 `adeSummarySegments` 주석).
               * `?stress=N`은 합성 행만 그리는 순수 스크롤 측정이라 소켓도 REST도
               * 없다: 여기서 원장을 부르면 그 측정이 네트워크까지 재게 된다. */}
              {!stress && !isSettingsSurface && <AdeSummaryLine />}
              {/* 라우트 하나가 던져도 사이드바·⌘K·설정·로그아웃은 살아 있어야
               * 한다. 앱 루트 경계만 있으면 채팅에서 난 오류가 셸을 통째로
               * 지워 사용자가 다른 화면으로 갈 길까지 사라진다. 실패는 그것을
               * 소유한 표면 안에 머문다. */}
              {/* `relative`는 폰 폭에서 작업 패널이 라우트를 덮을 때 필요한
               * 앵커다(tokens.css `work-panel-pane`). 채팅 표면은 자기 안에 같은
               * 앵커를 이미 갖고 있으므로 스레드·작업 세션 패널의 자리는 그대로다. */}
              <div className="relative flex min-h-0 min-w-0 flex-1">
                {/* `tabIndex={-1}`은 탭 순서에 자리를 만들지 않는다. 층이 닫힐 때
                 * 캐럿이 돌아갈 컨트롤이 사라져 있으면(관제 요약 줄은 작업이 0이
                 * 되면 DOM에서 빠진다) 그 층이 여기로 캐럿을 놓는다 — <body>로
                 * 떨어뜨리는 대신(shellNav `ROUTE_REGION_DOM_ID`). */}
                {/* `route-region`은 `min-w-0`을 대신한다(tokens.css): 같은 축을
                 * 두 곳에서 적으면 순서가 이기고, 이 상자에는 위쪽 상한(내용에
                 * 밀리지 않는다)과 아래쪽 바닥(작업 패널이 컴포저를 바닥 아래로
                 * 밀지 못한다, #1413)이 함께 필요하다. */}
                <div
                  ref={routeRef}
                  id={ROUTE_REGION_DOM_ID}
                  tabIndex={-1}
                  className="route-region flex min-h-0 flex-1"
                >
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
                {!stress && !isSettingsSurface && <AgentWorkPanel />}
                {/* 관제 서랍은 라우트 상자를 덮는다(tokens.css `ade-drawer`).
                 * 작업 패널과 형제인 것이 요점이다: 카드를 누르면 서랍이 닫히고
                 * 그 자리에 패널이 서므로 둘이 겹쳐 있는 순간이 없다. */}
                {!stress && adeDrawerOpen && !isSettingsSurface && <AdeDrawer />}
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
        </MemberProfileProvider>
        </AgentProfileProvider>
        </AddChannelMemberProvider>
      </AddWorkspaceProvider>
      </CreateChannelProvider>
      </ShellNavProvider>
    </SessionProvider>
  );
}
