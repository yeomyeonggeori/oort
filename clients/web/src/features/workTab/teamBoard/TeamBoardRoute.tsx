import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Bot, SquareKanban, UserRound } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { SharedWorkSession } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import {
  TEAM_BOARD_COPY,
  boardSummary,
  doneSummary,
  channelLabel,
  groupByOwner,
  itemsForView,
  sessionTitle,
  whereLabel,
  type BoardView,
} from "@momo/core/features/workbench/teamBoard";
import { relativeLabel } from "@momo/core/features/inbox/model";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import {
  EmptyInvite,
  InlineBanner,
  Skeleton,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { DiffNumbers, LaneLabel, StateChip } from "./TeamBoardParts";
import { TeamBoardDrawer } from "./TeamBoardDrawer";
import {
  useTeamBoardItem,
  useTeamBoardList,
  useTeamBoardRail,
} from "./useTeamBoard";

// Reading this as: 「팀 작업」 보드 for internal team users on web+Tauri, density 7/10,
// motion 0/10.
//
// 시안 ④ + 제안서 §4(#2863). 보이는 것은 **서버가 보는 사람의 채널 멤버십으로 걸러 준
// 공유 세션**뿐이다. 이 화면은 그 위에 다시 거르지 않는다. 터미널 원문, 입력, 멈춤은
// 없다(드로어도 같다). 행동은 대화에서 한다.
//
// 키보드: j/k 또는 위·아래 화살표로 줄을 옮기고, Enter가 드로어를 열고, Esc가 닫고
// 열었던 줄로 돌아온다. 줄은 로빙 tabindex 한 벌이다(탭 정지는 한 곳).

const MINUTE_MS = 60_000;

/** 분 단위로만 다시 그리는 시계. 줄의 「3분 전」이 오래 머물러도 거짓이 되지 않게 한다. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function TeamBoardRoute() {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const openId = params.get("card");
  const [view, setView] = useState<BoardView>("now");
  const nowMs = useMinuteNow();

  const list = useTeamBoardList(workspaceId);
  useTeamBoardRail(workspaceId, list.items);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const lastOpenedRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const visible = useMemo(
    () => itemsForView(list.items, view, nowMs),
    [list.items, view, nowMs]
  );
  const groups = useMemo(() => groupByOwner(visible), [visible]);
  const summary = useMemo(() => boardSummary(list.items), [list.items]);
  const doneToday = useMemo(
    () => itemsForView(list.items, "done", nowMs).length,
    [list.items, nowMs]
  );

  const single = useTeamBoardItem(workspaceId, openId);
  const fromList =
    openId === null
      ? null
      : list.items.find((i) => uuidEq(i.sessionId, openId)) ?? null;
  // 단건 읽기가 더 최근의 답이다. 없으면 목록의 줄을 쓴다.
  const openItem: SharedWorkSession | null = single.data ?? fromList;
  const drawerGone = openId !== null && single.gone && fromList === null;

  const setCard = useCallback(
    (id: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === null) next.delete("card");
          else next.set("card", id);
          return next;
        },
        { replace: false }
      );
    },
    [setParams]
  );

  const close = useCallback(() => setCard(null), [setCard]);
  useEscapeLayer(openId !== null, close);

  // 열 때는 드로어로 포커스를 옮긴다. 불러오는 껍데기가 내용으로 바뀌어도(다른 노드) 다시 옮긴다.
  const drawerReady = openItem !== null;
  useEffect(() => {
    if (openId === null) return;
    lastOpenedRef.current = openId;
    drawerRef.current?.focus();
  }, [openId, drawerReady]);
  // 닫을 때는 열었던 줄로 돌려보낸다(그 줄이 없어졌으면 목록 상자로).
  useEffect(() => {
    if (openId !== null) return;
    const last = lastOpenedRef.current;
    if (last === null) return;
    lastOpenedRef.current = null;
    const row = rowRefs.current.get(last.toLowerCase());
    (row ?? listRef.current)?.focus();
  }, [openId]);

  // 열린 줄이 목록에서 사라졌고(공유가 꺼짐) 단건도 404면 드로어를 닫고 안내는 목록 상단에 둔다.
  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (!drawerGone) return;
    setGoneNotice(true);
    setCard(null);
  }, [drawerGone, setCard]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  const orderedIds = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => i.sessionId)),
    [groups]
  );
  // 로빙 탭 정지: 활성 줄이 사라지면 첫 줄로 돌아간다.
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

  const firstLoad = list.isPending && list.data === undefined;
  const blockingError = list.error !== null && list.data === undefined;
  const staleError = list.error !== null && list.data !== undefined;
  const drawerOpen = openId !== null && !drawerGone;

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid="team-work-route"
    >
      <header className="flex h-work-board-bar shrink-0 items-center gap-3 border-b border-line px-4">
        <SidebarDrawerToggle />
        <h1 className="flex min-w-0 items-center gap-2 text-title font-bold text-ink">
          <SquareKanban aria-hidden className="size-4 shrink-0 text-icon" />
          <span className="truncate">{TEAM_BOARD_COPY.title}</span>
        </h1>
        <span className="min-w-0 truncate text-body text-ink-muted">
          {TEAM_BOARD_COPY.subtitle}
        </span>
        {/* 읽은 목록이 있을 때만 보기를 가른다(불러오는 중·오류에는 가를 것이 없다). */}
        {list.data !== undefined && (
          <div
            role="group"
            aria-label="보기"
            className="ms-auto flex shrink-0 gap-1 rounded-lg bg-surface-muted p-1"
          >
            {(
              [
                ["now", TEAM_BOARD_COPY.viewNow, null],
                ["done", TEAM_BOARD_COPY.viewDone, doneToday],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                data-testid={`team-board-view-${key}`}
                className={cn(
                  "h-control-sm rounded-md px-3 text-meta font-medium press focus-visible:focus-ring",
                  view === key
                    ? "bg-surface text-ink shadow-sm"
                    : "text-ink-muted hover:text-ink"
              )}
            >
              {label}
              {count !== null && count > 0 && (
                <span data-numeric className="ms-1 font-mono">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
        )}
      </header>

      {/* 읽은 목록이 있으면 앱 셸의 끊김 배너가 이미 말한다(같은 사실을 두 번 말하지 않는다).
          목록이 아직 없을 때만 여기서 말한다. */}
      {offline && list.data === undefined && (
        <InlineBanner
          tone="neutral"
          message={TEAM_BOARD_COPY.offlineEmpty}
          testId="team-board-offline"
        />
      )}
      {staleError && !offline && (
        <InlineBanner
          message="팀 작업을 새로 불러오지 못했어요. 마지막 목록을 보여 드려요."
          actionLabel={TEAM_BOARD_COPY.errorAction}
          onAction={() => void list.refetch()}
          testId="team-board-stale-error"
        />
      )}
      {goneNotice && (
        <InlineBanner
          tone="neutral"
          message={`${TEAM_BOARD_COPY.goneTitle}. ${TEAM_BOARD_COPY.goneBody}`}
          actionLabel={TEAM_BOARD_COPY.drawerClose}
          onAction={() => setGoneNotice(false)}
          testId="team-board-gone"
        />
      )}

      <div
        className="team-board-layout"
        data-drawer={drawerOpen ? "" : undefined}
      >
        <div
          ref={listRef}
          tabIndex={-1}
          data-team-board-list=""
          className="flex min-h-0 min-w-0 flex-col overflow-y-auto focus-visible:focus-ring"
          aria-label="공유된 팀 작업 목록"
          aria-busy={firstLoad}
          role="region"
        >
          {firstLoad ? (
            <Skeleton ready={false} rows={6} className="p-4" />
          ) : blockingError ? (
            <EmptyInvite
              headline={TEAM_BOARD_COPY.errorTitle}
              detail={TEAM_BOARD_COPY.errorBody}
              testId="team-board-error"
              actions={
                <Button
                  type="button"
                  size="sm"
                  className="tap-target"
                  onClick={() => void list.refetch()}
                  data-testid="team-board-retry"
                >
                  {TEAM_BOARD_COPY.errorAction}
                </Button>
              }
            />
          ) : (
            <>
              {visible.length > 0 && (
                <p
                  className="border-b border-line px-4 py-3 text-body text-ink"
                  data-testid="team-board-summary"
                >
                  {view === "now" ? summary.sentence : doneSummary(visible.length)}
                </p>
              )}
              {visible.length === 0 ? (
                <EmptyInvite
                  headline={
                    view === "now"
                      ? TEAM_BOARD_COPY.emptyTitle
                      : TEAM_BOARD_COPY.emptyDoneTitle
                  }
                  detail={
                    view === "now"
                      ? TEAM_BOARD_COPY.emptyBody
                      : TEAM_BOARD_COPY.emptyDoneBody
                  }
                  testId="team-board-empty"
                  actions={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="tap-target"
                      onClick={() => navigate("/")}
                      data-testid="team-board-empty-action"
                    >
                      {TEAM_BOARD_COPY.emptyAction}
                    </Button>
                  }
                />
              ) : (
                <div className="flex flex-col px-2 pb-4" data-testid="team-board-table">
                  <div
                    aria-hidden
                    className="team-board-row border-b border-line px-3 py-2 text-timestamp font-semibold text-ink-muted"
                  >
                    <span>무슨 작업</span>
                    <span data-col="where">작업 위치</span>
                    <span>상태</span>
                    <span>마지막 활동</span>
                    <span data-col="channel">채널</span>
                  </div>
                  {groups.map((group) => (
                    <section
                      key={group.key}
                      aria-label={`${group.ownerName}의 공유 세션`}
                      data-testid="team-board-group"
                    >
                      <h2 className="flex items-center gap-2 px-3 pt-3 pb-1 text-body font-semibold text-ink">
                        {group.agentOnly ? (
                          <Bot aria-hidden className="size-4 shrink-0 text-agent" />
                        ) : (
                          <UserRound aria-hidden className="size-4 shrink-0 text-icon" />
                        )}
                        {group.ownerName}
                        <span className="text-meta font-normal text-ink-muted">
                          <span data-numeric className="font-mono">
                            {group.items.length}
                          </span>
                          개
                        </span>
                      </h2>
                      <ul className="flex flex-col">
                        {group.items.map((item) => (
                          <BoardRow
                            key={item.sessionId}
                            item={item}
                            nowMs={nowMs}
                            selected={
                              openId !== null && uuidEq(item.sessionId, openId)
                            }
                            tabStop={
                              rovingId !== null &&
                              uuidEq(item.sessionId, rovingId)
                            }
                            rowRef={(el) => {
                              const key = item.sessionId.toLowerCase();
                              if (el) rowRefs.current.set(key, el);
                              else rowRefs.current.delete(key);
                            }}
                            onOpen={() => {
                              setActiveId(item.sessionId);
                              setCard(item.sessionId);
                            }}
                            onKeyDown={(e) => onRowKeyDown(e, item.sessionId)}
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
                        data-testid="team-board-more"
                      >
                        {list.isFetchingNextPage
                          ? TEAM_BOARD_COPY.loadingMore
                          : TEAM_BOARD_COPY.loadMore}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {drawerOpen && (
          <div data-team-board-drawer="" className="flex min-h-0 min-w-0 flex-col">
            {openItem !== null ? (
              <TeamBoardDrawer
                ref={drawerRef}
                item={openItem}
                nowMs={nowMs}
                onClose={close}
              />
            ) : (
              <aside
                ref={drawerRef}
                tabIndex={-1}
                aria-label={TEAM_BOARD_COPY.drawerLabel}
                className="flex min-h-0 flex-1 flex-col border-s border-line bg-surface focus-visible:focus-ring"
                data-testid="team-board-drawer-loading"
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

function BoardRow({
  item,
  nowMs,
  selected,
  tabStop,
  rowRef,
  onOpen,
  onKeyDown,
}: {
  item: SharedWorkSession;
  nowMs: number;
  selected: boolean;
  tabStop: boolean;
  rowRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const where = whereLabel(item);
  const latestStage = item.stages.length > 0 ? item.stages[item.stages.length - 1] : null;
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
        data-testid="team-board-row"
        data-session-id={item.sessionId}
        data-origin={item.origin}
        className={cn(
          "team-board-row w-full rounded-lg px-3 py-2 text-start text-body text-ink focus-visible:focus-ring",
          // 전폭 행은 눌림을 채움으로만 한다(press 스케일 없음, ADR-0179 D5).
          "active:bg-surface-pressed",
          selected ? "bg-surface-hover" : "hover:bg-surface-hover"
        )}
      >
        <span className="flex min-w-0 flex-col" data-col="task">
          <span className="truncate font-medium">{sessionTitle(item)}</span>
          <span className="flex min-w-0 items-center gap-2 text-timestamp text-ink-muted">
            <LaneLabel item={item} />
            <span className="shrink-0">{item.harness}</span>
            {latestStage !== null && (
              <span className="min-w-0 truncate" data-testid="team-board-stage">
                {latestStage}
              </span>
            )}
          </span>
          <span
            data-narrow=""
            className="min-w-0 items-center gap-2 text-timestamp text-ink-muted"
            data-testid="team-board-narrow"
          >
            {(where.primary !== null || where.secondary !== null) && (
              <span className="min-w-0 truncate font-mono">
                {[where.primary, where.secondary].filter(Boolean).join(" / ")}
              </span>
            )}
            <DiffNumbers item={item} />
            <span className="shrink-0">{channelLabel(item)}</span>
          </span>
        </span>
        <span className="flex min-w-0 flex-col" data-col="where">
          <span className="truncate font-mono text-meta text-ink" title={where.primary ?? undefined}>
            {where.primary ?? ""}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-timestamp text-ink-muted">
            {where.secondary !== null && (
              <span className="min-w-0 truncate font-mono" title={where.secondary}>{where.secondary}</span>
            )}
            <DiffNumbers item={item} />
          </span>
        </span>
        <span data-col="state">
          <StateChip item={item} />
        </span>
        <span className="text-meta text-ink-muted" data-col="when">
          {relativeLabel(item.lastActivityAt * 1000, nowMs)}
        </span>
        <span className="truncate text-meta text-ink-muted" data-col="channel">
          {channelLabel(item)}
        </span>
      </button>
    </li>
  );
}
