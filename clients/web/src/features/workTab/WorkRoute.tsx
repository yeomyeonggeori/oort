import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { SquareKanban } from "lucide-react";
import {
  TEAM_WORK_EMPTY,
  WORK_NAV,
  workViewOf,
} from "@momo/core/features/workbench/workTab";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Button } from "@/design/ui/button";
import { EmptyInvite } from "@/features/common/States";
import { SurfaceRoute } from "@/features/capabilities/SurfaceGate";
import { WorkConsoleRoute } from "@/features/workConsole/WorkConsoleRoute";
import { LocalTerminalDock } from "@/features/workbench/local/LocalTerminalDock";
import { isDesktop } from "@/lib/tauri";

// Reading this as: 작업 탭 라우트(`/work`) for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// 사이드바 「작업」 두 줄이 이 라우트 하나를 채운다(#2854, ADR-0194 D1, 코어
// `workTab.ts` 머리말).
//
// - `?view=team` → 「팀 작업」. 보드는 T11(#2863)이 세운다. 그 전에는 빈 상태다.
// - 데스크탑 `/work` → 「내 작업」 격자. 도크와 같은 세션·같은 배치를 그린다.
//   셸이 이 동안 도크를 내리고 앱 사이드바를 레일로 접는다(AppShell).
// - 그 밖(웹 `/work`, 세션 링크 `?session=`, 데스크탑 `?view=console`) → 작업 콘솔.
//   콘솔은 여전히 내가 쓸 수 있는 온라인 호스트가 있을 때만 선다(#2780, #2893).

export function WorkRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = workViewOf(location.search);
  const desktop = isDesktop();

  // 데스크탑에서 세션 링크(`/work?session=`)로 온 콘솔은 `view=console`을 붙여 둔다.
  // 콘솔이 목록으로 돌아가며 `session`만 지우면 주소가 `/work`, 곧 격자가 되어
  // 사람은 콘솔 목록 대신 다른 화면에 떨어진다.
  const needsConsoleView =
    desktop && view === "console" && !new URLSearchParams(location.search).has("view");
  useEffect(() => {
    if (!needsConsoleView) return;
    const params = new URLSearchParams(location.search);
    params.set("view", "console");
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
  }, [needsConsoleView, location.pathname, location.search, navigate]);

  if (view === "team") return <TeamWorkRoute />;
  if (desktop && view === "mine") return <LocalTerminalDock presentation="tab" />;
  return (
    <SurfaceRoute surface="workConsole">
      <WorkConsoleRoute />
    </SurfaceRoute>
  );
}

/** 「팀 작업」(시안 ④ `.mhd`). 보드(T11 #2863) 전까지는 한 문장 + 한 행동. */
export function TeamWorkRoute() {
  const navigate = useNavigate();
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="team-work-route">
      <header className="flex h-work-board-bar shrink-0 items-center gap-3 border-b border-line px-4">
        <SidebarDrawerToggle />
        <h1 className="flex min-w-0 items-center gap-2 text-title font-bold text-ink">
          <SquareKanban aria-hidden className="size-4 shrink-0 text-icon" />
          <span className="truncate">{WORK_NAV.team}</span>
        </h1>
        <p className="min-w-0 truncate text-meta text-ink-muted">공유된 세션만 보입니다</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyInvite
          headline={TEAM_WORK_EMPTY.title}
          detail={TEAM_WORK_EMPTY.body}
          testId="team-work-empty"
          actions={
            <Button
              type="button"
              size="sm"
              className="tap-target"
              data-testid="team-work-empty-action"
              onClick={() => navigate("/")}
            >
              {TEAM_WORK_EMPTY.action}
            </Button>
          }
        />
      </div>
    </div>
  );
}
