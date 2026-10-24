import { Bot, Clock, Inbox, ListChecks, Sparkles, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { NeedsMe } from "@momo/core/features/inbox/needsMe";
import {
  LOCAL_TERMINALS_PATH,
  WORK_NAV,
  WORK_PATH,
} from "@momo/core/features/workbench/workTab";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import { scheduledNavEntry } from "@momo/core/features/scheduled/model";
import { DraftsNavItem } from "@/features/drafts/DraftsNavItem";
import { useScheduled } from "@/features/scheduled/useScheduled";
import { useLocalPaneAttention } from "@/features/workbench/local/paneAttention";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { AGENTS_NAV, AI_HUB_NAV } from "./workspaceNav";
import { SessionStateChip } from "./SessionStateChip";
import { destinationMarks } from "./sidebarBadge";
import { AGENT_WORK_SECTION_ID, type SidebarDestinationActive } from "./sidebarDestinationsModel";
import {
  setSidebarSectionCollapsed,
  useSidebarSectionsCollapsed,
} from "./sidebarSectionPreference";

// =============================================================================
// 목록 열의 머리(#3334): 「검색과 이동」 바로 아래의 목적지 두 구획.
//
//   구획 A  인박스 · 멤버(초안이 있으면 초안, 예약이 있으면 예약됨) — 「대화」 줄은 #3662로 없앴다: 채널·DM 목록이
//           바로 아래에 서 있어 `/`로 가는 두 번째 문은 쓸모가 없었다(성재 2026-10-10)
//   구획 B  「에이전트·작업」 — AI(허브, AIH-3) · 에이전트 · 작업 · 지금 도는 세션 줄
//           (ADR-0202 D6: 내 작업·팀 작업·활동·작업 콘솔·작업 흐름 다섯 줄이 「작업」 한 줄이 됐다.
//           라우트와 화면 코드는 남는다: 옛 링크는 계속 열리고, 진입점만 숨겼다.)
//
// 이 머리는 **모든 탭에서 같은 노드·같은 자리**다. 탭이 바뀌어도 바뀌는 것은 이 아래의 본문
// (채널·DM ↔ 내 작업 세션 목록 ↔ 팀 세션 목록)뿐이다: 「탭을 옮기면 왼쪽 크롬이 통째로
// 바뀐다」(#3275/#3280)는 불만의 재발 방지다. 그래서 이 컴포넌트는 라우트를 읽어 줄을
// 더하고 빼지 않는다 — 읽는 것은 선택 표시와 배지뿐이다. (있을 때만 서는 초안은 라우트가
// 아니라 데이터의 사실이다.)
//
// 「메시지 검색」 줄은 없다: ⌘K 「검색과 이동」이 메시지 본문까지 덮는다(성재 2026-10-02).
// 레일은 펼친 동안 워크스페이스 전용이고, ⌘B로 이 열이 접히면 레일이 같은 목적지 아이콘을
// 이어 붙인다(`WorkspaceRail`).
// =============================================================================

export function SidebarDestinations({
  active,
  needsMe,
  nowCard,
  unreadChannels = 0,
}: {
  active: SidebarDestinationActive;
  needsMe: NeedsMe;
  /**
   * 안 읽은 채널 수. 펼친 목록에는 줄이 없다(아래 채널·DM 줄이 수를 말한다). 접힌 레일의 대화 점과
   * 같은 입력이라 여기서도 같은 `destinationMarks`로 한 번에 푼다.
   */
  unreadChannels?: number;
  /** 지금 도는 에이전트 턴 카드(`SidebarNowCard`). 열린 턴이 없으면 아무것도 그리지 않는다. */
  nowCard?: ReactNode;
}) {
  const collapsedSections = useSidebarSectionsCollapsed();
  const paneEntries = useLocalPaneAttention();
  // 웹에는 로컬 터미널 레인이 없어(ADR-0190 D1) 칸이 있어도 세지 않는다. needsMe가 이미
  // 데스크탑 판정을 거친 수(`panes`)를 준다.
  const waitingPanes = paneEntries.filter((e) => e.status === "waiting" && needsMe.panes > 0);
  // 아직 안 본 끝남(「끝남」은 칸을 보면 내려간다, `paneAttention`). 웹에는 칸이 없어 비어 있다.
  const donePanes = paneEntries.filter((e) => e.status === "done");
  // 「예약됨」 줄(ADR-0208): 보낼 예정 또는 보내지 못함이 있을 때만 선다. 알약은 보내지 못한 예약의 수다.
  const scheduled = useScheduled();
  const scheduledNav = scheduledNavEntry(scheduled.surface === "absent" ? [] : scheduled.rows);
  const marks = destinationMarks({
    needsMe,
    unreadChannels,
    doneUnseen: donePanes.length > 0,
    scheduledFailed: scheduledNav.failedCount,
  });
  // 구획 B의 지금 도는 세션 줄: 응답 필요가 먼저, 안 본 끝남이 뒤. 최대 셋.
  const liveRows = [...waitingPanes, ...donePanes].slice(0, 3);
  return (
    <div data-testid="sidebar-destinations" className="flex min-w-0 flex-col">
      <nav aria-label="워크스페이스 탐색">
        <ul className="sidebar-stack">
          <SidebarRow
            to="/inbox"
            icon={<Inbox className="size-4" />}
            label="인박스"
            testId="nav-inbox"
            isActive={active.inbox}
            mentionCount={marks.inbox.pill?.count ?? 0}
            badgeLabel={needsMe.total > 0 ? `나에게 필요한 일 ${needsMe.total}개` : undefined}
          />
          <SidebarRow to="/directory" icon={<Users className="size-4" />} label="멤버" testId="nav-directory" isActive={active.directory} />
          <DraftsNavItem />
          {scheduledNav.visible && (
            <SidebarRow
              to="/scheduled"
              icon={<Clock className="size-4" />}
              label={SCHEDULED_COPY.nav.label}
              testId="nav-scheduled"
              mentionCount={marks.scheduled.pill?.count ?? 0}
              badgeLabel={scheduledNav.badgeLabel ?? undefined}
            />
          )}
        </ul>
      </nav>
      <SidebarSection
        title="에이전트·작업"
        sectionId={AGENT_WORK_SECTION_ID}
        collapsed={collapsedSections[AGENT_WORK_SECTION_ID] === true}
        onCollapsedChange={(next) => setSidebarSectionCollapsed(AGENT_WORK_SECTION_ID, next)}
        mentionCount={marks.mine.pill?.count ?? 0}
        dot={marks.mine.dot}
      >
        <SidebarRow to={AI_HUB_NAV.to} icon={<Sparkles className="size-4" />} label={AI_HUB_NAV.label} testId="nav-ai" isActive={active.ai} />
        <SidebarRow to={AGENTS_NAV.to} icon={<Bot className="size-4" />} label={AGENTS_NAV.label} testId="nav-agents" isActive={active.agents} />
        {/* 「작업」 한 줄(ADR-0202 D6). 배지·점은 옛 「내 작업」의 것 그대로다(응답 필요 칸·안 본 끝남). */}
        <SidebarRow
          to={WORK_PATH}
          icon={<ListChecks className="size-4" />}
          label={WORK_NAV.work}
          testId="nav-work"
          isActive={active.work}
          mentionCount={marks.mine.pill?.count ?? 0}
          dot={marks.mine.dot}
          badgeLabel={
            needsMe.panes > 0
              ? `응답이 필요한 세션 ${needsMe.panes}개`
              : marks.mine.dot === "ok"
                ? "아직 안 본 끝난 세션이 있어요"
                : undefined
          }
        />
        {liveRows.map((entry) => (
          <li key={entry.paneId}>
            <Link
              to={LOCAL_TERMINALS_PATH}
              data-testid="sidebar-live-pane"
              data-status={entry.status}
              className="sidebar-row flex w-full items-center gap-2 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
            >
              <SessionStateChip status={entry.status} testId="sidebar-live-pane-chip" />
              <span
                className={
                  entry.status === "waiting"
                    ? "min-w-0 truncate text-meta font-semibold text-ink"
                    : "min-w-0 truncate text-meta text-ink"
                }
              >
                {entry.name} · 이 기기
              </span>
            </Link>
          </li>
        ))}
      </SidebarSection>
      {nowCard ? <div>{nowCard}</div> : null}
    </div>
  );
}
