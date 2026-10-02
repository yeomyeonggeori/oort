import { Activity, Bot, Inbox, MessageSquare, Milestone, ServerCog, SquareKanban, SquareTerminal, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { NeedsMe } from "@momo/core/features/inbox/needsMe";
import {
  isSurfaceProvided,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import {
  MY_WORK_PATH,
  TEAM_WORK_PATH,
  WORK_CONSOLE_VIEW_PATH,
  WORK_NAV,
} from "@momo/core/features/workbench/workTab";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import { DraftsNavItem } from "@/features/drafts/DraftsNavItem";
import { useLocalPaneAttention } from "@/features/workbench/local/paneAttention";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { AGENTS_NAV } from "./workspaceNav";
import { AGENT_WORK_SECTION_ID, type SidebarDestinationActive } from "./sidebarDestinationsModel";
import {
  setSidebarSectionCollapsed,
  useSidebarSectionsCollapsed,
} from "./sidebarSectionPreference";

// =============================================================================
// 목록 열의 머리(#3334): 「검색과 이동」 바로 아래의 목적지 두 구획.
//
//   구획 A  대화 · 인박스 · 멤버(초안이 있으면 초안)
//   구획 B  「에이전트·작업」 — 에이전트 · 내 작업 · 팀 작업 · 활동(+ 서버가 싣는 작업
//           콘솔·작업 흐름) · 지금 도는 세션 줄
//
// 이 머리는 **모든 탭에서 같은 노드·같은 자리**다. 탭이 바뀌어도 바뀌는 것은 이 아래의 본문
// (채널·DM ↔ 내 작업 세션 목록 ↔ 팀 세션 목록)뿐이다: 「탭을 옮기면 왼쪽 크롬이 통째로
// 바뀐다」(#3275/#3280)는 불만의 재발 방지다. 그래서 이 컴포넌트는 라우트를 읽어 줄을
// 더하고 빼지 않는다 — 읽는 것은 선택 표시와 배지뿐이다. (`가용성`에 따라 서는 줄 —
// 서버가 안 싣는 작업 콘솔·작업 흐름, 있을 때만 서는 초안 — 은 라우트가 아니라 서버·데이터의
// 사실이다.)
//
// 「메시지 검색」 줄은 없다: ⌘K 「검색과 이동」이 메시지 본문까지 덮는다(성재 2026-10-02).
// 레일은 펼친 동안 워크스페이스 전용이고, ⌘B로 이 열이 접히면 레일이 같은 목적지 아이콘을
// 이어 붙인다(`WorkspaceRail`).
// =============================================================================

export function SidebarDestinations({
  active,
  needsMe,
  workConsoleProvided,
  nowCard,
}: {
  active: SidebarDestinationActive;
  needsMe: NeedsMe;
  workConsoleProvided: boolean;
  /** 지금 도는 에이전트 턴 카드(`SidebarNowCard`). 열린 턴이 없으면 아무것도 그리지 않는다. */
  nowCard?: ReactNode;
}) {
  const collapsedSections = useSidebarSectionsCollapsed();
  const paneEntries = useLocalPaneAttention();
  // 웹에는 로컬 터미널 레인이 없어(ADR-0190 D1) 칸이 있어도 세지 않는다. needsMe가 이미
  // 데스크탑 판정을 거친 수(`panes`)를 준다.
  const waitingPanes = paneEntries.filter((e) => e.status === "waiting" && needsMe.panes > 0);
  return (
    <div data-testid="sidebar-destinations" className="flex min-w-0 flex-col">
      <nav aria-label="워크스페이스 탐색">
        <ul className="sidebar-stack">
          <SidebarRow to="/" icon={<MessageSquare className="size-4" />} label="대화" testId="nav-chat" isActive={active.chat} />
          <SidebarRow
            to="/inbox"
            icon={<Inbox className="size-4" />}
            label="인박스"
            testId="nav-inbox"
            isActive={active.inbox}
            mentionCount={needsMe.total}
            badgeLabel={needsMe.total > 0 ? `나에게 필요한 일 ${needsMe.total}개` : undefined}
          />
          <SidebarRow to="/directory" icon={<Users className="size-4" />} label="멤버" testId="nav-directory" isActive={active.directory} />
          <DraftsNavItem />
        </ul>
      </nav>
      <SidebarSection
        title="에이전트·작업"
        sectionId={AGENT_WORK_SECTION_ID}
        collapsed={collapsedSections[AGENT_WORK_SECTION_ID] === true}
        onCollapsedChange={(next) => setSidebarSectionCollapsed(AGENT_WORK_SECTION_ID, next)}
        mentionCount={needsMe.panes}
      >
        <SidebarRow to={AGENTS_NAV.to} icon={<Bot className="size-4" />} label={AGENTS_NAV.label} testId="nav-agents" isActive={active.agents} />
        <SidebarRow
          to={MY_WORK_PATH}
          icon={<SquareTerminal className="size-4" />}
          label={WORK_NAV.mine}
          testId="nav-mine"
          isActive={active.mine}
          mentionCount={needsMe.panes}
          badgeLabel={needsMe.panes > 0 ? `응답이 필요한 세션 ${needsMe.panes}개` : undefined}
        />
        <SidebarRow to={TEAM_WORK_PATH} icon={<SquareKanban className="size-4" />} label={WORK_NAV.team} testId="nav-team" isActive={active.team} />
        <SidebarRow to="/activity" icon={<Activity className="size-4" />} label="활동" testId="nav-activity" isActive={active.activity} />
        {/* TC-1 (#1758): 전역 작업 세션 목록. 표면 삭제 금지 — 셀프호스트 기본은 진입점만
            접는다(#2166). #2780: 온라인 호스트 유무로 펼친다(useSurfaceProvided). 콘솔은
            데스크탑·웹 모두 `?view=console`에 선다(#3334: 웹의 `/work`는 「내 작업」 설명 상태). */}
        {workConsoleProvided && (
          <SidebarRow
            to={WORK_CONSOLE_VIEW_PATH}
            icon={<ServerCog className="size-4" />}
            label={serverSurface("workConsole").label}
            testId="nav-work-console"
            isActive={active.console}
          />
        )}
        {/* 작업 흐름(MOMO-652, ADR-0143): 이 서버가 싣지 않으면 줄 자체를 세우지 않는다
            (goal B12) — 없는 것은 권한이 아니라 기능이다. */}
        {isSurfaceProvided("workstreams") && (
          <SidebarRow to="/workstreams" icon={<Milestone className="size-4" />} label={serverSurface("workstreams").label} testId="nav-workstreams" isActive={active.workstreams} />
        )}
        {waitingPanes.slice(0, 3).map((entry) => (
          <li key={entry.paneId}>
            <Link
              to={MY_WORK_PATH}
              data-testid="sidebar-live-pane"
              data-status={entry.status}
              className="sidebar-row flex w-full items-center gap-2 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
            >
              <span className={cn(CHIP_CLASS, "bg-warn-soft text-warn")}>응답 필요</span>
              <span className="min-w-0 truncate text-meta text-ink">{entry.name} · 이 기기</span>
            </Link>
          </li>
        ))}
      </SidebarSection>
      {nowCard ? <div>{nowCard}</div> : null}
    </div>
  );
}
