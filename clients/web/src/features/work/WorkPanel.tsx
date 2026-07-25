import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { uuidEq, type Channel, type WorkHost, type WorkSession } from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabel,
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useTickingNow,
} from "@/features/agents/agentWorkingSignal";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  useSessionEvents,
  useWorkHosts,
  useWorkSessionRail,
  useWorkSessions,
} from "./useWorkSessions";
import {
  eventsForSession,
  foldSessionEvents,
  isSlowStep,
  lastLine,
  peekRows,
  ROW_STATE_LABEL,
  scopeSessions,
  sortSessions,
  workHostTrust,
  workSessionStatus,
  type WorkScope,
  type WorkSessionEvent,
} from "./workSessionModel";
import {
  clockLabel,
  freshnessLabel,
  ROW_STATE_CLASS,
  SESSION_STATUS_CLASS,
} from "./workSessionFormat";
import { WorkSessionDetail } from "./WorkSessionDetail";

// =============================================================================
// 작업 세션 패널 (AX-3 / MOMO-618). The web sibling of the mac Work Console
// drawer, in the shape the reference survey settled on: a right-hand secondary
// pane inside the channel surface, with the SCOPE LABEL ALWAYS ON SCREEN.
//
// The scope label is not a nicety. The reference implementation's own source
// says why it keeps one: an all-channels pane looks "wrong" without it, because
// it is indistinguishable from a channel pane showing the wrong channel. Both
// scopes are therefore rendered as a pair with the live one marked, and the
// line under them names the scope again in words next to the count.
//
// The list is for peeking and the detail is for reading. Choosing a row shows an
// inline preview UNDER that row without leaving the list (Claude Agent View's
// "do not lose your place"), and going in is a separate, named action.
// =============================================================================

function ScopeButton({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "h-control-sm min-w-0 truncate rounded-sm px-2 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active
          ? "bg-accent-soft text-accent"
          : "text-ink-muted hover:bg-surface-hover"
      )}
    >
      {label}
    </button>
  );
}

/**
 * One session in the list. Choosing it peeks; the preview under it carries the
 * action that actually opens it. A row is a button and nothing is nested inside
 * it, so the whole list stays reachable with Tab and arrow keys.
 */
function SessionRow({
  session,
  channelName,
  peeked,
  live,
  nowMs,
  lastEventAtMs,
  summary,
  onPeek,
}: {
  session: WorkSession;
  channelName: string;
  peeked: boolean;
  live: boolean;
  nowMs: number;
  lastEventAtMs: number | null;
  summary: string | null;
  onPeek: () => void;
}) {
  const status = workSessionStatus(session);
  const slow = live && isSlowStep(session, lastEventAtMs, nowMs);
  const elapsed = elapsedLabel(session.startedAtMs, session.endedAtMs ?? nowMs);
  return (
    <button
      type="button"
      onClick={onPeek}
      onMouseEnter={onPeek}
      onFocus={onPeek}
      aria-expanded={peeked}
      data-testid="work-session-row"
      data-session-id={session.id}
      data-status={status.key}
      className={cn(
        "flex w-full min-w-0 flex-col gap-px px-4 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        peeked ? "bg-surface-hover" : "hover:bg-surface-hover"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {session.label}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-sm px-2 py-px text-timestamp font-medium",
            SESSION_STATUS_CLASS[status.key]
          )}
        >
          {status.label}
        </span>
        <span
          data-numeric
          data-slow={slow ? "" : undefined}
          data-testid="work-session-elapsed"
          className={cn(
            "shrink-0 font-mono text-timestamp",
            !live ? "text-ink-muted" : slow ? "text-warn" : "text-ink-muted"
          )}
          title={
            slow
              ? "10초 넘게 새 신호가 없습니다. 아직 실행 중입니다."
              : undefined
          }
        >
          {elapsed}
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-meta text-ink-muted">{channelName}</span>
        {/* The second half is either the newest line the rail delivered, or the
            two facts the ledger row itself carries. It is never "아직 단계가
            없습니다": this row has not read the session thread, and absence of
            evidence would be stated here as evidence of absence. */}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
          {summary ?? `${session.tool} · 시작 ${clockLabel(session.startedAtMs)}`}
        </span>
      </span>
    </button>
  );
}

/**
 * The peek: the last few lines, and the one action that leaves the list.
 *
 * It reads the session thread itself rather than borrowing the list's live
 * buffer, which is what makes it honest: an empty peek here means the thread
 * WAS read and holds nothing, and the query it uses is keyed exactly like the
 * detail's, so opening the session after peeking costs no second round trip.
 */
