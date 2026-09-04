import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import {
  toolEntryState,
  WORK_LOG_ARGS_FOLDED_LABEL,
  WORK_LOG_ARGS_NAMES_HIDDEN_SENTENCE,
  WORK_LOG_ARGS_OPAQUE_SENTENCE,
  WORK_LOG_ARGS_TRUNCATED_SENTENCE,
  WORK_LOG_EMPTY_DETAIL,
  WORK_LOG_EMPTY_HEADLINE,
  WORK_LOG_SIGNAL_LOST_SENTENCE,
  WORK_LOG_TRUNCATED_HEAD_SENTENCE,
  WORK_LOG_VOLATILE_SENTENCE,
  workLogLiveness,
  workLogStateLabel,
  workPhaseLabel,
  type WorkEntry,
  type WorkLog,
  type WorkLogLiveness,
  type WorkPhaseEntry,
  type WorkTextEntry,
  type WorkToolEntry,
} from "@momo/core/features/agents/workLog";
import { formatMicroUsd } from "@momo/core/features/timeline/agentCardModel";
import { elapsedLabel } from "@momo/core/features/agents/workingSignal";
import {
  agentLabel,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from "@momo/core/features/agents/turnCopy";
import { useSession } from "@/app/session";
import { useInertRefWhile } from "@/app/inert";
import { memberNameParts, useDirectory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, Skeleton } from "@/features/common/States";
import { useAdeDrawerOpen } from "@/features/ade/adeDrawerStore";
import {
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { cn } from "@/design/lib/cn";
import { useTickingNow } from "./agentWorkingSignal";
import {
  closeWorkPanel,
  takeWorkPanelOpener,
  useWorkLog,
  useWorkPanelTarget,
} from "./workLogStore";

// =============================================================================
// 「작업 패널」 (goal WEB-WP1, 결정 정본 docs/planning/2026-08-04-work-panel-design.md).
//
// 성재: "결과만 전달하는 게 아니라 에이전트가 사고하는 과정 같은 것도 노출해서
// 내가 트래킹 가능하게 하는 그런 작업 패널." run 하나 = 패널 하나. `agent.status`의
// phase 전이, `agent.partial`의 부분 텍스트와 도구 단계, 비용 스냅샷이 도착한
// 순서대로 쌓인다.
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
//   3. 종료를 못 본 run을 완료라고 — TTL을 넘기면 "신호 소실"이지 "완료"가 아니다.
// =============================================================================

const PANEL_TITLE = "작업 패널";

export function AgentWorkPanel() {
  const target = useWorkPanelTarget();
  const log = useWorkLog(target);
  const { workspaceId, connStatus } = useSession();
  const { directory } = useDirectory(workspaceId);

  const railLive = connStatus === "connected";
  // 시계는 이 패널이 실제로 살아 있는 run을 그리는 동안에만 돈다. 죽은 소켓 위에서
  // 계속 세는 시계는 에이전트의 턴이 아니라 우리의 낙관을 재는 것이다. 신호가
  // 끊긴 뒤에도 도는 1Hz 타이머는 바뀔 수 없는 화면을 초당 한 번 다시 그린다.
  const liveness = log === null ? null : workLogLiveness(log, Date.now());
  const nowMs = useTickingNow(railLive && liveness === "live");

  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  // `origin`까지 키에 넣는다. 같은 run을 컴포저에서 열었다가 허브에서 다시 열면
  // 그것은 새로 연 것이고(openWorkPanel이 그렇게 판정한다), 키가 그대로면 이
  // 효과가 다시 돌지 않아 이미 사라진 컴포저 버튼을 가리킨 채로 남는다.
  const openKey =
    target === null ? null : `${target.runId.toLowerCase()}|${target.origin}`;

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
      className="work-panel-pane flex h-full flex-col border-l border-line bg-surface"
    >
      <PanelHeader
        name={name}
        log={log}
        // 시계는 **연 쪽이 알고 있던 시작 시각**으로 그린다. 패널이 붙는 시점에
        // 여는 프레임은 이미 지나갔으므로(그것이 잘림 고지의 근거다) 로그 자신은
        // 이 값을 가질 수 없다. 둘 다 없으면 시계를 그리지 않는다.
        startedAtMs={log?.startedAtMs ?? target.startedAtMs}
        nowMs={nowMs}
        railLive={railLive}
        onClose={close}
      />
      <PanelBody log={log} nowMs={nowMs} railLive={railLive} />
      <PanelFooter />
    </aside>
  );
}

function PanelHeader({
  name,
  log,
  startedAtMs,
  nowMs,
  railLive,
  onClose,
}: {
  name: string;
  log: WorkLog | null;
  startedAtMs?: number;
  nowMs: number;
  railLive: boolean;
  onClose: () => void;
}) {
  const liveness: WorkLogLiveness | null =
    log === null ? null : workLogLiveness(log, nowMs);
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
          className="tap-target flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-meta text-ink-muted">
        <span className="min-w-0 truncate text-agent" data-testid="agent-work-panel-agent">
          {name}
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
              railLive && liveness === "live" && log.state === "working" &&
                "bg-agent-soft text-agent",
              railLive &&
                liveness === "live" &&
                log.state === "awaiting_approval" &&
                "border border-warn text-warn",
              railLive && liveness === "signal_lost" && "border border-warn text-warn"
            )}
            data-testid="agent-work-panel-state"
            data-state={liveness === "live" ? log.state : liveness}
          >
            {workLogStateLabel(log, liveness)}
          </span>
        )}
        {/* 시계는 **작업 중일 때만** 돈다. 승인 대기에 초를 붙이면 읽는 사람은
            에이전트를 기다리라는 말로 읽는데, 실제로는 에이전트가 사람을
            기다리는 중이다. 컴포저 활동 줄이 같은 규칙을 쓰고, 두 표면이 같은
            턴에 대해 다른 말을 하지 않는 이유가 그것이다. */}
        {startedAtMs !== undefined &&
          liveness === "live" &&
          log?.state === "working" &&
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
    </header>
  );
}

