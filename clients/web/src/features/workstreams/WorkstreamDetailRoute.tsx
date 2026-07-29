import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { messageAnchorPath, watchForMessageId } from "@/features/inbox/anchor";
import { relativeLabel } from "@/features/inbox/model";
import {
  memberFor,
  memberNameParts,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { useWorkHosts } from "@/features/work/useWorkSessions";
import {
  workHostName,
  workSessionStatus,
} from "@/features/work/workSessionModel";
import { SESSION_STATUS_CLASS } from "@/features/work/workSessionFormat";
import { particleFor } from "@/lib/koreanParticle";
import {
  ApiError,
  resumeWorkSession,
  uuidEq,
  type WorkHost,
  type WorkstreamRun,
} from "@/lib/api";
import {
  WORKSTREAM_STATUS_CLASS,
  WORKSTREAM_STATUS_LABEL,
  actorCount,
  channelDisplayName,
  continuationBlockedCopy,
  continuationErrorCopy,
  continuationState,
  isWorkstreamMissing,
  runClockLabel,
} from "./model";
import { useWorkstream, useWorkstreamRuns } from "./useWorkstreams";

// =============================================================================
// 작업 흐름 상세 (MOMO-677 / ADR-0143 이행 3).
//
// Three things share this surface, in this order, because that is the order the
// question is asked in: what is the goal, who has worked on it, and can I pick
// it up.
//
// The middle one is the evidence. ADR-0143 D2 narrowed `work_session.member_id`
// to "the actor of this Run" and made continuity belong to the workstream, so
// A's run and B's run stand under one goal with both names visible. A ledger
// that showed only the latest actor would present the same rows as a transfer
// of ownership, which is the model this ADR replaced.
//
// The conversation stays canonical (ADR-0114): this page is a projection of a
// thread, so it links to that thread rather than restating it, and it renders
// no message bodies of its own.
//
// Two capabilities this surface deliberately does NOT offer. Live takeover of a
// RUNNING session needs a Writer Lease and belongs to ADR-0141, which is on
// hold, so the only thing on offer is picking up what stopped. And nothing here
// promises the previous host's uncommitted work: momo's ledger knows the WIP
// branch name and its base commit, but whether the git remote hands those
// commits to the next person is git's answer, not momo's (D3).
// =============================================================================

function MetaRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1">
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd
        className="min-w-0 flex-1 break-words text-meta text-ink"
        data-testid={testId}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * 7월 29일 22:23. The DAY stays in the sans stack and only the clock is
 * tabular: Korean prose set in the mono stack stretches the gaps between its
 * syllables, which is the same split 사용량 makes between its figures and its
 * phrases (tokens.md §4).
 */
function RunClockLabel({ at, nowMs }: { at: number; nowMs: number }) {
  const clock = runClockLabel(at, nowMs);
  return (
    <>
      {clock.day !== null && <span className="shrink-0">{clock.day}</span>}
      <span className="shrink-0 font-mono" data-numeric>
        {clock.time}
      </span>
    </>
  );
}

function RunRow({
  run,
  hosts,
  actorName,
  actorIsAgent,
  nowMs,
}: {
  run: WorkstreamRun;
  hosts: WorkHost[] | undefined;
  actorName: string;
  actorIsAgent: boolean;
  nowMs: number;
}) {
  const status = workSessionStatus(run);
  return (
    <li
      className="border-b border-line px-4 py-2"
      data-testid="workstream-run-row"
      data-run-id={run.id}
      data-member-id={run.memberId}
      data-status={run.status}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Agent identity is the --agent token on the name and nothing else:
            same row, same type, no second background (design-taste-web §9).
            It matters here more than anywhere: "A → 에이전트 → C" is the
            sentence this list exists to make readable. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-body",
            actorIsAgent ? "text-agent" : "text-ink"
          )}
          data-testid="workstream-run-actor"
        >
          {actorName}
        </span>
        {run.resumedFromSessionId !== undefined && (
          <span
            className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp text-ink-muted"
            data-testid="workstream-run-lineage"
          >
            이어받음
          </span>
        )}
        <span
          className={cn(
            "shrink-0 rounded-sm px-2 py-px text-timestamp font-medium",
            SESSION_STATUS_CLASS[status.key]
          )}
          data-testid="workstream-run-status"
        >
          {status.label}
        </span>
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
        <span className="min-w-0 truncate">{run.label}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">{run.tool}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0" data-testid="workstream-run-host">
          {workHostName(run, hosts) ?? "알 수 없는 호스트"}
        </span>
      </p>
      <p className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
        <span className="shrink-0">시작</span>
        <RunClockLabel at={run.startedAtMs} nowMs={nowMs} />
        {run.endedAtMs !== undefined && (
          <>
            <span className="shrink-0">· 종료</span>
            <RunClockLabel at={run.endedAtMs} nowMs={nowMs} />
          </>
        )}
      </p>
    </li>
  );
}

