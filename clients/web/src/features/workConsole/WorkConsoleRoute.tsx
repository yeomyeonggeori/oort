import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cloud,
  CircleHelp,
  Laptop,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { CHIP_CLASS } from "@/features/common/chip";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { messageAnchorPath } from "@/features/inbox/anchor";
import {
  channelLabel,
  memberFor,
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  useWorkHosts,
  useWorkSessionRail,
  useWorkSessions,
} from "@/features/work/useWorkSessions";
import { WorkSessionDetail } from "@/features/work/WorkSessionDetail";
import {
  sortSessions,
  workSessionContinuityStatus,
} from "@momo/core/features/work/workSessionModel";
import {
  clockLabel,
  SESSION_STATUS_CLASS,
} from "@momo/core/features/work/workSessionFormat";
import { useTickingNow } from "@/features/agents/agentWorkingSignal";
import {
  uuidEq,
  type Channel,
  type WorkHost,
  type WorkSession,
} from "@momo/core/lib/api";
import {
  workConsoleLocation,
  workConsoleSessionPath,
  type WorkConsoleLocation,
} from "./model";

// =============================================================================
// 작업 콘솔 (#1289).
//
// 채널 우측의 `WorkPanel`이 이미 가진 세션 상세와 read-only 터미널을 그대로 쓰되,
// 목록의 범위를 워크스페이스 전체로 고정한 전용 목적지다. 이 파일은 프로젝트,
// 저장소, 브랜치, cwd를 만들거나 추측하지 않는다. 현 API가 가진 정직한 묶음은
// WorkSession ↔ WorkHost ↔ Channel뿐이고, 그보다 큰 계층은 별도 계약이 필요하다.
//
// T1/T2/T3는 상태 칩과 나란히 합치지 않는다. 상태는 "지금 무엇을 하는가",
// 위치는 "어디서 도는가"라는 서로 다른 질문이며, 둘 다 글자와 아이콘으로 답한다.
// =============================================================================

function LocationIcon({ location }: { location: WorkConsoleLocation }) {
  const className = "size-3";
  if (location.key === "t1") return <Laptop className={className} />;
  if (location.key === "t2") return <Server className={className} />;
  if (location.key === "t3") return <Cloud className={className} />;
  return <CircleHelp className={className} />;
}

function LocationBadge({ location }: { location: WorkConsoleLocation }) {
  return (
    <span
      className={cn(
        CHIP_CLASS,
        "inline-flex items-center gap-1 bg-surface-hover text-ink-muted"
      )}
      data-testid="work-console-location"
      data-location={location.key}
    >
      <span aria-hidden="true">
        <LocationIcon location={location} />
      </span>
      {location.label}
    </span>
  );
}

