import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { relativeLabel } from "@/features/inbox/model";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { WORKSTREAM_STATUSES, type Workstream } from "@/lib/api";
import {
  WORKSTREAM_STATUS_CLASS,
  WORKSTREAM_STATUS_LABEL,
  channelDisplayName,
  parseStatusFilter,
} from "./model";
import { useWorkstreams } from "./useWorkstreams";

// =============================================================================
// 작업 흐름 목록 (MOMO-677 / ADR-0143 이행 3).
//
// One row per GOAL, not per run. The reason this surface exists is the question
// ADR-0143 opened with: "A가 시작한 일을 다른 사람이나 에이전트가 이어받을 수
// 있는가?" — which nobody can answer from the 작업 세션 패널, because that panel
// is scoped to one channel and, in its most used range, to your own sessions.
// Someone looking for work to pick up is by definition looking for work that is
// not theirs, so the goal layer is a workspace destination beside 인박스 · 활동
// · 멤버 · 에이전트 rather than a drawer inside one conversation (the same call
// the agent hub made in MOMO-652).
//
// The status filter is the SERVER's vocabulary (`?status=`), carried in the URL
// the way 인박스 carries its tab, so a filtered list survives a reload and can
// be pasted to someone else.
//
// What this list must never do is turn a zero into an accusation. A caller
// outside the anchor channel gets zero rows — not a 403 — precisely so these
// reads cannot be used to probe for other people's work (WorkstreamRoutes
// "minimum exposure"), and an empty state that said "권한이 없습니다" would hand
// back the existence signal the server just refused to give.
// =============================================================================

function StatusChip({ status }: { status: Workstream["status"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-2 py-px text-timestamp font-medium",
        WORKSTREAM_STATUS_CLASS[status]
      )}
      data-testid="workstream-status"
      data-status={status}
    >
      {WORKSTREAM_STATUS_LABEL[status]}
    </span>
  );
}

