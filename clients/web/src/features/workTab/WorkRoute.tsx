import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isMyWorkTab, workViewOf } from "@momo/core/features/workbench/workTab";
import { SurfaceRoute } from "@/features/capabilities/SurfaceGate";
import { WorkConsoleRoute } from "@/features/workConsole/WorkConsoleRoute";
import { ConnectedTerminalDock } from "@/features/workbench/agent/ConnectedTerminalDock";
import { TeamBoardRoute } from "@/features/workTab/teamBoard/TeamBoardRoute";
import { MyWorkWebNotice } from "@/features/workTab/MyWorkWebNotice";
import { isDesktop } from "@/lib/tauri";

// Reading this as: 작업 탭 라우트(`/work`) for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// 사이드바 「작업」 두 줄이 이 라우트 하나를 채운다(#2854, ADR-0194 D1, 코어
// `workTab.ts` 머리말).
//
// - `?view=team` → 「팀 작업」 보드(T11 #2863, `teamBoard/`). 공유된 세션만, 서버가 거른 대로.
// - 데스크탑 `/work` → 「내 작업」 격자. 도크와 같은 세션·같은 배치를 그린다.
//   셸이 이 동안 도크를 내리고 앱 사이드바를 레일로 접는다(AppShell).
// - 웹 `/work` → 「내 작업」 설명 상태(#3334, 이 기기에는 터미널 레인이 없어요 + 팀 작업 링크).
// - 그 밖(세션 링크 `?session=`, `?view=console`) → 작업 콘솔.
//   콘솔은 여전히 내가 쓸 수 있는 온라인 호스트가 있을 때만 선다(#2780, #2893).

export function WorkRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = workViewOf(location.search);
  const desktop = isDesktop();

  // 세션 링크(`/work?session=`)로 온 콘솔은 `view=console`을 붙여 둔다.
  // 콘솔이 목록으로 돌아가며 `session`만 지우면 주소가 `/work`, 곧 데스크탑은 격자·웹은
  // 설명 상태가 되어 사람은 콘솔 목록 대신 다른 화면에 떨어진다(#3334).
  const needsConsoleView =
    view === "console" && !new URLSearchParams(location.search).has("view");
  useEffect(() => {
    if (!needsConsoleView) return;
    const params = new URLSearchParams(location.search);
    params.set("view", "console");
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
  }, [needsConsoleView, location.pathname, location.search, navigate]);

  if (view === "team") return <TeamBoardRoute />;
  // 셸과 **같은 함수**로 판정한다: 셸이 도크를 내리는 바로 그때만 격자를 그린다.
  if (isMyWorkTab(location.pathname, location.search, desktop)) {
    return <ConnectedTerminalDock presentation="tab" />;
  }
  // 웹의 「내 작업」(`/work`, #3334): 로컬 터미널 레인이 없다는 이유와 팀 작업으로 가는 길.
  // 작업 콘솔은 `?view=console`(사이드바 「작업 콘솔」 줄)과 세션 링크(`?session=`)가 연다.
  if (view === "mine") return <MyWorkWebNotice />;
  return (
    <SurfaceRoute surface="workConsole">
      <WorkConsoleRoute />
    </SurfaceRoute>
  );
}
