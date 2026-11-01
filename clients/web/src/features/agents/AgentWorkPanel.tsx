import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import {
  toolEntryState,
  WORK_LOG_ARGS_FOLDED_LABEL,
  WORK_LOG_ARGS_NAMES_HIDDEN_SENTENCE,
  WORK_LOG_ARGS_OPAQUE_SENTENCE,
  WORK_LOG_ARGS_TRUNCATED_SENTENCE,
  WORK_LOG_CLIPPED_SENTENCE,
  WORK_LOG_DROPPED_SENTENCE,
  WORK_LOG_EMPTY_DETAIL,
  WORK_LOG_EMPTY_HEADLINE,
  WORK_LOG_QUIET_SENTENCE,
  WORK_LOG_TRUNCATED_HEAD_SENTENCE,
  workLogLiveness,
  workLogStateLabel,
  workLogTurnState,
  workPhaseLabel,
  type WorkEntry,
  type WorkLog,
  type WorkLogLiveness,
  type WorkPhaseEntry,
  type WorkTextEntry,
  type WorkToolEntry,
} from "@momo/core/features/agents/workLog";
import { formatMicroUsd } from "@momo/core/features/timeline/agentCardModel";
import {
  elapsedLabel,
  type ServerRunFacts,
} from "@momo/core/features/agents/workingSignal";
import {
  isSignalLostByServer,
  runPhaseDetail,
} from "@momo/core/features/agents/runPhase";
import { runDurationBreakdown } from "@momo/core/features/agents/runDuration";
import {
  agentLabel,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from "@momo/core/features/agents/turnCopy";
import {
  RUN_LEDGER_KEPT_SENTENCE,
  RUN_LEDGER_LIMIT_SENTENCE,
  RUN_LOCAL_ONLY_SENTENCE,
  RUN_STREAM_SENTENCE,
  runEmptyState,
  runList,
} from "@momo/core/features/agents/runLedger";
import type { AgentRunProgress, Channel, RosterMember } from "@momo/core/lib/api";
import { cancelWordingFor } from "@momo/core/features/agents/runCancel";
import { isOpenRunPhase } from "@momo/core/features/agents/runPhase";
import { useSession } from "@/app/session";
import { useInertRefWhile } from "@/app/inert";
import {
  memberFor,
  memberNameParts,
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { useApprovalCardPath } from "@/features/inbox/useInbox";
import { AgentLivenessBar } from "./AgentLivenessLabel";
import { EmptyInvite, Skeleton } from "@/features/common/States";
import { useAdeDrawerOpen } from "@/features/ade/adeDrawerStore";
import {
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { cn } from "@/design/lib/cn";
import { MemberAvatar } from "@/features/common/MemberAvatar";
import { useTickingNow } from "./agentWorkingSignal";
import {
  useChannelRuns,
  useRunFacts,
  useRunRow,
} from "./agentRunProgressStore";
import {
  ApprovalLink,
  ApprovalMissing,
  LedgerView,
  QueueAheadView,
  RunListView,
} from "./AgentRunLedgerView";
import { useRunLedger, type RunLedgerView } from "./useRunLedger";
import { OortRecordSection } from "./WorkTimelineView";
import { StopRunControl } from "./StopRunControl";
import {
  closeWorkPanel,
  switchWorkPanelRun,
  takeWorkPanelOpener,
  useWorkLog,
  useWorkPanelTarget,
} from "./workLogStore";

// =============================================================================
// 「작업 패널」 (goal WEB-WP1, 결정 정본 docs/planning/2026-08-04-work-panel-design.md).
//
// 성재: "결과만 전달하는 게 아니라 에이전트가 사고하는 과정 같은 것도 노출해서
// 내가 트래킹 가능하게 하는 그런 작업 패널." run 하나 = 패널 하나.
//
// 기록의 출처가 둘이다 (ADR-0200 U2).
//   - 서버가 아는 run(외부 hosted 에이전트): **서버 원장**이 기록이다. 가져감·단계·
//     승인·끝이 서버에 남으므로 패널을 닫아도, 다른 기기에서 열어도 같다. 같은
//     에이전트의 여러 run은 진행 중(병렬)·대기열(순서)·끝난 일로 나란히 선다.
//   - 서버가 모르는 run(관리형·BYOA·옛 서버): `agent.status`·`agent.partial`을
//     도착한 순서대로 접은 **이 화면만의 기록**이다. 패널을 닫으면 사라진다.
// 두 경우 모두, 에이전트가 보낸 글과 도구 호출은 저장하지 않으니 연 뒤에 도착한
// 것만 보인다.
//
// 터미널이 아니라 **구조화된 진행 스트림**이다(설계 문서 §2). 그래서 320px 열에
// 들어가고, 나중에 폰 시트가 같은 core 모듈을 소비할 수 있다.
//
// ## `features/work/WorkPanel.tsx`와 다른 표면이다 (이름이 닮았을 뿐)
//
//   AgentWorkPanel (여기)  「작업 패널」  = agent RUN 하나의 진행 스트림.
//                                          `agent:` 레일, 휘발, run 단위.
//   WorkPanel (features/work) 「작업 세션」 = ACP 작업 세션 목록과 관전 터미널.
//                                          `ch:` 레일의 work.* 프레임, 세션 단위.
//
// 둘은 데이터도 수명도 진입점도 다르다. 한쪽을 고치러 왔다가 다른 쪽을 열었다면
// 파일을 잘못 연 것이다.
//
// 이 표면이 절대 하지 않는 말 셋:
//   1. 앞부분을 다 봤다 — 여는 프레임을 못 봤으면 "이 지점부터 관전"을 먼저 적는다.
//   2. 승인 대기를 작업 중이라고 — 상태 어휘는 기존 경계 그대로다.
//   3. 종료를 못 본 run을 완료라고 — 서버가 아는 run은 서버의 phase가 말하고(대기
//      n번째 / 가져감 / 진행 중 / 승인 대기 / 끝), 서버가 모르는 run이 조용해지면
//      「조용함」이지 「완료」도 「끊김」도 아니다. 「신호 소실」은 서버가
//      lease_abandoned로 끝냈다고 알릴 때만 나온다.
// =============================================================================

const PANEL_TITLE = "작업 패널";

export function AgentWorkPanel() {
  const target = useWorkPanelTarget();
  const log = useWorkLog(target);
  // 서버가 이 run에 대해 답한 것(ADR-0200). 없으면 이 로그가 프레임에서 접은 것으로
  // 말한다.
  const server = useRunFacts(target?.runId ?? null);
  const { session, workspaceId, connStatus } = useSession();
  const { directory } = useDirectory(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const allChannels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups.channels, channelsQuery.groups.dms]
  );
  // 같은 채널·같은 에이전트의 run들. 서버가 모르는 채널이면 비어 있다.
  const channelRuns = useChannelRuns(target?.channelId ?? null);
  const runEntries = useMemo(
    () => (target === null ? [] : runList(channelRuns, target.memberId)),
    [channelRuns, target]
  );
  const progress = useRunRow(target?.runId ?? null);
  const ledger = useRunLedger(target?.runId ?? null, server);
  const cardHref = useApprovalCardPath(server?.approvalId);
  const selectRun = useCallback((row: AgentRunProgress) => {
    switchWorkPanelRun(row.id, row.agentMemberId);
  }, []);

  const railLive = connStatus === "connected";
  // 시계는 이 패널이 실제로 살아 있는 run을 그리는 동안에만 돈다. 죽은 소켓 위에서
  // 계속 세는 시계는 에이전트의 턴이 아니라 우리의 낙관을 재는 것이다. 신호가
  // 끊긴 뒤에도 도는 1Hz 타이머는 바뀔 수 없는 화면을 초당 한 번 다시 그린다.
  const liveness =
    log === null ? null : workLogLiveness(log, Date.now(), undefined, server);
  const nowMs = useTickingNow(railLive && liveness === "live");

  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  // 연 횟수(`session`)와 `origin`을 키에 넣는다. 같은 run을 컴포저에서 열었다가
  // 허브에서 다시 열면 그것은 새로 연 것이고(openWorkPanel이 그렇게 판정한다),
  // 키가 그대로면 이 효과가 다시 돌지 않아 이미 사라진 컴포저 버튼을 가리킨 채로
  // 남는다. 반대로 패널 안에서 run만 갈아 끼우면(`switchWorkPanelRun`) 같은 패널
  // 이므로 키가 그대로여야 한다 — 캐럿이 목록 버튼으로 돌아가는 일이 없도록.
  const openKey =
    target === null ? null : `${target.session ?? 0}|${target.origin}`;

  // 연 쪽으로 캐럿을 돌려준다(design/ui/dialog.tsx의 집 규칙). 진입점이 실제
  // 엘리먼트를 넘겨 주고, `document.activeElement` 추정은 폴백이다: WebKit은
  // 마우스 클릭으로 <button>에 포커스를 주지 않아 추정값이 <body>가 되는데,
  // 데스크톱 셸이 WKWebView라 배포 대상의 절반이 그쪽이다.
  useEffect(() => {
    if (openKey === null) {
      openerRef.current = null;
      return;
    }
    const handed = takeWorkPanelOpener();
    const active = document.activeElement;
    openerRef.current =
      handed ?? (active instanceof HTMLElement ? active : null);
    asideRef.current?.focus();
  }, [openKey]);

  const close = useCallback(() => {
    const opener = openerRef.current;
    closeWorkPanel();
    restoreDialogOpenerFocus(opener);
  }, []);

  // Escape는 aside 안에 캐럿이 있을 때만 듣는 것으로는 부족하다. 600px 아래에서
  // 이 패널은 라우트를 통째로 덮고, 포커스 없는 본문을 한 번 누르면
  // activeElement가 <body>로 가서 키보드 탈출로가 사라진다. 그래서 window에서
  // 듣되, **층 스택**을 통해 듣는다(`design/ui/escapeLayer`).
  //
  // 직접 리스너를 달던 판이 리뷰에 잡혔다(ADE 2단계 H1 ①): 관제 서랍도 같은
  // 타깃 같은 캡처 단계에 자기 리스너를 달았고, `stopPropagation`은 같은 노드의
  // 다른 리스너를 막지 못하므로 Esc 한 번에 서랍과 이 패널이 함께 닫혔다. 스택은
  // 맨 위 층에게만 넘긴다 — 서랍이 위에 있으면 서랍만, 그 다음 Esc가 이 패널을.
  const panelOpen = target !== null;
  useEscapeLayer(panelOpen, close);

  // 관제 서랍은 이 패널을 덮는다(1200px 아래에서는 통째로, 그 위에서는 스크림이).
  // 덮인 표면은 탭 순서에서 함께 빠진다 — 라우트에만 걸려 있던 그 규칙을 형제인
  // 이쪽도 받는다(리뷰 H1 ②: 600~899px에서 완전히 가려진 패널이 탭 순서에 남아
  // 있었다). 셸이 감싸는 상자를 세우는 대신 규칙만 나눠 쓰는 이유는
  // `useInertRefWhile` 주석에 있다.
  const coveredByAdeDrawer = useAdeDrawerOpen();
  useInertRefWhile(asideRef, coveredByAdeDrawer);

  if (target === null) return null;

  const name = agentLabel(
    memberNameParts(directory, target.memberId, UNKNOWN_AGENT_NAME)
  );

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      aria-label={PANEL_TITLE}
      data-testid="agent-work-panel"
      // Esc는 위 `useEscapeLayer` 한 곳에서만 받는다. 여기 있던 두 번째
      // onKeyDown은 스택이 서기 전의 잔재이고, 이제는 도달하지도 않는다: 층
      // 리스너가 캡처 단계에서 전파를 끊으므로 React의 루트 리스너까지 오지
      // 않는다. 같은 키를 두 곳에서 받는 코드는 한쪽만 고쳐지는 날이 온다.
      // `shrink-0`은 `work-panel-pane`이 flex 기준선을 갖게 되면서 빠졌다
      // (#1413). 320px은 원하는 폭이고, 라우트 상자가 자기 바닥에 닿으면 모자란
      // 폭은 이 패널이 낸다 — 근거는 tokens.css `--spacing-chat-min`.
      className="work-panel-pane flex h-full flex-col border-l border-line bg-pane"
    >
      <PanelHeader
        name={name}
        member={memberFor(directory, target.memberId) ?? null}
        agentId={target.memberId}
        log={log}
        // 시계는 **연 쪽이 알고 있던 시작 시각**으로 그린다. 패널이 붙는 시점에
        // 여는 프레임은 이미 지나갔으므로(그것이 잘림 고지의 근거다) 로그 자신은
        // 이 값을 가질 수 없다. 둘 다 없으면 시계를 그리지 않는다.
        startedAtMs={log?.startedAtMs ?? target.startedAtMs}
        nowMs={nowMs}
        railLive={railLive}
        server={server}
        listShown={runEntries.length > 1}
        onClose={close}
      />
      {/* 사람의 중단(#3852). 서버가 아는 열린 run에만 선다 — 서버가 모르는 run은
          열렸는지 닫혔는지 이 화면이 단정할 수 없다. run을 바꾸면 새로 그린다. */}
      <StopRunControl
        key={target.runId.toLowerCase()}
        runId={target.runId}
        agentName={name}
        open={server !== null && isOpenRunPhase(server.phase)}
        live={railLive}
        // 아직 아무도 가져가지 않은 요청은 「취소」, 가져간 뒤는 「중단」(#4285).
        wording={cancelWordingFor(server)}
      />
      <PanelBody
        log={log}
        nowMs={nowMs}
        railLive={railLive}
        server={server}
        progress={progress}
        ledger={ledger}
        runEntries={runEntries}
        selectedRunId={target.runId}
        onSelectRun={selectRun}
        cardHref={cardHref}
        channels={allChannels}
        directory={directory}
        selfMemberId={session.member.id}
      />
      <PanelFooter server={server !== null} />
    </aside>
  );
}

function PanelHeader({
  name,
  member,
  agentId,
  log,
  startedAtMs,
  nowMs,
  railLive,
  server,
  listShown,
  onClose,
}: {
  name: string;
  /** 머리의 아바타(#3821). 명부에 없으면 글자 없이 자리만 지킨다. */
  member: RosterMember | null;
  agentId: string;
  log: WorkLog | null;
  startedAtMs?: number;
  nowMs: number;
  railLive: boolean;
  server: ServerRunFacts | null;
  /** 여러 run 목록이 같은 근거 줄을 이미 말하고 있다. */
  listShown: boolean;
  onClose: () => void;
}) {
  const liveness: WorkLogLiveness | null =
    log === null ? null : workLogLiveness(log, nowMs, undefined, server);
  const turnState = log === null ? null : workLogTurnState(log, server);
  // 같은 일을 목록이 이미 한 줄로 말하고 있으면(여러 run) 머리는 낱말 칩만 둔다.
  // 한 run뿐일 때만 근거 줄이 머리에 선다 — 같은 문장이 머리·목록·기록에 세 번
  // 나오지 않게(design-review U2 L-2).
  const detail =
    server === null || listShown
      ? undefined
      : runPhaseDetail(server, nowMs, { omitAhead: server.phase === "queued" });
  return (
    <header className="flex flex-col gap-1 border-b border-line px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold">
          {PANEL_TITLE}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="작업 패널 닫기"
          data-testid="agent-work-panel-close"
          className="tap-target flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-meta text-ink-muted">
        <span className="flex min-w-0 items-center gap-2">
          <MemberAvatar member={member} size="sm" />
          <span className="min-w-0 truncate text-agent" data-testid="agent-work-panel-agent">
            {name}
          </span>
        </span>
        {log !== null && liveness !== null && (
          // 읽어 줄 값은 **상태 칩 하나뿐**이다. live 영역을 이 줄 전체로 잡으면
          // 옆의 1Hz 경과 시계가 그 안에 들어가고, 보조기술이 초당 한 번 숫자를
          // 낭독한다 — 컴포저 진입점 버튼에서 이름을 명시해 피한 함정의 live
          // 판본이다. 작업 중 → 승인 대기 → 신호 소실 전이는 사람이 기다리고 있는
          // 바로 그 사실이라 읽어 줄 값이 있고, 초 단위 숫자는 그렇지 않다.
          <span
            aria-live="polite"
            className={cn(
              "shrink-0 rounded-sm px-1 text-timestamp",
              !railLive && "text-ink-muted",
              railLive && liveness === "live" && turnState === "working" &&
                "bg-agent-soft text-agent",
              railLive &&
                liveness === "live" &&
                turnState === "awaiting_approval" &&
                "border border-warn text-warn",
              railLive &&
                liveness === "live" &&
                turnState === "queued" &&
                "border border-line-strong text-ink-muted",
              // 「신호 소실」(서버가 알렸을 때만)과 「조용함」(서버가 모르는 run일 때만)은
              // 사람이 할 일이 아니라 끝난 일·모르는 일의 사실이다. 경고색은 「승인
              // 대기」처럼 사람의 행동을 부르는 낱말의 색이라 쓰지 않는다
              // (design-review U1 M-1).
              railLive &&
                ((server !== null && isSignalLostByServer(server)) ||
                  liveness === "quiet") &&
                "border border-line-strong text-ink-muted"
            )}
            data-testid="agent-work-panel-state"
            data-state={liveness === "live" ? (turnState ?? log.state) : liveness}
          >
            {workLogStateLabel(log, liveness, server, nowMs)}
          </span>
        )}
        {/* 근거 한 줄: 서버가 준 사실(n분째 기다려요 · 앞에 m건 / 가져간 뒤 n분째 소식이
            없어요 / 마지막 보고 n분 전 / 끝난 사유). 판정이 아니라 사실이다. */}
        {detail !== undefined && (
          <span
            className="min-w-0 break-keep text-timestamp"
            data-testid="agent-work-panel-detail"
          >
            {detail}
          </span>
        )}
        {/* 시계는 **작업 중일 때만** 돈다. 승인 대기에 초를 붙이면 읽는 사람은
            에이전트를 기다리라는 말로 읽는데, 실제로는 에이전트가 사람을
            기다리는 중이다. 컴포저 활동 줄이 같은 규칙을 쓰고, 두 표면이 같은
            턴에 대해 다른 말을 하지 않는 이유가 그것이다. */}
        {/* 서버가 아는 run은 근거 줄이 이미 「12분째」를 말한다(#3824). 같은 시간을
            두 번, 두 말로(「12m 03s」) 하지 않는다. */}
        {server === null &&
          startedAtMs !== undefined &&
          liveness === "live" &&
          turnState === "working" &&
          railLive && (
            <span
              className="shrink-0 text-timestamp"
              data-numeric
              data-testid="agent-work-panel-elapsed"
            >
              {elapsedLabel(startedAtMs, nowMs)}
            </span>
          )}
        {log?.spentMicroUsd !== undefined && (
          <span
            className="shrink-0 text-timestamp"
            data-numeric
            data-testid="agent-work-panel-cost"
          >
            {formatMicroUsd(log.spentMicroUsd)}
          </span>
        )}
      </div>
      {/* 지금 살아 있는가(ADR-0200 D4)와 다시 깨우기: 이 일을 맡은 에이전트가 응답하는지.
          한 일의 상태(대기·가져감·작업 중)와 다른 사실이다. */}
      <AgentLivenessBar agentId={agentId} />
    </header>
  );
}

function PanelBody({
  log,
  nowMs,
  railLive,
  server,
  progress,
  ledger,
  runEntries,
  selectedRunId,
  onSelectRun,
  cardHref,
  channels,
  directory,
  selfMemberId,
}: {
  log: WorkLog | null;
  nowMs: number;
  railLive: boolean;
  server: ServerRunFacts | null;
  progress: AgentRunProgress | null;
  ledger: RunLedgerView;
  runEntries: ReturnType<typeof runList>;
  selectedRunId: string;
  onSelectRun: (row: AgentRunProgress) => void;
  cardHref: string | null;
  channels: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
}) {
  if (log === null) {
    // 스토어가 구독을 걸기 전의 한 프레임. 높이를 지키는 중립 막대이고 shimmer는
    // 없다(SKILL §5). 한 프레임짜리 상태이지만 자리를 비워 두면 이 분기가 길어질
    // 때 화면에 아무 말도 없는 패널이 남는다.
    return (
      <div className="min-h-0 flex-1" data-testid="agent-work-panel-opening">
        <Skeleton ready={false} rows={3} className="p-4" />
      </div>
    );
  }
  const liveness = workLogLiveness(log, nowMs, undefined, server);
  // 서버가 아는 run은 서버 원장이 기록이다. 이 화면이 프레임에서 접은 phase 줄은
  // 같은 사실을 두 번 말하게 되므로 뺀다. 글과 도구 호출만 남는다(서버는 저장하지
  // 않는다).
  const streamEntries =
    server === null ? log.entries : log.entries.filter((e) => e.kind !== "phase");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 컴포저 활동 줄과 **같은 문장에 같은 색**을 쓴다. 같은 상수를 한쪽은
          --warn으로, 한쪽은 --danger로 그리면 tokens.md §3a의 위계상 한 사실에
          대해 두 가지 위험도를 말하는 것이 되고, 그것이 이 상수를 core로 뽑은
          이유(turnCopy.ts)와 정면으로 어긋난다. */}
      {!railLive && (
        <p
          className="break-keep border-b border-line px-4 py-2 text-meta text-warn"
          data-testid="agent-work-panel-stale"
        >
          {TURN_STALE_SENTENCE}
        </p>
      )}

      {server !== null && runEntries.length > 1 && (
        <RunListView
          entries={runEntries}
          selectedRunId={selectedRunId}
          nowMs={nowMs}
          onSelect={onSelectRun}
        />
      )}
      {server !== null && server.phase === "awaiting_approval" &&
        (cardHref !== null ? <ApprovalLink href={cardHref} /> : <ApprovalMissing />)}
      {server !== null && server.phase === "queued" && progress !== null && (
        <QueueAheadView
          progress={progress}
          channels={channels}
          directory={directory}
          selfMemberId={selfMemberId}
        />
      )}

      {/* 걸린 시간(#3824): 대기 → 작업 → 총. 서버 시계의 사실만이고, 모르는 구간은
          「모름」이다. 근거 줄(머리·목록)이 지금 단계를 말한다면 이 줄은 run 전체를 말한다. */}
      {server !== null && (
        <p
          className="break-keep border-b border-line px-4 py-2 text-timestamp text-ink-muted"
          data-numeric
          data-testid="agent-work-panel-durations"
        >
          {runDurationBreakdown(server, nowMs)}
        </p>
      )}

      {server !== null ? (
        <section data-testid="agent-work-panel-record">
          <h3 className="px-4 pt-2 text-meta font-medium text-ink">기록</h3>
          <p
            className="break-keep px-4 pb-1 text-timestamp text-ink-muted"
            data-testid="agent-work-panel-kept"
          >
            {RUN_LEDGER_KEPT_SENTENCE}
          </p>
          {ledger.isLoading ? (
            <Skeleton ready={false} rows={3} className="p-4" />
          ) : ledger.rows.length === 0 ? (
            <EmptyInvite
              {...runEmptyState(progress)}
              testId="agent-work-panel-empty"
            />
          ) : (
            <LedgerView rows={ledger.rows} nowMs={nowMs} />
          )}
          {ledger.isError && (
            <p
              className="break-keep px-4 py-2 text-meta text-ink-muted"
              data-testid="agent-work-panel-ledger-error"
            >
              {/* 다시 읽겠다는 약속은 열린 run에서만 지킬 수 있다(끝난 run은 30초
                  타이머가 없다). 끝난 run에는 지킬 수 있는 말만 한다. */}
              기록을 읽지 못했어요.{" "}
              {isOpenRunPhase(server.phase)
                ? "잠시 뒤에 다시 읽어요."
                : "패널을 다시 열면 다시 읽어요."}
            </p>
          )}
        </section>
      ) : (
        <>
          {log.truncatedHead && (
            <p
              className="break-keep border-b border-line px-4 py-2 text-meta text-ink-muted"
              data-testid="agent-work-panel-truncated"
            >
              {WORK_LOG_TRUNCATED_HEAD_SENTENCE}
            </p>
          )}
          {log.entries.length === 0 && (
            <EmptyInvite
              headline={WORK_LOG_EMPTY_HEADLINE}
              detail={WORK_LOG_EMPTY_DETAIL}
              testId="agent-work-panel-empty"
            />
          )}
        </>
      )}

      {/* 서버가 직접 잰 도구 호출(#4654). 위 「기록」(수명주기·에이전트 단계)과 **다른 칸**이다: 출처가 달라
          한 목록에 섞지 않는다. 서버가 아는 run에만 서고, 원장을 아직 못 읽었으면 서지 않는다. */}
      {server !== null && ledger.tools !== null && (
        <OortRecordSection
          record={ledger.tools}
          open={isOpenRunPhase(server.phase)}
          nowMs={nowMs}
        />
      )}

      {log.droppedEntries > 0 && (
        <p
          className="break-keep px-4 pt-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-dropped"
        >
          앞의 <span data-numeric>{log.droppedEntries}</span>
          {WORK_LOG_DROPPED_SENTENCE}
        </p>
      )}

      {streamEntries.length > 0 && (
        <section data-testid="agent-work-panel-stream">
          {server !== null && (
            <>
              <h3 className="px-4 pt-3 text-meta font-medium text-ink">보낸 글과 도구 호출</h3>
              <p
                className="break-keep px-4 pb-1 text-timestamp text-ink-muted"
                data-testid="agent-work-panel-stream-limit"
              >
                {RUN_STREAM_SENTENCE}
              </p>
            </>
          )}
          <ol className="flex flex-col" data-testid="agent-work-panel-entries">
            {streamEntries.map((entry) => (
              <EntryRow
                key={entry.seq}
                log={log}
                entry={entry}
                liveness={liveness}
              />
            ))}
          </ol>
        </section>
      )}

      {liveness === "quiet" && (
        <p
          className="break-keep px-4 py-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-quiet"
        >
          {WORK_LOG_QUIET_SENTENCE}
        </p>
      )}
    </div>
  );
}

