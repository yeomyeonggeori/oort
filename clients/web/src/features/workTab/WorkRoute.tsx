import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isMyWorkTab, workViewOf } from "@momo/core/features/workbench/workTab";
import { SurfaceRoute } from "@/features/capabilities/SurfaceGate";
import { WorkConsoleRoute } from "@/features/workConsole/WorkConsoleRoute";
import { ConnectedTerminalDock } from "@/features/workbench/agent/ConnectedTerminalDock";
import { WorkJobsRoute } from "@/features/workTab/jobs/WorkJobsRoute";
import { MyWorkWebNotice } from "@/features/workTab/MyWorkWebNotice";
import { isDesktop } from "@/lib/tauri";

// Reading this as: 작업 탭 라우트(`/work`) for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// ADR-0202 D6 (U1 #3842): 사이드바 「작업」 한 줄이 이 라우트를 채운다.
//
// - `/work`(옛 `?view=team`·`?view=mine` 포함) → 결과 중심 「작업」 화면. 「내 것 / 팀 전체」는
//   화면의 필터다(`?who=`, 옛 `?view=team`은 「팀 전체」).
// - 데스크탑 `?view=terminals` → 이 기기의 터미널 격자(옛 「내 작업」 본문). 셸이 이 동안 도크를
//   내리고 앱 사이드바를 레일로 접는다(AppShell). 웹은 터미널 레인이 없다는 설명 상태.
// - 세션 링크 `?session=`, `?view=console` → 작업 콘솔(진입점은 숨겼고 주소는 그대로 열린다).
//   콘솔은 여전히 내가 쓸 수 있는 온라인 호스트가 있을 때만 선다(#2780, #2893).
// - 옛 팀 보드 화면(`TeamBoardRoute`)은 코드로 남는다(D6 「숨김 = 진입점만」). 서랍은 새 화면이 쓴다.

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

  if (view === "jobs") return <WorkJobsRoute />;
  // 셸과 **같은 함수**로 판정한다: 셸이 도크를 내리는 바로 그때만 격자를 그린다.
  if (isMyWorkTab(location.pathname, location.search, desktop)) {
    return <ConnectedTerminalDock presentation="tab" />;
  }
  // 웹의 터미널 격자 주소(#3334): 로컬 터미널 레인이 없다는 이유와 「작업」으로 가는 길.
  if (view === "terminals") return <MyWorkWebNotice />;
  return (
    <SurfaceRoute surface="workConsole">
      <WorkConsoleRoute />
    </SurfaceRoute>
  );
}
