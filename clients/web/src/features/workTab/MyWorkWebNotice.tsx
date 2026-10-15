import { Link } from "react-router-dom";
import { SquareTerminal } from "lucide-react";
import { WORK_NAV, WORK_PATH } from "@momo/core/features/workbench/workTab";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Button } from "@/design/ui/button";

// Reading this as: 웹의 터미널 격자 주소 설명 상태(#3334, ADR-0202 D6 뒤 `?view=terminals`), density 3/10, motion 0/10.
//
// 「내 작업」은 이 기기의 터미널 세션 격자라 데스크탑 앱에만 있다(ADR-0190 D1: PTY는
// 데스크탑 앱 프로세스). 웹에서 줄이 사라지면 「어디로 갔는지 모르겠다」(성재 2026-10-02)가
// 되므로, 줄은 웹에서도 보이고 누르면 이유를 한 줄로 말하고 갈 수 있는 곳(팀 작업)을 준다.
// 줄이 있고 이유가 읽히는 편이 줄이 사라지는 것보다 낫다.
export function MyWorkWebNotice() {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="my-work-web-notice">
      <header className="flex h-work-board-bar shrink-0 items-center gap-3 border-b border-line px-4">
        <SidebarDrawerToggle />
        <h1 className="flex min-w-0 items-center gap-2 text-title font-bold text-ink">
          <SquareTerminal aria-hidden className="size-4 shrink-0 text-icon" />
          <span className="truncate">{WORK_NAV.mine}</span>
        </h1>
      </header>
      <div className="flex break-keep flex-col items-start gap-3 px-4 py-6">
        <p className="text-body font-medium text-ink">이 기기에는 터미널 레인이 없어요</p>
        <p className="text-body text-ink-muted">
          이 기기 터미널은 oort 데스크탑 앱에서 이 컴퓨터의 터미널 세션을 모아 보여 줘요. 웹에서는
          에이전트에게 맡긴 일과 결과를 작업에서 볼 수 있어요.
        </p>
        <Button asChild variant="secondary">
          <Link to={WORK_PATH} data-testid="my-work-web-notice-team-link">
            작업 보기
          </Link>
        </Button>
      </div>
    </div>
  );
}
