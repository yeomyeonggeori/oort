import { useCallback, useEffect, useRef, useState } from "react";
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
  type WorkstreamStatus,
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
    // 한국어 산문이 섞이는 값(채널 이름, 사람 이름)이 들어오므로 음절이 아니라
    // 어절에서 끊는다(MOMO-676 M-5). keep-all은 이 행에, break-words는 dd에:
    // 둘은 tailwind-merge의 같은 `break` 그룹이라 한 엘리먼트에 함께 두면 끊기지
    // 않는 긴 토큰을 받아내는 쪽이 조용히 사라진다(common/States.tsx의 형태).
    <div className="flex flex-wrap items-baseline gap-2 break-keep py-1">
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
  status,
}: {
  runs: WorkstreamRun[];
  hosts: WorkHost[] | undefined;
  runsPending: boolean;
  /** 목표 자체의 상태. 실행 원장이 답할 수 없는 첫 번째 질문이다. */
  status: WorkstreamStatus;
}) {
  const { session, workspaceId } = useSession();
  const offline = useOffline();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingHostId, setPendingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const doneRef = useRef<HTMLParagraphElement>(null);

  const state = continuationState(
    runs,
    hosts ?? [],
    session.member.id,
    offline,
    status
  );

  // 성공하면 방금 누른 버튼이 사라진다. 이어받기가 성공한 순간 그 실행은 더 이상
  // 고아가 아니고, 상태가 `ready`에서 `no-stopped-run`으로 넘어가면서 호스트 목록도
  // 토글 버튼도 언마운트되기 때문이다. 아무것도 하지 않으면 포커스는 <body>로
  // 떨어지고, 키보드 사용자는 안내만 듣고 문서 최상단에 남는다(1R M2). 오류
  // 경로에는 이 문제가 없다 — 실패하면 버튼이 그대로 있다.
  //
  // 그래서 방금 누른 것을 대신한 자리, 즉 결과 문장으로 포커스를 옮긴다. 집의
  // 형태 그대로다: tabIndex=-1 + 프로그램적 포커스 + 토큰 링
  // (common/RenderErrorBoundary, settings/InviteSection). Chromium은 직전 입력이
  // 키보드였을 때만 :focus-visible을 매칭하므로, 마우스로 누른 사람은 링을 보지
  // 않는다. 이 자리에서 Tab을 누르면 새 실행이 추가된 실행 이력으로 들어간다.
  useEffect(() => {
    if (done && error === null) doneRef.current?.focus({ preventScroll: true });
  }, [done, error]);

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

  // 끝난 목표에는 이력을 기다릴 이유가 없다. 목표의 상태는 이 페이지가 이미
  // 렌더하고 있는 사실이고, 완료된 목표 아래에서 "확인한 뒤에 알려 드립니다"는
  // 결국 오지 않을 답을 기다리게 하는 문장이다.
  if (runsPending && state.kind !== "closed") {
    return (
      // 이 블록은 이 표면에서 가장 긴 한국어 산문을 담는다. 어절에서 끊는 규칙은
      // section이 갖고(word-break는 상속된다), 긴 토큰을 받아내는 break-words는
      // 각 문단이 갖는다 — 한 엘리먼트에 함께 두면 tailwind-merge가 하나를
      // 지운다(MOMO-676 M-5, common/States.tsx).
      <section
        className="break-keep border-b border-line px-4 py-2"
        data-testid="workstream-continue"
        data-state="pending"
      >
        <h2 className="pb-1 text-meta text-ink-muted">이어받기</h2>
        <p className="break-words text-meta text-ink-muted">
          실행 이력을 확인한 뒤에 이어받을 수 있는지 알려 드립니다.
        </p>
      </section>
    );
  }

  return (
    <section
      className="break-keep border-b border-line px-4 py-2"
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
          className="mb-2 break-words text-meta text-danger"
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
          ref={doneRef}
          tabIndex={-1}
          className="mb-2 break-words text-meta text-ok focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          role="status"
          data-testid="workstream-continue-done"
        >
          이어받았습니다. 아래 실행 이력에 내 실행이 추가됐습니다.
        </p>
      )}
      {state.kind !== "ready" ? (
        <p
          className="break-words text-meta text-ink-muted"
          data-testid="workstream-continue-blocked"
        >
          {continuationBlockedCopy(state)}
        </p>
      ) : (
        <>
          {/* The label is user data and decides its own particle: this roster
              runs 회귀 재현 and codex-workbench side by side, and "codex를" is
              a machine refusing to read what it just printed. */}
          <p className="break-words text-meta text-ink">
            멈춘 실행{" "}
            <span className="text-ink-muted">{state.run.label}</span>
            {particleFor(state.run.label, "object")} 새 호스트에서 이어받습니다.
            새 실행으로 기록되고, 이 목표의 이력에 내 이름이 함께 남습니다.
          </p>
          {/* The same two sentences the 작업 세션 패널 says before a lineage
              resume, deliberately word for word: one surface promising less
              than the other about the same act is how a reader learns which one
              to distrust. */}
          <p className="mt-1 break-words text-meta text-ink-muted">
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
              {/* 목표는 사람이 쓴 한국어 문장이다. keep-all이 없으면 96자짜리
                  목표에서 `추가한다`가 `추가`/`한다`로 쪼개졌다(1280·900에서
                  재현, 1R H3). 규칙은 부모가, break-words는 h1이 갖는다:
                  tailwind-merge가 둘을 한 그룹으로 접기 때문이다
                  (common/States.tsx가 세운 형태). */}
              <div className="flex min-w-0 items-start gap-2 break-keep">
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
              status={workstream.status}
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