/**
 * 이 패널이 보여 주는 것의 한계는 크롬이다. 스크롤 영역 안에 두면 마지막 기록
 * 항목처럼 읽히고, 스크롤을 내려야만 보이는 자리에 한계를 두는 것은 사실상
 * 숨기는 것이다.
 *
 * 서버가 아는 run은 「에이전트가 보고한 만큼만」이 한계이고(기록은 서버에 남는다),
 * 서버가 모르는 run은 「이 화면에만 있다」가 한계다. 두 문장이 서로의 자리에
 * 서면 거짓이 된다: 서버에 남는 기록에 「닫으면 사라져요」를 붙이던 것이
 * 이 화면의 옛 결함이었다.
 */
function PanelFooter({ server }: { server: boolean }) {
  return (
    <p
      className="break-keep border-t border-line px-4 py-2 text-timestamp text-ink-muted"
      data-testid="agent-work-panel-limit"
    >
      {server ? RUN_LEDGER_LIMIT_SENTENCE : RUN_LOCAL_ONLY_SENTENCE}
    </p>
  );
}

function EntryRow({
  log,
  entry,
  liveness,
}: {
  log: WorkLog;
  entry: WorkEntry;
  liveness: WorkLogLiveness;
}) {
  return (
    <li
      className="border-b border-line px-4 py-2"
      data-testid="agent-work-panel-entry"
      data-kind={entry.kind}
      data-seq={entry.seq}
    >
      {entry.kind === "phase" && <PhaseRow entry={entry} />}
      {entry.kind === "text" && (
        <TextRow entry={entry} streaming={isTail(log, entry) && liveness === "live"} />
      )}
      {entry.kind === "tool" && (
        <ToolRow entry={entry} state={toolEntryState(log, entry, liveness)} />
      )}
    </li>
  );
}

