import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  messageAnchorPath,
  watchForMessageId,
  workSessionPath,
} from "@/features/inbox/anchor";
import { relativeLabel } from "@momo/core/features/inbox/model";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { HostPicker } from "@/features/work/HostPicker";
import { TakeoverDisclosure } from "@/features/work/TakeoverDisclosure";
import {
  HANDOFF_COPY,
  takeoverFailureCopy,
} from "@momo/core/features/work/sessionHandoff";
import { useWorkHosts } from "@/features/work/useWorkSessions";
import {
  workHostName,
  workSessionStatus,
} from "@momo/core/features/work/workSessionModel";
import { SESSION_STATUS_CLASS } from "@momo/core/features/work/workSessionFormat";
import { particleFor } from "@momo/core/lib/koreanParticle";
import {
  ApiError,
  resumeWorkSession,
  type WorkHost,
  type WorkstreamRun,
  type WorkstreamStatus,
} from "@momo/core/lib/api";
import {
  WORKSTREAM_STATUS_CLASS,
  WORKSTREAM_STATUS_LABEL,
  actorCount,
  channelDisplayName,
  continuationBlockedCopy,
  continuationState,
  isWorkstreamMissing,
  runClockLabel,
  workstreamActor,
  type WorkstreamActor,
} from "@momo/core/features/workstreams/model";
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
  channelId,
  actor,
  nowMs,
}: {
  run: WorkstreamRun;
  hosts: WorkHost[] | undefined;
  /** 이 목표의 앵커 채널. 실행이 사는 작업 세션 패널이 거기에 있다. */
  channelId: string;
  actor: WorkstreamActor;
  nowMs: number;
}) {
  const status = workSessionStatus(run);
  return (
    <li
      className="border-b border-line"
      data-testid="workstream-run-row"
      data-run-id={run.id}
      data-member-id={run.memberId}
      data-status={run.status}
    >
      {/* 행은 링크다 (PR 918 R1 M5). v1의 이력은 읽을 수만 있고 갈 데가 없었다 —
          한 실행이 무엇을 했는지, 지금 무엇을 하고 있는지는 이 표면이 아니라
          작업 세션 상세와 관전 터미널이 답하는 질문인데, 원장에서 거기로 가는
          길이 없어서 채널을 찾아 패널을 열고 같은 세션을 다시 고르는 것이
          유일한 경로였다. 목록 행이 상세로 가는 것과 같은 형태로, 같은
          hover·focus 계약으로 간다. */}
      <Link
        to={workSessionPath(channelId, run.id)}
        className="flex flex-col px-4 py-2 transition-colors hover:bg-surface-hover focus-visible:focus-ring"
        data-testid="workstream-run-link"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            {/* Agent identity is the --agent token on the name and nothing else:
                same row, same type, no second background (design-taste-web §9).
                It matters here more than anywhere: "A → 에이전트 → C" is the
                sentence this list exists to make readable. */}
            <span
              className={cn(
                "min-w-0 truncate text-body",
                actor.isAgent ? "text-agent" : "text-ink"
              )}
              data-testid="workstream-run-actor"
            >
              {actor.name}
            </span>
            {/* 그 에이전트를 누가 책임지는가 (skill §9, PR 918 R1 M6). 원장의
                요점이 "A -> 에이전트 -> C"인데 가운데 칸에 책임 주체가 없으면,
                인수를 물어볼 사람이 화면에 없다. 문장은 멤버 디렉터리·
                타임라인이 이미 쓰는 것과 같다. */}
            {actor.ownerName !== null && (
              <span
                className="min-w-0 truncate text-meta text-ink-muted"
                data-testid="workstream-run-owner"
              >
                {actor.ownerName} 님이 관리
              </span>
            )}
          </span>
          {/* 계보 칩도 같은 낱말이다 (ADR-0154 D3). 이 행을 만든 act 가 바로 위
              블록의 「인수」인데 그 결과물이 「이어받음」으로 적히면, 한 화면이 한
              act 를 두 이름으로 부르는 이 티켓의 결함이 원장 안에서 다시 산다. */}
          {run.resumedFromSessionId !== undefined && (
            <span
              className={cn(CHIP_CLASS, "bg-surface-hover text-ink-muted")}
              data-testid="workstream-run-lineage"
            >
              인수함
            </span>
          )}
          <span
            className={cn(CHIP_CLASS, SESSION_STATUS_CLASS[status.key])}
            data-testid="workstream-run-status"
          >
            {status.label}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
          <span className="min-w-0 truncate">{run.label}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{run.tool}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0" data-testid="workstream-run-host">
            {workHostName(run, hosts) ?? "알 수 없는 호스트"}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-1 text-meta text-ink-muted">
          <span className="shrink-0">시작</span>
          <RunClockLabel at={run.startedAtMs} nowMs={nowMs} />
          {run.endedAtMs !== undefined && (
            <>
              <span className="shrink-0">· 종료</span>
              <RunClockLabel at={run.endedAtMs} nowMs={nowMs} />
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * 이 표면에는 인수 블록이 하나뿐이므로 id는 상수다. 토글이 `aria-controls`로
 * 이 그룹을 가리키고, 그룹은 눈에 보이는 라벨을 `aria-labelledby`로 되짚는다.
 */
const HOST_GROUP_ID = "workstream-continue-hosts";
const HOST_GROUP_LABEL_ID = "workstream-continue-hosts-label";

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
  const errorRef = useRef<HTMLParagraphElement>(null);

  const state = continuationState(
    runs,
    hosts ?? [],
    session.member.id,
    offline,
    status
  );

  // 성공하면 방금 누른 버튼이 사라진다. 인수가 성공한 순간 그 실행은 더 이상
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

  // 실패 경로에도 같은 복구가 필요하다 (2R H1). 1R의 "실패하면 버튼이 그대로
  // 있다"는 확정 버튼이 진행 중에 disabled가 되지 않게 된 지금은 대체로 참이지만,
  // 항상 참은 아니다: 마지막 자격 호스트에서 실패하면 `state.kind`가 ready를
  // 벗어나면서 그 버튼도 함께 언마운트된다(바로 그래서 오류 문장이 ready 가지
  // 바깥에 산다). 그때만 오류 문장이 포커스를 받는다 — 버튼이 살아남아 사람이
  // 아직 그것을 쥐고 있으면 빼앗지 않는다. stranded 판정은 WorkPanel이 스코프
  // 변경에서 쓰는 것과 같은 형태다.
  useEffect(() => {
    if (error === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    errorRef.current?.focus({ preventScroll: true });
  }, [error]);

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
        // 형제 표면과 **같은 번역기**다 (R1 H1). 이 자리에 있던
        // `continuationErrorCopy` 는 상태 코드만 봤고, 서버가 409 하나로 말하는
        // 세 가지 — 상태 변화 · `pool_exhausted` · `member_limit` — 에 전부
        // 「이력을 새로고침하세요」라고 답했다. 슬롯이 찬 사람에게 그것은 아무리
        // 반복해도 풀리지 않는 지시다.
        setError(
          takeoverFailureCopy(
            cause instanceof ApiError ? cause.status : undefined,
            cause instanceof Error ? cause.message : undefined
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
        <h2 className="pb-1 text-meta text-ink-muted">{HANDOFF_COPY.takeover.verb}</h2>
        <p className="break-words text-meta text-ink-muted">
          실행 이력을 확인한 뒤에 인수할 수 있는지 알려 드립니다.
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
      <h2 className="pb-1 text-meta text-ink-muted">{HANDOFF_COPY.takeover.verb}</h2>
      {/* The outcome lines sit ABOVE the branch, not inside its ready arm. A
          successful takeover ends the very state that offered it — the source
          Run stops being orphaned the moment the server records the new one —
          so a confirmation nested in that arm would be unmounted by its own
          success, and the error of a takeover that failed on the last eligible
          host would vanish the same way. */}
      {error !== null && (
        <p
          ref={errorRef}
          tabIndex={-1}
          className="mb-2 break-words text-meta text-danger focus-visible:focus-ring"
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
          className="mb-2 break-words text-meta text-ok focus-visible:focus-ring"
          role="status"
          data-testid="workstream-continue-done"
        >
          인수했습니다. 아래 실행 이력에 내 실행이 추가됐습니다.
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
            {particleFor(state.run.label, "object")} 새 호스트로 인수합니다.
            새 실행으로 기록되고, 이 목표의 이력에 내 이름이 함께 남습니다.
          </p>
          {/* 작업 세션 패널이 같은 act 앞에서 세우는 것과 **같은 컴포넌트**다.
              "한 글자까지 같게 쓴다"는 규율은 지켜졌지만 두 벌이라는 사실은
              그대로였고, 그래서 둘 다 틀린 채로 같이 늙었다: 실제로 이어지는
              것은 「Git 계보」가 아니라 스레드다(서버가 원본의
              `root_message_id`를 그대로 쓴다). 이제 문장이 아니라 목록이고,
              고칠 자리는 한 곳이다(#1137). */}
          <TakeoverDisclosure testId="workstream-continue-disclosure" />
          {/* 열기 전에는 이 토글이 블록의 결정이므로 채움이고, 열린 뒤에는
              결정이 호스트 버튼으로 옮겨가므로 ghost로 물러난다. v1은 둘이 같은
              outline·같은 size라, `호스트 선택 닫기`와 `성재 맥북`이 같은 무게로
              쌓였다(PR 918 R1 M3, skill §8 "default action emphasized"). */}
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant={open ? "ghost" : "default"}
              size="sm"
              aria-expanded={open}
              {...(open ? { "aria-controls": HOST_GROUP_ID } : {})}
              disabled={pendingHostId !== null}
              onClick={() => {
                setError(null);
                setOpen((current) => !current);
              }}
              data-testid="workstream-continue-toggle"
            >
              {open ? "호스트 선택 닫기" : HANDOFF_COPY.takeover.button}
            </Button>
          </div>
          {open && (
            <HostPicker
              id={HOST_GROUP_ID}
              labelId={HOST_GROUP_LABEL_ID}
              copy={{
                group: "인수할 호스트",
                confirm: HANDOFF_COPY.takeover.button,
                action: (name) => `${name}에서 인수`,
                busy: (name) => `${name}에서 인수하는 중`,
              }}
              targets={state.targets}
              busyHostId={pendingHostId}
              onPick={(hostId) => void takeOver(state.run, hostId)}
              groupTestId="workstream-continue-targets"
              selectTestId="workstream-continue-host-select"
              confirmTestId="workstream-continue-confirm"
            />
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
      className="flex items-center gap-1 text-meta text-ink-muted hover:text-ink focus-visible:focus-ring"
      data-testid="workstream-detail-back"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      작업 흐름
    </Link>
  );


  /** Who ran it, named by the rule the whole surface shares (model.ts). */
  const actorOf = (memberId: string) =>
    workstreamActor(directoryQuery.directory, memberId);

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid="workstream-detail-route"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <SidebarDrawerToggle />
        {back}
      </header>

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
          /* 이 분기와 아래 오류 분기에는 목표가 없다. 목표가 이 페이지의 h1인데
             (아래 성공 분기) 그 두 분기는 h1을 하나도 렌더하지 않아, 문서에
             제목이 없는 라우트가 됐다(PR 918 R1 Low). 그 자리를 대신 차지한
             문장이 곧 이 페이지의 제목이므로 그 문장이 h1을 받는다. 목록의 빈
             상태들은 헤더의 h1이 아직 화면에 있으므로 받지 않는다 — 규칙은
             "페이지를 대신했는가"이지 "빈 상태인가"가 아니다. */
          <EmptyInvite
            heading
            headline="이 작업 흐름을 찾을 수 없습니다."
            detail="주소가 오래됐거나, 내가 속한 채널의 작업 흐름이 아닙니다."
            actions={
              <Button variant="outline" size="sm" asChild>
                {/* 동사로 끝나는 라벨(skill §7). 명사구 `작업 흐름 목록`은
                    버튼이 아니라 표지판처럼 읽힌다. */}
                <Link to="/workstreams">작업 흐름 목록 보기</Link>
              </Button>
            }
            testId="workstream-detail-missing"
          />
        ) : query.error || workstream === null ? (
          <InlineBanner
            heading
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
                    CHIP_CLASS,
                    "mt-1",
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
                  {runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      hosts={hostsQuery.data}
                      channelId={workstream.channelId}
                      actor={actorOf(run.memberId)}
                      nowMs={nowMs}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