function WorkstreamRow({
  workstream,
  channelName,
  nowMs,
}: {
  workstream: Workstream;
  channelName: string;
  nowMs: number;
}) {
  return (
    <li
      className="border-b border-line"
      data-testid="workstream-row"
      data-workstream-id={workstream.id}
      data-status={workstream.status}
    >
      <Link
        to={`/workstreams/${workstream.id}`}
        className="flex flex-col gap-1 px-4 py-2 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* The goal is at most 200 characters (migration 055), so it fits one
              row's worth of reading; it truncates rather than wrapping because
              the row's job is scanning, and the detail shows it in full. */}
          <span
            className="min-w-0 flex-1 truncate text-body text-ink"
            data-testid="workstream-goal"
          >
            {workstream.goal}
          </span>
          <StatusChip status={workstream.status} />
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
          <span className="min-w-0 truncate" data-testid="workstream-channel">
            {channelName}
          </span>
          <span className="shrink-0">· 실행</span>
          {/* Two counts on one line, so both are tabular: 실행 12 over 실행 3
              must line up down the column, and the pair is the fact that
              decides whether anyone is on this goal right now. */}
          <span
            className="shrink-0 font-mono"
            data-numeric
            data-testid="workstream-run-count"
          >
            {workstream.runCount}
          </span>
          <span className="shrink-0">· 활성</span>
          <span
            className="shrink-0 font-mono"
            data-numeric
            data-testid="workstream-active-count"
          >
            {workstream.activeRunCount}
          </span>
          <span className="shrink-0">· 갱신</span>
          <span className="shrink-0" data-testid="workstream-updated">
            {relativeLabel(workstream.updatedAtMs, nowMs)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function WorkstreamListRoute() {
  const { session, workspaceId } = useSession();
  const offline = useOffline();
  const [params, setParams] = useSearchParams();
  const status = parseStatusFilter(params.get("status"));
  const query = useWorkstreams(workspaceId, status);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const nowMs = Date.now();

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  const workstreams = query.data ?? [];
  const settled = !query.isPending && query.error === null;

  function setStatus(next: Workstream["status"] | null) {
    const nextParams = new URLSearchParams(params);
    if (next === null) nextParams.delete("status");
    else nextParams.set("status", next);
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="workstream-route">
      <header className="flex flex-col gap-2 border-b border-line px-4 py-2">
        <div className="flex w-full max-w-pane-lg items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-body font-semibold text-ink">작업 흐름</h1>
            <p className="text-meta text-ink-muted">
              목표 하나와 그 목표를 실행한 사람들. 멈춘 목표는 같은 채널 멤버가
              이어받습니다.
            </p>
          </div>
          {settled && (
            <span
              className="shrink-0 text-meta text-ink-muted"
              data-testid="workstream-count"
            >
              <span data-numeric className="font-mono">
                {workstreams.length}
              </span>
              개
            </span>
          )}
        </div>
        {/* The filter is the server's own `?status=` vocabulary. Announced as
            one control, because a screen reader reading five loose buttons has
            not been told they are five answers to one question. */}
        <div
          role="group"
          aria-label="상태"
          className="flex min-w-0 flex-wrap items-center gap-1"
          data-testid="workstream-filter"
        >
          <button
            type="button"
            aria-pressed={status === null}
            onClick={() => setStatus(null)}
            data-testid="workstream-filter-all"
            className={cn(
              "h-control-sm shrink-0 rounded-sm px-2 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              status === null
                ? "bg-accent-soft text-accent"
                : "text-ink-muted hover:bg-surface-hover"
            )}
          >
            전체
          </button>
          {WORKSTREAM_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
              data-testid={`workstream-filter-${value}`}
              className={cn(
                "h-control-sm shrink-0 rounded-sm px-2 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                status === value
                  ? "bg-accent-soft text-accent"
                  : "text-ink-muted hover:bg-surface-hover"
              )}
            >
              {WORKSTREAM_STATUS_LABEL[value]}
            </button>
          ))}
        </div>
      </header>

      {/* The banner dates what is on screen and stops there. It used to add
          "이어받기는 다시 연결된 뒤에" as well, which names an action this
          surface does not carry (the takeover lives in the detail) and which
          the detail then repeats 200px from its own control: one fact, said
          once, where the control is. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 아래는 마지막으로 확인된 목록입니다."
          testId="workstream-offline"
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <SkeletonRows rows={5} className="p-4" />
        ) : query.error ? (
          <InlineBanner
            message="작업 흐름을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="workstream-error"
          />
        ) : workstreams.length === 0 ? (
          status === null ? (
            <EmptyInvite
              headline="아직 작업 흐름이 없습니다."
              detail="채널 스레드에서 작업을 시작하면 그 목표가 여기에 한 줄로 쌓입니다. 내가 속한 채널의 목표만 보입니다."
              testId="workstream-empty"
              dataAttrs={{ "data-variant": "all" }}
            />
          ) : (
            <EmptyInvite
              headline={`${WORKSTREAM_STATUS_LABEL[status]} 상태인 작업 흐름이 없습니다.`}
              detail="다른 상태에는 있을 수 있습니다."
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStatus(null)}
                  data-testid="workstream-empty-all"
                >
                  전체 보기
                </Button>
              }
              testId="workstream-empty"
              dataAttrs={{ "data-variant": "filtered" }}
            />
          )
        ) : (
          /* Same reading measure as the header above and the detail behind
             each row (max-w-pane-lg): let a row run the full surface and its
             right-aligned status chip ends up a screen away from the goal it
             describes, which is the exact failure the card measure exists for
             (tokens.md §4). */
          <ul className="max-w-pane-lg" data-testid="workstream-list">
            {workstreams.map((workstream) => (
              <WorkstreamRow
                key={workstream.id}
                workstream={workstream}
                channelName={channelDisplayName(
                  workstream.channelId,
                  channels,
                  directoryQuery.directory,
                  session.member.id
                )}
                nowMs={nowMs}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
