import { Link } from "react-router-dom";
import { uuidEq, type AgentRunProgress, type Channel } from "@momo/core/lib/api";
import {
  clockLabel,
  queueAhead,
  RUN_LIST_SECTION_LABEL,
  type RunLedgerRow,
  type RunListEntry,
  type RunListSection,
} from "@momo/core/features/agents/runLedger";
import {
  runPhaseDetail,
  runPhaseLabel,
  serverFactsOf,
  turnStateOfPhase,
} from "@momo/core/features/agents/runPhase";
import { channelLabelParts } from "@/features/workspace/useWorkspace";
import type { Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { useRunRow } from "./agentRunProgressStore";

// =============================================================================
// 작업 패널의 서버 기록 쪽 (ADR-0200 U2, #3748). 규칙(구역·순서·문장)은 core의
// `runLedger`가 갖고, 여기는 그것을 320px 열에 그리는 일뿐이다.
//
// 이 파일의 모든 줄은 **서버가 기억하는 것**이다. 패널을 닫아도, 다른 기기에서
// 열어도 같다. 에이전트가 `stage`로 보낸 문자열은 일반 텍스트로만 그린다(서버도
// 80자·신뢰하지 않는 텍스트로 취급한다).
// =============================================================================

const STATE_CHIP: Readonly<Record<string, string>> = {
  working: "bg-agent-soft text-agent",
  awaiting_approval: "border border-warn text-warn",
  queued: "border border-line-strong text-ink-muted",
  ended: "border border-line-strong text-ink-muted",
};

/** 낱말 칩의 색. 사람이 할 일(승인 대기)만 경고색이다. */
function chipClass(progress: AgentRunProgress): string {
  const state = turnStateOfPhase(progress.phase) ?? "ended";
  return STATE_CHIP[state];
}

function summaryOf(progress: AgentRunProgress | null): string {
  const text = progress?.triggerSummary?.trim();
  return text === undefined || text === "" ? "요청" : text;
}

// ---- 여러 run: 진행 중(병렬) · 대기열(순서) · 끝난 일 -----------------------------

export function RunListView({
  entries,
  selectedRunId,
  nowMs,
  onSelect,
}: {
  entries: readonly RunListEntry[];
  selectedRunId: string;
  nowMs: number;
  onSelect: (progress: AgentRunProgress) => void;
}) {
  const sections: RunListSection[] = ["active", "queue", "done"];
  return (
    <nav
      aria-label="이 에이전트의 일"
      className="border-b border-line"
      data-testid="agent-work-panel-runs"
    >
      {sections.map((section) => {
        const rows = entries.filter((entry) => entry.section === section);
        if (rows.length === 0) return null;
        return (
          <section key={section} data-testid="agent-work-panel-runs-section" data-section={section}>
            <h3 className="px-4 pt-2 text-timestamp text-ink-muted">
              {RUN_LIST_SECTION_LABEL[section]}
              {section === "active" && rows.length > 1 ? (
                <span data-numeric> {rows.length}</span>
              ) : null}
            </h3>
            <ul>
              {rows.map(({ runId, progress }) => {
                const facts = serverFactsOf(progress);
                const detail = runPhaseDetail(facts, nowMs);
                const selected = uuidEq(runId, selectedRunId);
                return (
                  <li key={runId}>
                    <button
                      type="button"
                      onClick={() => onSelect(progress)}
                      aria-current={selected ? "true" : undefined}
                      data-testid="agent-work-panel-run"
                      data-run-id={runId}
                      data-selected={selected ? "" : undefined}
                      className={cn(
                        // 전폭 행은 눌림을 채움으로 말하고 크기는 바꾸지 않는다(B4-3).
                        "flex w-full min-w-0 flex-col gap-1 px-4 py-2 text-left active:bg-surface-pressed focus-visible:focus-ring",
                        selected ? "bg-surface-hover" : "hover:bg-surface-hover"
                      )}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-meta text-ink">
                          {summaryOf(progress)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-sm px-1 text-timestamp",
                            chipClass(progress)
                          )}
                        >
                          {runPhaseLabel(facts)}
                        </span>
                      </span>
                      {detail !== undefined && (
                        <span className="break-keep text-timestamp text-ink-muted">
                          {detail}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

// ---- 대기열 앞의 일 -----------------------------------------------------------

function AheadRow({
  runId,
  channelId,
  channels,
  directory,
  selfMemberId,
}: {
  runId: string;
  channelId: string;
  channels: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
}) {
  const row = useRunRow(runId);
  const channel = channels.find((c) => uuidEq(c.id, channelId));
  const place = channel ? channelLabelParts(channel, directory, selfMemberId) : null;
  const placeText = place ? (channel?.kind === "dm" ? place.text : `#${place.text}`) : null;
  return (
    <li
      className="flex min-w-0 items-baseline gap-2 px-4 py-1 text-meta"
      data-testid="agent-work-panel-ahead-row"
    >
      <span className="min-w-0 flex-1 truncate text-ink">{summaryOf(row)}</span>
      {placeText !== null && (
        <span className="shrink-0 text-timestamp text-ink-muted">{placeText}</span>
      )}
    </li>
  );
}

/**
 * 아직 아무도 가져가지 않은 run의 앞. **내 채널의 일은 자세히, 아닌 것은 건수만**
 * (ADR-0200 D3, 성재 결재 4). 이름을 말할 수 없는 일의 제목·채널을 짐작해서 적지
 * 않는다.
 */
export function QueueAheadView({
  progress,
  channels,
  directory,
  selfMemberId,
}: {
  progress: AgentRunProgress;
  channels: readonly Channel[];
  directory: Directory;
  selfMemberId: string;
}) {
  const ahead = queueAhead(progress);
  if (ahead.visible.length === 0 && ahead.hiddenCount === 0) return null;
  return (
    <section className="border-b border-line py-2" data-testid="agent-work-panel-ahead">
      <h3 className="px-4 text-timestamp text-ink-muted">앞에 있는 일</h3>
      {ahead.visible.length > 0 && (
        <ul>
          {ahead.visible.map((entry) => (
            <AheadRow
              key={entry.runId}
              runId={entry.runId}
              channelId={entry.channelId}
              channels={channels}
              directory={directory}
              selfMemberId={selfMemberId}
            />
          ))}
        </ul>
      )}
      {ahead.hiddenCount > 0 && (
        <p
          className="break-keep px-4 pt-1 text-meta text-ink-muted"
          data-testid="agent-work-panel-ahead-hidden"
        >
          앞에 <span data-numeric>{ahead.hiddenCount}</span>건이 더 있어요. 내가 없는 채널의
          일이라 내용은 보이지 않아요.
        </p>
      )}
    </section>
  );
}

// ---- 승인 대기 → 카드 --------------------------------------------------------

export function ApprovalLink({ href }: { href: string }) {
  return (
    <p
      className="flex items-baseline gap-2 border-b border-line px-4 py-2 text-meta"
      data-testid="agent-work-panel-approval"
    >
      <span className="min-w-0 flex-1 break-keep text-ink-muted">
        이 일은 사람의 승인을 기다리고 있어요.
      </span>
      <Link
        to={href}
        className="shrink-0 rounded-sm text-ink underline underline-offset-2 press focus-visible:focus-ring"
        data-testid="agent-work-panel-approval-link"
      >
        승인 카드 보기
      </Link>
    </p>
  );
}

// ---- 기록 --------------------------------------------------------------------

const TONE_CLASS: Readonly<Record<RunLedgerRow["tone"], string>> = {
  neutral: "text-ink-muted",
  agent: "text-ink",
  action: "text-warn",
  end: "font-medium text-ink",
};

export function LedgerView({ rows }: { rows: readonly RunLedgerRow[] }) {
  return (
    <ol className="flex flex-col" data-testid="agent-work-panel-ledger">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex flex-col gap-1 border-b border-line px-4 py-2"
          data-testid="agent-work-panel-ledger-row"
          data-kind={row.kind}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className="shrink-0 text-timestamp text-ink-muted"
              data-numeric
              data-testid="agent-work-panel-ledger-time"
            >
              {clockLabel(row.atMs)}
            </span>
            {/* `stage` 문자열은 에이전트가 쓴 일반 텍스트다. 이스케이프된 텍스트
                노드로만 그리고, 긴 한 덩어리는 열 안에서 꺾는다. */}
            <span
              className={cn(
                "min-w-0 flex-1 whitespace-pre-wrap break-keep break-words text-meta",
                TONE_CLASS[row.tone]
              )}
            >
              {row.text}
            </span>
          </div>
          {row.reason !== undefined && (
            <p className="break-keep text-timestamp text-ink-muted" data-testid="agent-work-panel-ledger-reason">
              {row.reason}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