function SessionPeek({
  session,
  hosts,
  liveEvents,
  onOpen,
}: {
  session: WorkSession;
  hosts: WorkHost[] | undefined;
  liveEvents: readonly WorkSessionEvent[];
  onOpen: () => void;
}) {
  const { workspaceId } = useSession();
  const mine = useMemo(
    () => eventsForSession(liveEvents, session.id),
    [liveEvents, session.id]
  );
  const query = useSessionEvents(workspaceId, session, mine);
  const rows = useMemo(
    () => foldSessionEvents(query.events, session).rows,
    [query.events, session]
  );
  const tail = peekRows(rows);
  return (
    <div
      className="border-y border-line bg-surface-raised px-4 py-2"
      data-testid="work-session-peek"
      data-session-id={session.id}
    >
      {query.isPending ? (
        <SkeletonRows rows={2} className="p-0" />
      ) : query.error !== null ? (
        <p className="text-meta text-danger" role="alert">
          진행 내역을 불러오지 못했습니다.
        </p>
      ) : tail.length === 0 ? (
        // Fail-closed here too (X-11 / MOMO-546). An empty stream from a remote
        // host is not a quiet session, it is a relay this client cannot vouch
        // for, and the peek is exactly where that difference would be missed.
        <p className="text-meta text-ink-muted" data-testid="work-peek-empty">
          {workHostTrust(session, hosts) === "local"
            ? "아직 진행 내역이 없습니다."
            : "진행 내역 중계가 검증되지 않은 호스트입니다. 세션 원장만 확인할 수 있습니다."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tail.map((row) => (
            <li key={row.id} className="flex items-baseline gap-2">
              <span
                data-numeric
                className="shrink-0 font-mono text-timestamp text-ink-muted"
              >
                {clockLabel(row.atMs)}
              </span>
              <span className="min-w-0 flex-1 truncate text-meta text-ink">
                {row.headline}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1 text-timestamp",
                  ROW_STATE_CLASS[row.state]
                )}
              >
                {ROW_STATE_LABEL[row.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpen}
          data-testid="work-session-open"
        >
          전체 보기
        </Button>
      </div>
    </div>
  );
}

export function WorkPanel({
  channelId,
  onClose,
}: {
  /** The open channel, or null when the route has none. */
  channelId: string | null;
  onClose: () => void;
}) {
  const { session: auth, workspaceId, connStatus } = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);

  const [scope, setScope] = useState<WorkScope>(
    channelId === null ? "all" : "channel"
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);

  const sessions = useMemo(
    () => sortSessions(sessionsQuery.data ?? []),
    [sessionsQuery.data]
  );
  const visible = useMemo(
    () => scopeSessions(sessions, scope, channelId),
    [sessions, scope, channelId]
  );
  const rail = useWorkSessionRail(workspaceId, sessions, channelId);

  const live = connStatus === "connected";
  const hasRunning = visible.some((session) => session.status === "running");
  // One clock for the panel, mounted only while something is actually running
  // and the rail is up: a clock that keeps counting on a dead socket is
  // measuring our optimism (agentWorkingSignal.useTickingNow).
  const nowMs = useTickingNow(live && hasRunning);

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );
  const nameOf = useMemo(() => {
    const directory: Directory = directoryQuery.directory;
    return (id: string): string => {
      const channel: Channel | undefined = channels.find((c) => uuidEq(c.id, id));
      if (!channel) return "다른 채널";
      const label = channelLabel(channel, directory, auth.member.id);
      return channel.kind === "dm" ? label : `#${label}`;
    };
  }, [channels, directoryQuery.directory, auth.member.id]);

  const scopeLabel = channelId === null ? "전체" : nameOf(channelId);
  const selected =
    selectedId === null
      ? null
      : sessions.find((session) => uuidEq(session.id, selectedId)) ?? null;

  // A selection that scrolled out of scope is not a selection any more, and a
  // detail view of a session the list no longer holds is a view of nothing.
  useEffect(() => {
    if (selectedId !== null && selected === null && !sessionsQuery.isPending) {
      setSelectedId(null);
    }
  }, [selectedId, selected, sessionsQuery.isPending]);

  useEffect(() => {
    setPeekId(null);
  }, [scope, channelId]);

  /** Folded rows per session, so the row summary and the peek agree exactly. */
  const foldedFor = useMemo(() => {
    const cache = new Map<
      string,
      { rows: ReturnType<typeof foldSessionEvents>["rows"]; lastEventAtMs: number | null }
    >();
    return (session: WorkSession) => {
      const key = session.id.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const mine: WorkSessionEvent[] = eventsForSession(
        rail.liveEvents,
        session.id
      );
      const folded = foldSessionEvents(mine, session);
      const value = { rows: folded.rows, lastEventAtMs: folded.lastEventAtMs };
      cache.set(key, value);
      return value;
    };
  }, [rail.liveEvents]);

  const updatedAt = sessionsQuery.dataUpdatedAt;

  return (
    <aside
      aria-label="작업 세션"
      data-testid="work-panel"
      data-scope={scope}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape steps back one level rather than closing everything: out of the
        // detail to the list, out of the peek to the plain list, then out.
        if (selectedId !== null) {
          event.stopPropagation();
          setSelectedId(null);
        } else if (peekId !== null) {
          event.stopPropagation();
          setPeekId(null);
        } else {
          onClose();
        }
      }}
      className="flex h-full w-pane shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex flex-col gap-1 border-b border-line px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-body font-semibold">작업 세션</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="작업 세션 닫기"
            data-testid="work-panel-close"
            className="flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1" data-testid="work-scope">
          <ScopeButton
            active={scope === "channel"}
            label={scopeLabel}
            onClick={() => setScope("channel")}
            testId="work-scope-channel"
          />
          <ScopeButton
            active={scope === "all"}
            label="전체"
            onClick={() => setScope("all")}
            testId="work-scope-all"
          />
        </div>
        {/* The count is a claim about the server, so it waits for the server.
            While the list is loading or failed there is no number here at all.
            The scope is NOT repeated here: it is one control away, above, and
            saying it twice cost a whole line of a 320px column. */}
        <p className="text-meta text-ink-muted" data-testid="work-panel-summary">
          {sessionsQuery.isPending ? (
            "세션을 불러오는 중입니다."
          ) : sessionsQuery.error !== null ? (
            "세션 목록을 확인하지 못했습니다."
          ) : (
            <>
              세션{" "}
              <span data-numeric className="font-mono">
                {visible.length}
              </span>
              개 · 마지막 갱신{" "}
              <span data-numeric className="font-mono">
                {freshnessLabel(updatedAt)}
              </span>
            </>
          )}
        </p>
      </header>

      {!live && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 갱신이 멈췄습니다. 아래는 마지막으로 확인된 상태입니다."
          testId="work-panel-offline"
        />
      )}

      {rail.uncovered.length > 0 && (
        <p
          className="border-b border-line px-4 py-1 text-meta text-ink-muted"
          data-testid="work-coverage-notice"
        >
          실시간 표시가 한도에 닿았습니다. 일부 채널의 세션은 새로고침될 때만
          갱신됩니다.
        </p>
      )}

      {selected !== null ? (
        <WorkSessionDetail
          session={selected}
          hosts={hostsQuery.data}
          directory={directoryQuery.directory}
          channelName={nameOf(selected.channelId)}
          liveEvents={rail.liveEvents}
          live={live}
          nowMs={nowMs}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessionsQuery.isPending && <SkeletonRows rows={4} className="p-4" />}
          {sessionsQuery.error !== null && (
            <InlineBanner
              message="세션 목록을 불러오지 못했습니다."
              actionLabel="다시 시도"
              onAction={() => void sessionsQuery.refetch()}
              testId="work-panel-error"
            />
          )}
          {!sessionsQuery.isPending &&
            sessionsQuery.error === null &&
            visible.length === 0 && (
              <EmptyInvite
                headline={
                  scope === "all"
                    ? "이 워크스페이스에는 아직 작업 세션이 없습니다."
                    : "이 채널에는 아직 작업 세션이 없습니다."
                }
                detail={
                  scope === "channel"
                    ? "다른 채널의 세션은 전체 범위에서 볼 수 있습니다."
                    : "에이전트가 작업을 시작하면 여기에 세션이 쌓입니다."
                }
                actions={
                  scope === "channel" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setScope("all")}
                      data-testid="work-empty-all"
                    >
                      전체 범위로 보기
                    </Button>
                  ) : undefined
                }
                testId="work-panel-empty"
              />
            )}
          {visible.length > 0 && (
            <ul data-testid="work-session-list">
              {visible.map((session) => {
                const folded = foldedFor(session);
                const peeked = uuidEq(session.id, peekId ?? undefined);
                return (
                  <li key={session.id} className="border-b border-line">
                    <SessionRow
                      session={session}
                      channelName={nameOf(session.channelId)}
                      peeked={peeked}
                      live={live}
                      nowMs={nowMs}
                      lastEventAtMs={folded.lastEventAtMs}
                      summary={lastLine(folded.rows)}
                      onPeek={() => setPeekId(session.id)}
                    />
                    {peeked && (
                      <SessionPeek
                        session={session}
                        hosts={hostsQuery.data}
                        liveEvents={rail.liveEvents}
                        onOpen={() => setSelectedId(session.id)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
