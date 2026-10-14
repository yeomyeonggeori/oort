import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ListChecks, SquareTerminal } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { SharedWorkSession } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import {
  WORK_JOBS_COPY,
  inProgressCount,
  inProgressLabel,
  itemsForFilter,
  reportedSummary,
  requesterToAgent,
  searchWithFilter,
  workJobRow,
  workJobSections,
  type WorkFilter,
  type WorkJobRow,
} from "@momo/core/features/workbench/workJobs";
import { TEAM_BOARD_COPY, isRunItem } from "@momo/core/features/workbench/teamBoard";
import { LOCAL_TERMINALS_PATH } from "@momo/core/features/workbench/workTab";
import { SESSION_STATUS_LABEL } from "@momo/core/features/workbench/sessionList";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useLocalPaneAttention } from "@/features/workbench/local/paneAttention";
import { TeamBoardDrawer } from "@/features/workTab/teamBoard/TeamBoardDrawer";
import { StateChip } from "@/features/workTab/teamBoard/TeamBoardParts";
import { useTeamBoardItem, useTeamBoardRail } from "@/features/workTab/teamBoard/useTeamBoard";
import { isDesktop } from "@/lib/tauri";
import { ApprovalCardLink, JobPrLink, ReportedTag } from "./WorkJobParts";
import { currentWorkFilter, rememberWorkFilter, useWorkJobsList } from "./useWorkJobs";

// Reading this as: 「작업」 한 화면(결과 중심 목록 + 서랍) for internal team users on web+Tauri,
// density 7/10, motion 0/10.
//
// ADR-0202 D1·D2·D6 (U1 #3842). 줄 하나 = 맡긴 일 하나. 줄이 말하는 것은 결과다: 누가 어느
// 에이전트에게 맡겼나, 상태, 결과(PR·에이전트 보고), 걸린 시간, 채널. 진행 스트림은 줄을 열면
// 서랍(기존 `TeamBoardDrawer`)에서만 본다. 이 화면에는 승인 단추가 없다: 승인 대기 줄은 카드가
// 있는 채널로 간다(D5). 남의 터미널·화면은 여기에 오지 않는다(D5).
//
// 필터는 주소가 정본이다(`?who=mine|team`, 옛 `?view=team`은 「팀 전체」). 주소가 말하지 않으면
// 기기 기억, 그것도 없으면 「내 것」(D2).
//
// 키보드: j/k 또는 위·아래 화살표로 줄을 옮기고, Enter가 서랍을 열고, Esc가 닫고 열었던 줄로
// 돌아온다. 줄은 로빙 tabindex 한 벌이다(팀 보드와 같은 문법).

