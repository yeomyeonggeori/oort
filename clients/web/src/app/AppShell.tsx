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
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
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
      <CreateChannelProvider>
        <div className="app-shell">
          <Sidebar onOpenQuickSwitcher={() => setSwitcherOpen(true)} />
          <main className="flex min-h-0 min-w-0">
            <Outlet />
          </main>
        </div>
        {/* Global keyboard paths that must work from any route (R-1 §2). */}
        <InboxHotkeys />
        {/* Renders nothing; watches the rail so a mention or an approval request
         * reaches the OS while the window is in the background (MOMO-607). */}
        {!stress && <DesktopNotifications />}
        {/* Renders nothing; watches every agent's progress channel so the sidebar
         * badge and the composer line describe the same turn (MOMO-613). Exactly
         * one writer to the turn store is ever mounted. */}
        {!stress && turnFixture === null && <AgentWorkingRail />}
        {turnFixture !== null && <AgentTurnFixture mode={turnFixture} />}
        <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
      </CreateChannelProvider>
    </SessionProvider>
  );
}