function isTail(log: WorkLog, entry: WorkEntry): boolean {
  return log.entries[log.entries.length - 1]?.seq === entry.seq;
}

function PhaseRow({ entry }: { entry: WorkPhaseEntry }) {
  return (
    <p className="text-meta text-ink-muted" data-testid="agent-work-panel-phase">
      {workPhaseLabel(entry)}
    </p>
  );
}

function TextRow({
  entry,
  streaming,
}: {
  entry: WorkTextEntry;
  streaming: boolean;
}) {
  return (
    <div>
      {entry.clipped && (
        <p className="text-timestamp text-ink-muted">
          {WORK_LOG_CLIPPED_SENTENCE}
        </p>
      )}
      {/* `break-keep`만으로는 부족하다(tokens.md §4): keep-all은 한국어 어절을
          지켜 줄 뿐 끊을 수 없는 ASCII 덩어리에는 아무 일도 하지 않는데, 에이전트
          부분 응답에는 URL과 절대 경로가 흔하다. 320px 열에서 그것 하나가 패널
          바깥으로 넘치면 스크롤러의 overflow-x가 auto로 계산되어 가로 스크롤바가
          생긴다. 부모가 keep, 자식이 break-words가 이 레포의 짝이다. */}
      <p className="whitespace-pre-wrap break-keep break-words text-body">
        {entry.text}
        {/* 흐르는 중이라는 사실은 캐럿으로 말한다. shimmer 스켈레톤이 아니고,
            reduced-motion에서는 깜빡임 없이 그대로 서 있는다(tokens.css). */}
        {streaming && (
          <span
            aria-hidden="true"
            className="caret-stream ml-1 inline-block h-4 w-px bg-ink align-text-bottom"
            data-testid="agent-work-panel-caret"
          />
        )}
      </p>
    </div>
  );
}

