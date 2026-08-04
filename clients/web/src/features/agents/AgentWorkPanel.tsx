import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import {
  toolEntryState,
  WORK_LOG_ARGS_FOLDED_LABEL,
  WORK_LOG_ARGS_TRUNCATED_SENTENCE,
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
import { memberNameParts, useDirectory } from "@/features/workspace/useWorkspace";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";
import { useTickingNow } from "./agentWorkingSignal";
import { closeWorkPanel, useWorkLog, useWorkPanelTarget } from "./workLogStore";

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
  // 계속 세는 시계는 에이전트의 턴이 아니라 우리의 낙관을 재는 것이다.
  const ticking =
    railLive && log !== null && log.closed === undefined;
  const nowMs = useTickingNow(ticking);

  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openKey = target === null ? null : target.runId.toLowerCase();

  // 연 쪽으로 캐럿을 돌려준다(design/ui/dialog.tsx의 집 규칙). 패널을 여는 순간의
  // activeElement가 그 자리다.
  useEffect(() => {
    if (openKey === null) {
      openerRef.current = null;
      return;
    }
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    asideRef.current?.focus();
  }, [openKey]);

  const close = useCallback(() => {
    const opener = openerRef.current;
    closeWorkPanel();
    if (opener?.isConnected) opener.focus();
  }, []);

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
      className="work-panel-pane flex h-full shrink-0 flex-col border-l border-line bg-surface"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
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
          className="tap-target flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-baseline gap-2 text-meta text-ink-muted">
        <span className="min-w-0 truncate text-agent" data-testid="agent-work-panel-agent">
          {name}
        </span>
        {log !== null && liveness !== null && (
          <span
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
        {startedAtMs !== undefined && liveness === "live" && railLive && (
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
    // 스토어가 아직 이 run을 열지 않은 한 프레임. 로딩 막대를 그리는 대신 아무
    // 주장도 하지 않는다.
    return <div className="min-h-0 flex-1" data-testid="agent-work-panel-opening" />;
  }
  const liveness = workLogLiveness(log, nowMs);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!railLive && (
        <InlineBanner
          tone="error"
          message={TURN_STALE_SENTENCE}
          testId="agent-work-panel-stale"
        />
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
          headline="아직 이 run에서 온 진행이 없습니다."
          detail={WORK_LOG_VOLATILE_SENTENCE}
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
      <p className="break-keep px-4 py-2 text-timestamp text-ink-muted">
        {WORK_LOG_VOLATILE_SENTENCE}
      </p>
    </div>
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
      <p className="whitespace-pre-wrap break-keep text-body">
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

function ToolRow({
  entry,
  state,
}: {
  entry: WorkToolEntry;
  state: "running" | "passed";
}) {
  const [open, setOpen] = useState(false);
  const hasArgs = entry.args !== undefined;
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
          {state === "running" ? "실행 중" : "다음 단계로"}
        </span>
      </div>
      {hasArgs && (
        <div>
          {/* 인자는 기본 접힘이다(설계 문서 §4): 경로와 프롬프트가 그대로 들어
              있을 수 있어서, 펼치는 것은 사람의 명시적 행동이어야 한다. */}
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            data-testid="agent-work-panel-args-toggle"
            className="flex items-center gap-1 rounded-sm text-timestamp text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {open ? (
              <ChevronDown className="size-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3" aria-hidden="true" />
            )}
            {WORK_LOG_ARGS_FOLDED_LABEL}
          </button>
          {open && (
            <pre
              className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-sm bg-surface-hover px-2 py-1 font-mono text-timestamp"
              data-testid="agent-work-panel-args"
            >
              {formatArgs(entry.args)}
            </pre>
          )}
          {open && entry.argsTruncated && (
            <p className="text-timestamp text-ink-muted">
              {WORK_LOG_ARGS_TRUNCATED_SENTENCE}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 인자를 읽을 수 있는 텍스트로. 카드 표면이 아니라 명시적으로 펼친 자리다. */
function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return "읽을 수 없는 형식입니다.";
  }
}
