import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { uuidEq } from "@momo/core/lib/api";
import { sessionTitle, stateChipLabel, whereLabel } from "@momo/core/features/workbench/teamBoard";
import { filterTeamSessions, TEAM_FILTER_LABEL, type TeamFilter } from "./teamSessionsModel";
import { TEAM_WORK_PATH } from "@momo/core/features/workbench/workTab";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { SessionStateChip } from "./SessionStateChip";
import { useTeamBoardList } from "@/features/workTab/teamBoard/useTeamBoard";

// =============================================================================
// 목록 열 본문 — 「팀 작업」 탭(#3334). 고정 머리(`SidebarDestinations`) 아래에서 채널·DM 대신
// 팀이 공유한 세션을 보인다(필터 칩: 전체 · 내 것 · 응답 필요). 보드와 **같은 읽기**
// (`useTeamBoardList`, 같은 쿼리 키)라 요청이 늘지 않고 둘이 다르게 말할 수 없다. 줄을 누르면
// 보드의 드로어가 열린다(`?card=`). 이것은 길잡이이고 두 번째 보드가 아니다: 터미널 원문도
// 입력도 없다.
// =============================================================================

const FILTER_LABEL = TEAM_FILTER_LABEL;

export function SidebarTeamSessions() {
  const { session, workspaceId } = useSession();
  const list = useTeamBoardList(workspaceId);
  const [params] = useSearchParams();
  const openId = params.get("card");
  const [filter, setFilter] = useState<TeamFilter>("all");
  const selfId = session.member.id;
  const counts = useMemo(
    () => ({
      all: filterTeamSessions(list.items, "all", selfId).length,
      mine: filterTeamSessions(list.items, "mine", selfId).length,
      waiting: filterTeamSessions(list.items, "waiting", selfId).length,
    }),
    [list.items, selfId]
  );
  const rows = useMemo(
    () => filterTeamSessions(list.items, filter, selfId),
    [list.items, filter, selfId]
  );
  const firstLoad = list.isPending && list.data === undefined;

  return (
    <div className="sidebar-list-body flex min-h-0 flex-1 flex-col [@media(height<=780px)]:flex-none gap-2 border-t border-line pt-3" data-testid="sidebar-team-sessions">
      <div role="group" aria-label="팀 세션 거르기" className="flex flex-wrap gap-1 px-1">
        {(Object.keys(FILTER_LABEL) as TeamFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            data-testid={`team-filter-${key}`}
            className={cn(
              "rounded-full px-3 py-1 text-meta font-medium press focus-visible:focus-ring",
              filter === key
                ? "bg-primary text-on-primary"
                : "bg-surface-muted text-ink hover:bg-surface-hover"
            )}
          >
            {FILTER_LABEL[key]} <span data-numeric>{counts[key]}</span>
          </button>
        ))}
      </div>
      <ul className="sidebar-stack min-h-0 flex-1 overflow-y-auto overscroll-contain [@media(height<=780px)]:flex-none [@media(height<=780px)]:overflow-y-visible">
        {firstLoad ? (
          <li className="px-3 py-2 text-meta text-ink-muted">불러오는 중이에요</li>
        ) : rows.length === 0 ? (
          <li className="px-3 py-2 text-meta text-ink-muted" data-testid="sidebar-team-empty">
            {filter === "all" ? "지금 도는 공유 세션이 없어요" : "해당하는 세션이 없어요"}
          </li>
        ) : (
          rows.map((item) => {
            const where = whereLabel(item);
            const current = openId !== null && uuidEq(item.sessionId, openId);
            return (
              <li key={item.sessionId}>
                <Link
                  to={`${TEAM_WORK_PATH}&card=${encodeURIComponent(item.sessionId)}`}
                  aria-current={current ? "true" : undefined}
                  data-testid="sidebar-team-session"
                  className={cn(
                    "flex min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left focus-visible:focus-ring",
                    current
                      ? "band-surface sidebar-row-selected text-ink active:bg-surface-pressed"
                      : "hover:bg-surface-hover active:bg-surface-pressed"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-body text-ink",
                        item.state === "waiting" ? "font-bold" : "font-medium"
                      )}
                    >
                      {sessionTitle(item)}
                    </span>
                    <SessionStateChip status={item.state} label={stateChipLabel(item)} testId="sidebar-team-session-chip" />
                  </span>
                  <span className="min-w-0 truncate text-meta text-ink-muted">
                    {[item.owner.displayName, where.primary].filter(Boolean).join(" · ")}
                  </span>
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