const TOOL_STATE_LABEL: Readonly<Record<"running" | "passed" | "unknown", string>> =
  {
    running: "실행 중",
    passed: "다음 단계로",
    // 와이어에 결과 프레임이 없다. 뒤에 아무것도 오지 않은 채 신호가 끊겼거나
    // run이 닫혔으면 "다음 단계로"는 관측되지 않은 전이를 주장하는 것이다.
    unknown: "결과를 보지 못함",
  };

function ToolRow({
  entry,
  state,
}: {
  entry: WorkToolEntry;
  state: "running" | "passed" | "unknown";
}) {
  const [open, setOpen] = useState(false);
  const hasArgs = entry.argWithheld > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-meta">
          {entry.name}
        </span>
        <span
          className="shrink-0 text-timestamp text-ink-muted"
          data-testid="agent-work-panel-tool-state"
          data-tool-state={state}
        >
          {TOOL_STATE_LABEL[state]}
        </span>
      </div>
      {hasArgs && (
        <div>
          {/* `src/design/ui`에 Collapsible 프리미티브가 없어서 버튼 + 조건부
              렌더로 직접 그린다(SKILL §1: 프리미티브가 못 하는 것을 한 줄로).
              `<details>`를 쓰지 않는 이유는 AgentCard와 달리 이 자리가 목록 항목
              안이고, summary의 기본 마커/커서가 행 문법과 어긋나기 때문이다. */}
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            data-testid="agent-work-panel-args-toggle"
            className="tap-target flex items-center gap-1 rounded-sm py-1 text-timestamp text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
          >
            {open ? (
              <ChevronDown className="size-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3" aria-hidden="true" />
            )}
            {WORK_LOG_ARGS_FOLDED_LABEL}
          </button>
          {open && (
            <div data-testid="agent-work-panel-args">
              {/* 펼쳐도 나오는 것은 **이름과 개수**뿐이다. 값은 core가 아예
                  들고 오지 않는다(workLog.WorkToolEntry). AgentCard의 원본 데이터
                  디스클로저와 같은 모양이고 같은 문장이다. */}
              {entry.argFields.length > 0 && (
                <ul className="flex flex-wrap gap-2 pt-1">
                  {entry.argFields.map((field) => (
                    <li
                      key={field}
                      className="rounded-sm bg-surface-hover px-1 font-mono text-timestamp"
                    >
                      {field}
                    </li>
                  ))}
                </ul>
              )}
              <p className="break-keep pt-1 text-timestamp text-ink-muted">
                <span data-numeric data-testid="agent-work-panel-args-withheld">
                  값 {entry.argWithheld}개 숨김.{" "}
                </span>
                {WORK_LOG_ARGS_OPAQUE_SENTENCE}
                {entry.argFieldsHidden > 0 && (
                  <>
                    {" "}
                    <span data-testid="agent-work-panel-args-names-hidden">
                      {WORK_LOG_ARGS_NAMES_HIDDEN_SENTENCE}
                    </span>{" "}
                    <span data-numeric>이름 {entry.argFieldsHidden}개.</span>
                  </>
                )}
                {entry.argsTruncated ? ` ${WORK_LOG_ARGS_TRUNCATED_SENTENCE}` : ""}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

