import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Inbox, MessageSquare, SquareTerminal, Users } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  MY_WORK_PATH,
  TEAM_WORK_PATH,
  WORK_NAV,
} from "@momo/core/features/workbench/workTab";

// Reading this as: 작업 탭 레일(앱 사이드바가 접힌 모양) for internal team users on
// Tauri desktop, density 7/10, motion 0/10.
//
// 시안 ① `.rail`(#2854): 데스크탑 「내 작업」 격자에서 앱 사이드바는 이 64px 열로
// 접힌다. 목적지는 채널 목록의 전역 줄과 같은 넷이고, 이름도 그 줄과 같다
// (#1146 N4). 세로 아이콘+글자 단추에는 shadcn/Radix 프리미티브가 없어 NavLink로
// 손으로 그린다(워크스페이스 레일과 같은 이유). 프로필 단추는 셸이 `footer`로 넣는다.

function RailLink({
  to,
  icon,
  label,
  testId,
  isActive,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  testId: string;
  /** 쿼리까지 봐야 하는 목적지(내 작업·팀 작업)는 셸이 판정을 넘긴다. */
  isActive?: boolean;
}) {
  return (
    <li>
      <NavLink
        to={to}
        end
        data-testid={testId}
        // NavLink는 경로만 본다: 「팀 작업」(`/work?view=team`)도 `/work`에서 켜진다.
        aria-current={isActive === undefined ? undefined : isActive ? "page" : false}
        className={({ isActive: routeActive }) =>
          cn(
            "work-rail-item focus-visible:focus-ring active:bg-surface-pressed",
            (isActive ?? routeActive)
              ? "band-surface work-rail-item-selected"
              : "hover:bg-surface-hover hover:text-ink"
          )
        }
      >
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
      </NavLink>
    </li>
  );
}

export function WorkRail({ footer }: { footer?: ReactNode }) {
  return (
    <div
      data-testid="work-rail"
      className="flex h-full w-work-rail shrink-0 flex-col items-center gap-2 pb-3"
    >
      <nav aria-label="앱 탐색" className="flex flex-col items-center">
        <ul className="flex flex-col items-center gap-2">
          <RailLink to="/" icon={<MessageSquare />} label="대화" testId="work-rail-chat" isActive={false} />
          <RailLink to="/inbox" icon={<Inbox />} label="인박스" testId="work-rail-inbox" />
          <RailLink to={MY_WORK_PATH} icon={<SquareTerminal />} label={WORK_NAV.mine} testId="work-rail-mine" isActive />
          <RailLink to={TEAM_WORK_PATH} icon={<Users />} label={WORK_NAV.team} testId="work-rail-team" isActive={false} />
        </ul>
      </nav>
      <span className="flex-1" />
      {footer}
    </div>
  );
}