function ContinuationBlock({
  runs,
  hosts,
  runsPending,
}: {
  runs: WorkstreamRun[];
  hosts: WorkHost[] | undefined;
  runsPending: boolean;
}) {
  const { session, workspaceId } = useSession();
  const offline = useOffline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingHostId, setPendingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const state = continuationState(
    runs,
    hosts ?? [],
    session.member.id,
    offline
  );

  const takeOver = useCallback(
    async (run: WorkstreamRun, hostId: string) => {
      setPendingHostId(hostId);
      setError(null);
      setDone(false);
      try {
        // The SAME lineage resume the 작업 세션 패널 uses (ADR-0125 D11). What
        // ADR-0143 changed is who the server accepts, not what the act is
        // called: a second verb for "continue this work" would be a second
        // thing to keep in step with the ledger.
        await resumeWorkSession(workspaceId, run.id, hostId);
        // The evidence is this page's own run list, so the confirmation is the
        // refreshed list rather than a navigation away from it: the reader sees
        // their own name join the goal's history, which is the fact ADR-0143
        // added. The session ledger is invalidated too, because the 작업 세션
        // panel is now one Run out of date.
        await queryClient.invalidateQueries({
          queryKey: ["workstream-runs", workspaceId.toLowerCase()],
        });
        await queryClient.invalidateQueries({
          queryKey: ["workstream", workspaceId.toLowerCase()],
        });
        void queryClient.invalidateQueries({ queryKey: ["work-sessions"] });
        setOpen(false);
        setDone(true);
      } catch (cause) {
        setError(
          continuationErrorCopy(
            cause instanceof ApiError ? cause.status : null
          )
        );
      } finally {
        setPendingHostId(null);
      }
    },
    [queryClient, workspaceId]
  );

  if (runsPending) {
    return (
      <section
        className="border-b border-line px-4 py-2"
        data-testid="workstream-continue"
        data-state="pending"
      >
        <h2 className="pb-1 text-meta text-ink-muted">이어받기</h2>
        <p className="text-meta text-ink-muted">
          실행 이력을 확인한 뒤에 이어받을 수 있는지 알려 드립니다.
        </p>
      </section>
    );
  }

  return (
    <section
      className="border-b border-line px-4 py-2"
      data-testid="workstream-continue"
      data-state={state.kind}
    >
      <h2 className="pb-1 text-meta text-ink-muted">이어받기</h2>
      {/* The outcome lines sit ABOVE the branch, not inside its ready arm. A
          successful takeover ends the very state that offered it — the source
          Run stops being orphaned the moment the server records the new one —
          so a confirmation nested in that arm would be unmounted by its own
          success, and the error of a takeover that failed on the last eligible
          host would vanish the same way. */}
      {error !== null && (
        <p
          className="mb-2 text-meta text-danger"
          role="alert"
          data-testid="workstream-continue-error"
        >
          {error}
        </p>
      )}
      {/* Feedback in place, not a toast (design-taste-web §8). It states what
          the server recorded — a new Run under this goal — and says nothing
          about the working tree that Run starts from. */}
      {done && error === null && (
        <p
          className="mb-2 text-meta text-ok"
          role="status"
          data-testid="workstream-continue-done"
        >
          이어받았습니다. 아래 실행 이력에 내 실행이 추가됐습니다.
        </p>
      )}
      {state.kind !== "ready" ? (
        <p className="text-meta text-ink-muted" data-testid="workstream-continue-blocked">
          {continuationBlockedCopy(state)}
        </p>
      ) : (
        <>
          {/* The label is user data and decides its own particle: this roster
              runs 회귀 재현 and codex-workbench side by side, and "codex를" is
              a machine refusing to read what it just printed. */}
          <p className="text-meta text-ink">
            멈춘 실행{" "}
            <span className="text-ink-muted">{state.run.label}</span>
            {particleFor(state.run.label, "object")} 새 호스트에서 이어받습니다.
            새 실행으로 기록되고, 이 목표의 이력에 내 이름이 함께 남습니다.
          </p>
          {/* The same two sentences the 작업 세션 패널 says before a lineage
              resume, deliberately word for word: one surface promising less
              than the other about the same act is how a reader learns which one
              to distrust. */}
          <p className="mt-1 text-meta text-ink-muted">
            Git 계보만 새 호스트로 이어집니다. 이전 호스트의 터미널 상태와
            미커밋 변경은 옮겨지지 않습니다.
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              disabled={pendingHostId !== null}
              onClick={() => {
                setError(null);
                setOpen((current) => !current);
              }}
              data-testid="workstream-continue-toggle"
            >
              {open ? "호스트 선택 닫기" : "새 호스트에서 이어받기"}
            </Button>
          </div>
          {open && (
            <div
              className="mt-2 flex flex-wrap justify-end gap-2"
              role="group"
              aria-label="이어받을 호스트"
              data-testid="workstream-continue-targets"
            >
              {state.targets.map((host) => (
                <Button
                  key={host.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingHostId !== null}
                  aria-busy={uuidEq(pendingHostId ?? undefined, host.id) || undefined}
                  aria-label={`${host.displayName}에서 이어받기`}
                  className="min-w-0 max-w-full"
                  data-testid="workstream-continue-host"
                  data-host-id={host.id}
                  onClick={() => void takeOver(state.run, host.id)}
                >
                  {uuidEq(pendingHostId ?? undefined, host.id) && (
                    <Loader2 aria-hidden="true" className="spinner-busy" />
                  )}
                  <span className="min-w-0 truncate">
                    {uuidEq(pendingHostId ?? undefined, host.id)
                      ? "이어받는 중"
                      : host.displayName}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function WorkstreamDetailRoute() {
  const { session, workspaceId } = useSession();
  const offline = useOffline();
  const params = useParams();
  const workstreamId = params.workstreamId ?? "";
  const query = useWorkstream(workspaceId, workstreamId);
  const runsQuery = useWorkstreamRuns(workspaceId, workstreamId);
  const hostsQuery = useWorkHosts(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const nowMs = Date.now();

  const workstream = query.data ?? null;
  const runs = runsQuery.data?.runs ?? [];

  const back = (
    <Link
      to="/workstreams"
      className="flex items-center gap-1 text-meta text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid="workstream-detail-back"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      작업 흐름
    </Link>
  );


  /**
   * Who ran it. This roster really does carry two members called 김인턴 (a
   * human and an agent), so the name goes through the shared disambiguator
   * rather than being read off `displayName`: two rows reading 김인턴 under a
   * goal are not a history, they are a coin toss.
   */
  function actorOf(memberId: string): { name: string; isAgent: boolean } {
    const parts = memberNameParts(
      directoryQuery.directory,
      memberId,
      "알 수 없는 멤버"
    );
    const member = memberFor(directoryQuery.directory, memberId);
    return {
      name: parts.handle ? `${parts.name} ${parts.handle}` : parts.name,
      isAgent: member?.kind === "agent",
    };
  }

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid="workstream-detail-route"
    >
      <header className="border-b border-line px-4 py-2">{back}</header>

      {/* Dates the page and nothing else: what the disconnection means for the
          takeover is said once, in the block that owns that control. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 아래는 마지막으로 확인된 내용입니다."
          testId="workstream-detail-offline"
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <SkeletonRows rows={5} className="p-4" />
        ) : isWorkstreamMissing(query.error) ? (
          /* 404, said as 404. The server answers this for a workstream anchored
             outside the reader's channels precisely so the read cannot confirm
             that such a workstream exists; calling it "권한이 없습니다" here
             would hand back that confirmation in the client. Only the takeover
             call talks about membership, because only it answers 403. */
          <EmptyInvite
            headline="이 작업 흐름을 찾을 수 없습니다."
            detail="주소가 오래됐거나, 내가 속한 채널의 작업 흐름이 아닙니다."
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link to="/workstreams">작업 흐름 목록</Link>
              </Button>
            }
            testId="workstream-detail-missing"
          />
        ) : query.error || workstream === null ? (
          <InlineBanner
            message="작업 흐름을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="workstream-detail-error"
          />
        ) : (
          <div className="flex max-w-pane-lg flex-col">
            <section className="border-b border-line px-4 py-2">
              <div className="flex min-w-0 items-start gap-2">
                {/* The goal wraps and never truncates: it is the title of this
                    page, and half a goal is a different goal. */}
                <h1
                  className="min-w-0 flex-1 break-words text-title font-semibold text-ink"
                  data-testid="workstream-detail-goal"
                >
                  {workstream.goal}
                </h1>
                <span
                  className={cn(
                    "mt-1 shrink-0 rounded-sm px-2 py-px text-timestamp font-medium",
                    WORKSTREAM_STATUS_CLASS[workstream.status]
                  )}
                  data-testid="workstream-detail-status"
                  data-status={workstream.status}
                >
                  {WORKSTREAM_STATUS_LABEL[workstream.status]}
                </span>
              </div>
              <dl className="pt-1">
                <MetaRow label="채널" testId="workstream-detail-channel">
                  {channelDisplayName(
                    workstream.channelId,
                    [
                      ...channelsQuery.groups.channels,
                      ...channelsQuery.groups.dms,
                    ],
                    directoryQuery.directory,
                    session.member.id
                  )}
                </MetaRow>
                <MetaRow label="시작한 사람">
                  {actorOf(workstream.createdByMemberId).name}
                </MetaRow>
                <MetaRow label="실행">
                  <span data-numeric className="font-mono">
                    {workstream.runCount}
                  </span>
                  회 · 활성{" "}
                  <span data-numeric className="font-mono">
                    {workstream.activeRunCount}
                  </span>
                  {/* 참여자 is the actor-independence number: how many different
                      members ran this one goal. It is stated only once the run
                      list has actually arrived, because it is a claim about
                      that list and not about the workstream row. */}
                  {runsQuery.data !== undefined && (
                    <>
                      {" · 참여자 "}
                      <span
                        data-numeric
                        className="font-mono"
                        data-testid="workstream-detail-actors"
                      >
                        {actorCount(runs)}
                      </span>
                      명
                    </>
                  )}
                </MetaRow>
                <MetaRow label="마지막 갱신">
                  {relativeLabel(workstream.updatedAtMs, nowMs)}
                </MetaRow>
              </dl>
              <div className="mt-2 flex flex-wrap gap-2">
                {/* 대화가 정본 (ADR-0114): the thread is where this goal was
                    actually discussed, so the surface links to it instead of
                    reprinting it. The jump carries the anchor message id and
                    scrolls to that card once the timeline mounts it; if the
                    card is older than the loaded head the watcher expires
                    quietly and the reader is still in the right channel. */}
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to={messageAnchorPath(
                      workstream.channelId,
                      workstream.rootMessageId
                    )}
                    onClick={() => watchForMessageId(workstream.rootMessageId)}
                    data-testid="workstream-detail-anchor"
                  >
                    앵커 대화 열기
                  </Link>
                </Button>
              </div>
            </section>

            <ContinuationBlock
              runs={runs}
              hosts={hostsQuery.data}
              runsPending={runsQuery.isPending}
            />

            <section>
              <h2 className="px-4 py-2 text-meta text-ink-muted">실행 이력</h2>
              {runsQuery.isPending ? (
                <SkeletonRows rows={3} className="px-4 pb-4" />
              ) : runsQuery.error ? (
                <InlineBanner
                  message="실행 이력을 불러오지 못했습니다."
                  actionLabel="다시 시도"
                  onAction={() => void runsQuery.refetch()}
                  testId="workstream-runs-error"
                />
              ) : runs.length === 0 ? (
                <EmptyInvite
                  headline="아직 실행이 없습니다."
                  detail="채널 스레드에서 작업을 시작하면 이 목표의 첫 실행으로 기록됩니다."
                  testId="workstream-runs-empty"
                />
              ) : (
                <ul data-testid="workstream-run-list">
                  {runs.map((run) => {
                    const actor = actorOf(run.memberId);
                    return (
                      <RunRow
                        key={run.id}
                        run={run}
                        hosts={hostsQuery.data}
                        actorName={actor.name}
                        actorIsAgent={actor.isAgent}
                        nowMs={nowMs}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