const MINUTE_MS = 60_000;

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function WorkJobsRoute() {
  const { workspaceId, session } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const openId = params.get("card");
  const filter = currentWorkFilter(location.search);
  const nowMs = useMinuteNow();
  const desktop = isDesktop();

  const list = useWorkJobsList(workspaceId, filter);
  useTeamBoardRail(workspaceId, list.items);

  const chooseFilter = useCallback(
    (next: WorkFilter) => {
      rememberWorkFilter(next);
      navigate(
        { pathname: location.pathname, search: searchWithFilter(location.search, next) },
        { replace: true }
      );
    },
    [location.pathname, location.search, navigate]
  );

  const rows = useMemo<WorkJobRow[]>(
    () =>
      itemsForFilter(list.items, filter, session.member.id, list.mode).map((item) =>
        workJobRow(item, nowMs)
      ),
    [list.items, list.mode, filter, session.member.id, nowMs]
  );
  const sections = useMemo(() => workJobSections(rows), [rows]);
  const running = inProgressCount(rows);

  const fromList =
    openId === null ? null : list.items.find((i) => uuidEq(i.sessionId, openId)) ?? null;
  // 단건 읽기는 세션 전용이다(실행 줄은 목록의 줄이 정본이다).
  const single = useTeamBoardItem(workspaceId, openId, fromList === null || !isRunItem(fromList));
  const openItem: SharedWorkSession | null = single.data ?? fromList;
  const drawerGone = openId !== null && single.gone && fromList === null;

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const lastOpenedRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const setCard = useCallback(
    (id: string | null) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (id === null) next.delete("card");
        else next.set("card", id);
        return next;
      });
    },
    [setParams]
  );
  const close = useCallback(() => setCard(null), [setCard]);
  useEscapeLayer(openId !== null, close);

  const drawerReady = openItem !== null;
  useEffect(() => {
    if (openId === null) return;
    lastOpenedRef.current = openId;
    drawerRef.current?.focus();
  }, [openId, drawerReady]);
  useEffect(() => {
    if (openId !== null) return;
    const last = lastOpenedRef.current;
    if (last === null) return;
    lastOpenedRef.current = null;
    const row = rowRefs.current.get(last.toLowerCase());
    (row ?? listRef.current)?.focus();
  }, [openId]);

  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (!drawerGone) return;
    setGoneNotice(true);
    setCard(null);
  }, [drawerGone, setCard]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  const orderedIds = useMemo(() => sections.flatMap((s) => s.rows.map((r) => r.id)), [sections]);
  const rovingId =
    activeId !== null && orderedIds.some((id) => uuidEq(id, activeId))
      ? activeId
      : (orderedIds[0] ?? null);

  const moveFocus = useCallback(
    (from: string, delta: number | "first" | "last") => {
      const index = orderedIds.findIndex((id) => uuidEq(id, from));
      let next = index;
      if (delta === "first") next = 0;
      else if (delta === "last") next = orderedIds.length - 1;
      else next = Math.min(orderedIds.length - 1, Math.max(0, index + delta));
      const id = orderedIds[next];
      if (id === undefined) return;
      setActiveId(id);
      rowRefs.current.get(id.toLowerCase())?.focus();
    },
    [orderedIds]
  );

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(id, 1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(id, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(id, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(id, "last");
    }
  };

  const hasData = list.data !== undefined;
  const firstLoad = list.isPending && !hasData;
  const blockingError = list.error !== null && !hasData;
  const staleError = list.error !== null && hasData;
  const drawerOpen = openId !== null && !drawerGone;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="work-jobs-route" data-filter={filter}>
      <header className="flex h-work-board-bar shrink-0 items-center gap-3 border-b border-line px-4">
        <SidebarDrawerToggle />
        <h1 className="flex min-w-0 items-center gap-2 text-title font-bold text-ink">
          <ListChecks aria-hidden className="size-4 shrink-0 text-icon" />
          <span className="truncate">{WORK_JOBS_COPY.title}</span>
        </h1>
        {hasData && (
          <span
            className="shrink-0 text-meta text-ink-muted"
            data-testid="work-jobs-running"
            aria-live="polite"
          >
            <span data-numeric>{inProgressLabel(running, list.hasNextPage)}</span>
          </span>
        )}
        <div
          role="group"
          aria-label={WORK_JOBS_COPY.filterGroup}
          className="ms-auto flex shrink-0 gap-1 rounded-lg bg-surface-muted p-1"
        >
          {(
            [
              ["mine", WORK_JOBS_COPY.filterMine],
              ["team", WORK_JOBS_COPY.filterTeam],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => chooseFilter(key)}
              data-testid={`work-jobs-filter-${key}`}
              className={cn(
                "h-control-sm rounded-md px-3 text-meta font-medium press focus-visible:focus-ring",
                filter === key ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {offline && !hasData && (
        <InlineBanner tone="neutral" message={WORK_JOBS_COPY.offlineEmpty} testId="work-jobs-offline" />
      )}
      {staleError && !offline && (
        <InlineBanner
          message={WORK_JOBS_COPY.staleError}
          actionLabel={WORK_JOBS_COPY.errorAction}
          onAction={() => void list.refetch()}
          testId="work-jobs-stale-error"
        />
      )}
      {hasData && list.mode === "legacy" && (
        <InlineBanner tone="neutral" message={WORK_JOBS_COPY.legacyNotice} testId="work-jobs-legacy" />
      )}
      {goneNotice && (
        <InlineBanner
          tone="neutral"
          message="이 작업은 더 이상 보이지 않아요. 공유가 꺼졌거나 이 채널의 멤버가 아니에요."
          actionLabel="닫기"
          onAction={() => setGoneNotice(false)}
          testId="work-jobs-gone"
        />
      )}

      <div className="team-board-layout" data-drawer={drawerOpen ? "" : undefined}>
        <div
          ref={listRef}
          tabIndex={-1}
          data-team-board-list=""
          className="work-jobs-list flex min-h-0 min-w-0 flex-col overflow-y-auto focus-visible:focus-ring"
          aria-label={WORK_JOBS_COPY.listLabel}
          aria-busy={firstLoad}
          role="region"
        >
          {desktop && filter === "mine" && <ThisDeviceStrip />}
          {firstLoad ? (
            <Skeleton ready={false} rows={6} className="p-4" />
          ) : blockingError ? (
            <EmptyInvite
              headline={WORK_JOBS_COPY.errorTitle}
              detail={WORK_JOBS_COPY.errorBody}
              testId="work-jobs-error"
              actions={
                <Button
                  type="button"
                  size="sm"
                  className="tap-target"
                  onClick={() => void list.refetch()}
                  data-testid="work-jobs-retry"
                >
                  {WORK_JOBS_COPY.errorAction}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyInvite
              headline={filter === "mine" ? WORK_JOBS_COPY.emptyMineTitle : WORK_JOBS_COPY.emptyTeamTitle}
              detail={filter === "mine" ? WORK_JOBS_COPY.emptyMineBody : WORK_JOBS_COPY.emptyTeamBody}
              testId="work-jobs-empty"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="tap-target"
                  onClick={() => navigate("/")}
                  data-testid="work-jobs-empty-action"
                >
                  {WORK_JOBS_COPY.emptyAction}
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col px-2 pb-4" data-testid="work-jobs-table">
              <div
                aria-hidden
                className="work-jobs-row border-b border-line px-3 py-2 text-timestamp font-semibold text-ink-muted"
              >
                <span>{WORK_JOBS_COPY.colTask}</span>
                <span data-col="result">{WORK_JOBS_COPY.colResult}</span>
                <span>{WORK_JOBS_COPY.colState}</span>
                <span data-col="duration">{WORK_JOBS_COPY.colDuration}</span>
                <span data-col="channel">{WORK_JOBS_COPY.colChannel}</span>
              </div>
              {sections.map((section) => (
                <section
                  key={section.key}
                  aria-label={`${section.label} ${section.rows.length}개`}
                  data-testid="work-jobs-section"
                  data-section={section.key}
                >
                  <h2 className="px-3 pt-3 pb-1 text-meta font-semibold text-ink-muted">
                    {section.label}{" "}
                    <span data-numeric className="font-mono font-normal">
                      {section.rows.length}
                    </span>
                  </h2>
                  <ul className="flex flex-col">
                    {section.rows.map((row) => (
                      <JobRow
                        key={row.id}
                        row={row}
                        selected={openId !== null && uuidEq(row.id, openId)}
                        tabStop={rovingId !== null && uuidEq(row.id, rovingId)}
                        rowRef={(el) => {
                          const key = row.id.toLowerCase();
                          if (el) rowRefs.current.set(key, el);
                          else rowRefs.current.delete(key);
                        }}
                        onOpen={() => {
                          setActiveId(row.id);
                          setCard(row.id);
                        }}
                        onKeyDown={(e) => onRowKeyDown(e, row.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {list.hasNextPage && (
                <div className="px-3 pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="tap-target"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    data-testid="work-jobs-more"
                  >
                    {list.isFetchingNextPage ? WORK_JOBS_COPY.loadingMore : WORK_JOBS_COPY.loadMore}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {drawerOpen && (
          <div data-team-board-drawer="" className="flex min-h-0 min-w-0 flex-col">
            {openItem !== null ? (
              <TeamBoardDrawer ref={drawerRef} item={openItem} nowMs={nowMs} onClose={close} />
            ) : (
              <aside
                ref={drawerRef}
                tabIndex={-1}
                aria-label={TEAM_BOARD_COPY.drawerLabel}
                className="flex min-h-0 flex-1 flex-col border-s border-line bg-surface focus-visible:focus-ring"
                data-testid="work-jobs-drawer-loading"
              >
                <Skeleton ready={false} rows={6} className="p-4" />
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({
  row,
  selected,
  tabStop,
  rowRef,
  onOpen,
  onKeyDown,
}: {
  row: WorkJobRow;
  selected: boolean;
  tabStop: boolean;
  rowRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const reported = reportedSummary(row.reported);
  const result = <ResultCell row={row} reported={reported} />;
  return (
    <li>
      <button
        ref={rowRef}
        type="button"
        tabIndex={tabStop ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        aria-expanded={selected}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        data-testid="work-job-row"
        data-job-id={row.id}
        data-source={row.item.source}
        data-approval={row.awaitingApproval ? "" : undefined}
        className={cn(
          "work-jobs-row w-full rounded-lg px-3 py-2 text-start text-body text-ink focus-visible:focus-ring",
          "active:bg-surface-pressed",
          selected ? "bg-surface-hover" : "hover:bg-surface-hover"
        )}
      >
        <span className="flex min-w-0 flex-col" data-col="task">
          <span className="truncate font-medium">{row.title}</span>
          <span
            className={cn(
              "truncate text-timestamp",
              row.agentIsMember ? "text-agent" : "text-ink-muted"
            )}
            data-testid="work-job-who"
          >
            {requesterToAgent(row)}
          </span>
          <span data-narrow="" className="min-w-0 flex-col gap-1 text-timestamp text-ink-muted">
            {result}
            <span className="truncate">{row.channel}</span>
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-1" data-col="result">
          {result}
        </span>
        <span data-col="state">
          <StateChip item={row.item} />
        </span>
        <span className="text-meta text-ink-muted" data-col="duration" data-testid="work-job-duration">
          {row.durationText ?? ""}
        </span>
        <span className="truncate text-meta text-ink-muted" data-col="channel">
          {row.channel}
        </span>
      </button>
      {(row.pr !== null || row.awaitingApproval) && (
        <div className="mb-1 ms-3 flex flex-wrap items-center gap-2">
          {row.awaitingApproval && <ApprovalCardLink channelId={row.channelId} channel={row.channel} />}
          {row.pr !== null && <JobPrLink pr={row.pr} />}
        </div>
      )}
    </li>
  );
}

/**
 * 결과 칸: 에이전트 보고(꼬리표와 한 덩어리) → 아니면 서버가 본 PR 번호 → 아니면 도는 중 「아직 결과
 * 없음」, 끝났으면 「알린 결과 없음」. 잘려도 전체 문장은 `title`로 읽힌다.
 */
function ResultCell({ row, reported }: { row: WorkJobRow; reported: string | null }) {
  if (reported !== null) {
    return (
      <span className="flex min-w-0 items-center gap-2" data-testid="work-job-result" title={`${WORK_JOBS_COPY.reportedTag}: ${reported}`}>
        <ReportedTag />
        <span className="min-w-0 truncate text-meta text-ink">{reported}</span>
      </span>
    );
  }
  if (row.pr !== null) {
    return (
      <span className="min-w-0 truncate text-meta text-ink" data-testid="work-job-result">
        {row.pr.number}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-meta text-ink-muted" data-testid="work-job-result">
      {row.finished ? WORK_JOBS_COPY.noResultReported : WORK_JOBS_COPY.noResultYet}
    </span>
  );
}

/**
 * 데스크탑 「내 것」의 「이 기기」 줄(ADR-0202 D6): 옛 「내 작업」 격자는 사이드바 줄 없이
 * 여기서 연다. 내 기기의 응답 대기 신호일 뿐 팀 감시가 아니다.
 */
function ThisDeviceStrip() {
  const entries = useLocalPaneAttention();
  const waiting = entries.filter((e) => e.status === "waiting").length;
  const done = entries.filter((e) => e.status === "done").length;
  const parts = [
    waiting > 0 ? `${SESSION_STATUS_LABEL.waiting} ${waiting}` : null,
    done > 0 ? `${SESSION_STATUS_LABEL.done} ${done}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div
      className="flex min-w-0 items-center gap-3 border-b border-line px-4 py-2"
      data-testid="work-jobs-this-device"
    >
      <SquareTerminal aria-hidden className="size-4 shrink-0 text-icon" />
      <span className="min-w-0 truncate text-body text-ink">
        {WORK_JOBS_COPY.thisDevice}
        {parts.length > 0 && <span className="ms-2 text-meta text-ink-muted">{parts.join(" · ")}</span>}
      </span>
      <Button asChild size="sm" variant="secondary" className="ms-auto shrink-0">
        <Link to={LOCAL_TERMINALS_PATH} data-testid="work-jobs-open-terminals">
          {WORK_JOBS_COPY.openTerminals}
        </Link>
      </Button>
    </div>
  );
}