function WorkConsoleRow({
  session,
  hosts,
  channelName,
  ownerName,
  selected,
  rowRef,
  onSelect,
}: {
  session: WorkSession;
  hosts: readonly WorkHost[] | undefined;
  channelName: string;
  ownerName: string;
  selected: boolean;
  rowRef: (element: HTMLAnchorElement | null) => void;
  onSelect: () => void;
}) {
  const location = workConsoleLocation(session, hosts);
  const status = workSessionContinuityStatus(session, hosts);
  const recentTime =
    session.endedAtMs !== undefined
      ? `종료 ${clockLabel(session.endedAtMs)}`
      : `시작 ${clockLabel(session.startedAtMs)}`;

  return (
    <li className="border-b border-line" data-testid="work-console-row">
      <Link
        ref={rowRef}
        to={workConsoleSessionPath(session.id)}
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-col gap-1 px-4 py-2 transition-colors focus-visible:focus-ring",
          selected ? "bg-accent-soft" : "hover:bg-surface-hover"
        )}
        data-session-id={session.id}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body text-ink">
            {session.label}
          </span>
          <span
            className={cn(CHIP_CLASS, SESSION_STATUS_CLASS[status.key])}
            data-testid="work-console-status"
            data-status={status.key}
          >
            {status.label}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <LocationBadge location={location} />
          <span
            className="min-w-0 flex-1 truncate text-meta text-ink-muted"
            data-testid="work-console-host"
          >
            {location.host?.displayName ?? "호스트 정보 없음"}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-meta text-ink-muted">
          <span
            data-numeric
            data-testid="work-console-time"
            className="shrink-0 font-mono text-timestamp text-ink-muted"
          >
            {recentTime}
          </span>
          <span
            className="min-w-0 flex-1 truncate"
            data-testid="work-console-meta"
          >
            {channelName} · {ownerName} · {session.tool}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function WorkConsoleRoute() {
  const { session: auth, workspaceId, connStatus } = useSession();
  const navigate = useNavigate();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const selectedParam = params.get("session")?.trim() || null;

  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const sessions = useMemo(
    () => sortSessions(sessionsQuery.data ?? []),
    [sessionsQuery.data]
  );
  const selected =
    selectedParam === null
      ? null
      : sessions.find((session) => uuidEq(session.id, selectedParam)) ?? null;
  const rail = useWorkSessionRail(workspaceId, sessions, null);
  const live = !offline && connStatus === "connected";
  const nowMs = useTickingNow(
    live &&
      selected !== null &&
      sessions.some((session) => session.status === "running")
  );

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );
  const channelNameOf = useMemo(() => {
    const directory: Directory = directoryQuery.directory;
    return (id: string): string => {
      if (channelsQuery.data === undefined) {
        return channelsQuery.error === null ? "채널 확인 중" : "채널 조회 실패";
      }
      const channel: Channel | undefined = channels.find((candidate) =>
        uuidEq(candidate.id, id)
      );
      if (!channel) return "채널 정보 없음";
      if (channel.kind === "dm" && directoryQuery.data === undefined) {
        return directoryQuery.error === null
          ? "대화 상대 확인 중"
          : "대화 상대 조회 실패";
      }
      const label = channelLabel(channel, directory, auth.member.id);
      return channel.kind === "dm" ? label : `#${label}`;
    };
  }, [
    auth.member.id,
    channels,
    channelsQuery.data,
    channelsQuery.error,
    directoryQuery.data,
    directoryQuery.directory,
    directoryQuery.error,
  ]);
  const ownerNameOf = (memberId: string): string => {
    if (directoryQuery.data === undefined) {
      return directoryQuery.error === null
        ? "담당자 확인 중"
        : "담당자 조회 실패";
    }
    return (
      memberFor(directoryQuery.directory, memberId)?.displayName ??
      "담당자 정보 없음"
    );
  };

  const selectedLocation = useMemo(
    () =>
      selected === null
        ? null
        : workConsoleLocation(selected, hostsQuery.data),
    [hostsQuery.data, selected]
  );
  const showingDetail = selectedParam !== null;
  const projectionsPending =
    (sessionsQuery.isPending && sessionsQuery.data === undefined) ||
    (hostsQuery.isPending && hostsQuery.data === undefined);
  const projectionError = sessionsQuery.error ?? hostsQuery.error;
  const metadataError = channelsQuery.error ?? directoryQuery.error;
  // Refetch failure must not erase a projection already on screen. Offline is
  // exactly when the cached rows are most valuable; only a first read with no
  // usable projection replaces the list with the error state.
  const blockingProjectionError =
    (sessionsQuery.error !== null && sessionsQuery.data === undefined) ||
    (hostsQuery.error !== null && hostsQuery.data === undefined);
  const hasCachedProjection =
    sessionsQuery.data !== undefined && hostsQuery.data !== undefined;
  const [wideSessionId, setWideSessionId] = useState<string | null>(null);
  const detailWide =
    selected !== null &&
    wideSessionId !== null &&
    uuidEq(selected.id, wideSessionId);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const listRef = useRef<HTMLElement>(null);
  const previousSelectedParam = useRef(selectedParam);

  function clearSelection() {
    setWideSessionId(null);
    const next = new URLSearchParams(params);
    next.delete("session");
    setParams(next, { replace: true });
  }

  useEffect(() => {
    const previous = previousSelectedParam.current;
    previousSelectedParam.current = selectedParam;
    if (previous === null || selectedParam !== null) return;
    const row = rowRefs.current.get(previous.toLowerCase());
    const firstSurvivingRow = rowRefs.current.values().next().value;
    (row ?? firstSurvivingRow ?? listRef.current)?.focus();
  }, [selectedParam]);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="work-console-route">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0 break-keep">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarDrawerToggle />
            <h1 className="text-body font-semibold text-ink">작업 콘솔</h1>
          </div>
          <p className="break-words text-meta text-ink-muted">
            워크스페이스의 작업 세션과 터미널 관전을 한곳에서 확인합니다.
          </p>
        </div>
        {sessionsQuery.data !== undefined && (
          <span
            className="shrink-0 text-meta text-ink-muted"
            data-testid="work-console-count"
          >
            <span data-numeric className="font-mono">
              {sessions.length}
            </span>
            개
          </span>
        )}
      </header>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={
            hasCachedProjection
              ? "연결이 끊겼습니다. 아래는 마지막으로 확인된 작업 상태입니다."
              : "연결이 끊겼습니다. 아직 표시할 저장된 작업 상태가 없습니다."
          }
          testId="work-console-offline"
        />
      )}

      {projectionError !== null && !blockingProjectionError && (
        <InlineBanner
          message={
            sessionsQuery.error !== null
              ? "작업 세션을 새로 확인하지 못했습니다. 마지막 목록을 표시합니다."
              : "실행 위치를 새로 확인하지 못했습니다. 마지막 호스트 정보를 표시합니다."
          }
          actionLabel="다시 시도"
          onAction={() => {
            if (sessionsQuery.error !== null) void sessionsQuery.refetch();
            if (hostsQuery.error !== null) void hostsQuery.refetch();
          }}
          testId="work-console-stale-error"
        />
      )}

      {metadataError !== null && (
        <InlineBanner
          message={
            channelsQuery.error !== null && directoryQuery.error !== null
              ? "채널과 담당자 정보를 새로 확인하지 못했습니다. 확인 가능한 세션 정보는 유지합니다."
              : channelsQuery.error !== null
                ? "채널 정보를 새로 확인하지 못했습니다. 확인 가능한 세션 정보는 유지합니다."
                : "담당자 정보를 새로 확인하지 못했습니다. 확인 가능한 세션 정보는 유지합니다."
          }
          actionLabel="다시 시도"
          onAction={() => {
            if (channelsQuery.error !== null) void channelsQuery.refetch();
            if (directoryQuery.error !== null) void directoryQuery.refetch();
          }}
          testId="work-console-metadata-error"
        />
      )}

      {rail.uncovered.length > 0 && (
        <p
          className="border-b border-line px-4 py-1 text-meta text-ink-muted"
          data-testid="work-console-coverage"
        >
          실시간 표시 한도 때문에 일부 채널의 세션은 새로고침될 때 갱신됩니다.
        </p>
      )}

      <div
        className="work-console-layout min-h-0 flex-1"
        data-detail={showingDetail ? "" : undefined}
        data-detail-wide={detailWide ? "" : undefined}
      >
        <section
          id="work-console-session-list"
          ref={listRef}
          tabIndex={-1}
          aria-label="작업 세션 목록"
          data-work-console-list=""
          className="min-h-0 min-w-0 overflow-y-auto border-e border-line focus-visible:focus-ring"
        >
          {projectionsPending ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : blockingProjectionError ? (
            <InlineBanner
              message={
                sessionsQuery.error !== null
                  ? "작업 세션을 불러오지 못했습니다."
                  : "실행 위치를 불러오지 못했습니다."
              }
              actionLabel="다시 시도"
              onAction={() => {
                if (sessionsQuery.error !== null) void sessionsQuery.refetch();
                if (hostsQuery.error !== null) void hostsQuery.refetch();
              }}
              testId="work-console-error"
            />
          ) : sessions.length === 0 ? (
            <EmptyInvite
              headline="아직 작업 세션이 없습니다."
              detail="에이전트가 작업을 시작하면 실행 위치와 상태가 여기에 쌓입니다."
              testId="work-console-empty"
            />
          ) : (
            <ul data-testid="work-console-list">
              {sessions.map((session) => (
                <WorkConsoleRow
                  key={session.id}
                  session={session}
                  hosts={hostsQuery.data}
                  channelName={channelNameOf(session.channelId)}
                  ownerName={ownerNameOf(session.memberId)}
                  selected={uuidEq(session.id, selected?.id)}
                  onSelect={() => setWideSessionId(null)}
                  rowRef={(element) => {
                    const key = session.id.toLowerCase();
                    if (element) rowRefs.current.set(key, element);
                    else rowRefs.current.delete(key);
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label="작업 세션 상세"
          data-work-console-detail=""
          className="flex min-h-0 min-w-0 flex-col bg-surface"
        >
          {projectionsPending && showingDetail ? (
            <SkeletonRows rows={7} className="p-4" />
          ) : blockingProjectionError && showingDetail ? (
            <InlineBanner
              message="선택한 작업 세션을 불러오지 못했습니다."
              actionLabel="목록으로"
              onAction={clearSelection}
              testId="work-console-detail-error"
            />
          ) : selected !== null && selectedLocation !== null ? (
            <>
              <div
                className="flex min-w-0 items-center justify-between gap-2 border-b border-line px-4 py-2"
                data-testid="work-console-detail-location"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <LocationBadge location={selectedLocation} />
                  <span className="min-w-0 truncate text-meta text-ink-muted">
                    {selectedLocation?.host?.displayName ?? "호스트 정보 없음"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setWideSessionId(detailWide ? null : selected.id)
                  }
                  aria-pressed={detailWide}
                  aria-label="세션 상세 넓게 보기"
                  aria-controls="work-console-session-list"
                  title={detailWide ? "세션 목록 보이기" : "상세 넓게 보기"}
                  data-testid="work-console-detail-wide"
                  className="pane-wide-toggle flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
                >
                  {detailWide ? (
                    <PanelLeftOpen className="size-4" />
                  ) : (
                    <PanelLeftClose className="size-4" />
                  )}
                </button>
              </div>
              <WorkSessionDetail
                session={selected}
                hosts={hostsQuery.data}
                directory={directoryQuery.directory}
                channelName={channelNameOf(selected.channelId)}
                liveEvents={rail.liveEvents}
                controlFrames={rail.controlFrames}
                live={live}
                nowMs={nowMs}
                headingLevel={2}
                wide={detailWide}
                onWideChange={(nextWide) =>
                  setWideSessionId(nextWide ? selected.id : null)
                }
                onBack={clearSelection}
                openingThread={false}
                onOpenThread={() =>
                  navigate(
                    messageAnchorPath(
                      selected.channelId,
                      selected.rootMessageId
                    )
                  )
                }
                threadActionCopy={{
                  idle: "대화에서 세션 찾기",
                  busy: "대화로 이동 중",
                }}
                onResumed={(resumedId) => {
                  void sessionsQuery.refetch();
                  setParams(
                    { session: resumedId.toLowerCase() },
                    { replace: true }
                  );
                }}
              />
            </>
          ) : showingDetail ? (
            <InlineBanner
              message="이 작업 세션을 찾지 못했습니다. 목록이 바뀌었거나 주소가 잘못됐을 수 있습니다."
              actionLabel="목록으로"
              onAction={clearSelection}
              testId="work-console-not-found"
            />
          ) : (
            <EmptyInvite
              headline="확인할 세션을 선택하세요."
              detail="상태와 실행 위치를 비교한 뒤 진행 내역이나 터미널 관전을 열 수 있습니다."
              testId="work-console-detail-empty"
            />
          )}
        </section>
      </div>
    </div>
  );
}