function PanelBody({
  log,
  nowMs,
  railLive,
}: {
  log: WorkLog | null;
  nowMs: number;
  railLive: boolean;
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
  const liveness = workLogLiveness(log, nowMs);

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
      {log.truncatedHead && (
        <p
          className="break-keep border-b border-line px-4 py-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-truncated"
        >
          {WORK_LOG_TRUNCATED_HEAD_SENTENCE}
        </p>
      )}
      {log.droppedEntries > 0 && (
        <p
          className="break-keep px-4 pt-2 text-meta text-ink-muted"
          data-testid="agent-work-panel-dropped"
        >
          앞의 <span data-numeric>{log.droppedEntries}</span>개 항목은 자리에서
          밀려났습니다.
        </p>
      )}

      {log.entries.length === 0 ? (
        <EmptyInvite
          headline={WORK_LOG_EMPTY_HEADLINE}
          detail={WORK_LOG_EMPTY_DETAIL}
          testId="agent-work-panel-empty"
        />
      ) : (
        <ol className="flex flex-col" data-testid="agent-work-panel-entries">
          {log.entries.map((entry) => (
            <EntryRow
              key={entry.seq}
              log={log}
              entry={entry}
              liveness={liveness}
            />
          ))}
        </ol>
      )}

      {liveness === "signal_lost" && (
        <p
          className="break-keep px-4 py-2 text-meta text-warn"
          data-testid="agent-work-panel-signal-lost"
        >
          {WORK_LOG_SIGNAL_LOST_SENTENCE}
        </p>
      )}
    </div>
  );
}

/**
 * 이 패널이 아무것도 보관하지 않는다는 사실은 크롬이다. 스크롤 영역 안에 두면
 * 마지막 진행 항목처럼 읽히고, 스크롤을 내려야만 보이는 자리에 "이건 저장되지
 * 않습니다"를 두는 것은 사실상 숨기는 것이다.
 */
function PanelFooter() {
  return (
    <p
      className="break-keep border-t border-line px-4 py-2 text-timestamp text-ink-muted"
      data-testid="agent-work-panel-volatile"
    >
      {WORK_LOG_VOLATILE_SENTENCE}
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
          앞부분이 길어 잘렸습니다. 최근 내용만 남아 있습니다.
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
            className="tap-target flex items-center gap-1 rounded-sm py-1 text-timestamp text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
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

