import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { isOpenRunPhase, REQUEST_WORD, serverFactsOf } from "@momo/core/features/agents/runPhase";
import { requestBundleState, runBundleSnapshot } from "@momo/core/features/timeline/requestBundle";
import { IDLE_CUTOFF_MS } from "@momo/core/features/agents/workingSignal";
import { RUN_LEDGER_KEPT_SENTENCE } from "@momo/core/features/agents/runLedger";
import { runReportChipParts, runReportChipText, type RunReportSummary } from "@momo/core/features/agents/workReport";
import { useSession } from "@/app/session";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { RespondingAvatar, RespondingDots } from "./RespondingIndicator";
import { useRunLedger } from "./useRunLedger";
import { useVisibleThoughtRun } from "./visibleThoughtRuns";
import { openWorkPanel } from "./workLogStore";
import { isTerminalProgressFrame } from "@momo/core/features/agents/agentRail";
import {
  TEAM_AI_DELEGATION_WAIT_COPY,
  TEAM_AI_DELEGATION_WAIT_SHORT_COPY,
  teamAiDelegationWait,
} from "@momo/core/features/timeline/teamAiDelegationView";

/** 아직 원장을 못 읽었을 때의 요약 재료: 시간만 말하고 에이전트 보고 숫자는 지어내지 않아요. */
const NO_REPORT: RunReportSummary = { stages: 0, kinds: [] };

/**
 * 24px 자리는 요청 때부터 남고, 과정은 팝오버로 열어 읽던 행과 바닥을 밀지 않아요.
 *
 * 끝난 요청은 한 줄 요약 칩이에요: 「13분 · 단계 6 · 명령 12 · 에이전트 보고」(#4657). 걸린 시간은 서버 시계의
 * 사실이고 그 뒤 숫자는 에이전트가 스스로 알린 것이라 끝에 꼬리표가 붙어요. 칩을 누르면 팝오버가 아니라 그 run의
 * 작업 패널이 열려요(과정은 패널에 있어요). 일하는 중에는 그대로 팝오버예요(흐르는 글을 펼쳐 볼 수 있어요).
 */
export function RequestThoughtLine({ run, directory }: { run: AgentRunProgress; directory: Directory }) {
  const { workspaceId, realtime, connStatus } = useSession();
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [terminal, setTerminal] = useState<{ runId: string; phase?: AgentRunProgress["phase"] } | null>(null);
  const [, tick] = useState(0);
  const terminalHere = terminal?.runId === run.id.toLowerCase();
  const effectiveRun = terminalHere && terminal.phase ? { ...run, phase: terminal.phase } : run;
  const open = isOpenRunPhase(effectiveRun.phase);
  const state = requestBundleState({ ...runBundleSnapshot(run), run: effectiveRun });
  const working = !terminalHere && open && (state === "thinking" || state === "executing");
  const live = connStatus === "connected";
  const formatMessage = useFormatMessage();
  const ledger = useRunLedger(run.id, serverFactsOf(effectiveRun));
  useVisibleThoughtRun(run.id);
  useEffect(() => {
    if (!working || !live) return;
    const timer = setInterval(() => tick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [working, live]);
  useEffect(() => {
    // 접힘·종결·재접속·다른 run은 이전 델타를 물려받지 않아요. 디스크에는 쓰지 않아요.
    setText("");
    if (!expanded || !working || !live || !realtime) return;
    let watching = true;
    const stop = realtime.subscribeAgent(workspaceId, run.channelId, run.agentMemberId, {
      onEvent: (event) => {
        if (!watching) return;
        if (event.payload.run_id.toLowerCase() !== run.id.toLowerCase()) return;
        if (isTerminalProgressFrame(event)) {
          const phase = event.type === "agent.status" && ["succeeded", "failed", "cancelled", "timed_out"].includes(event.payload.run_status) ? event.payload.run_status : undefined;
          setTerminal({ runId: run.id.toLowerCase(), phase });
          setText("");
          return;
        }
        if (event.type !== "agent.partial") return;
        const delta = event.payload.text_delta;
        if (delta) setText((current) => (current + delta).slice(-8192));
      },
    });
    return () => { watching = false; stop(); };
  }, [expanded, working, live, realtime, workspaceId, run.id, run.channelId, run.agentMemberId]);
  const lastReport = run.lastEventAtMs;
  // Hermes를 기다리는 동안(서버가 정한 종류별 마감 안, #5375)은 「소식 없음」으로 바꾸지 않고 stage 옆에 마감을 알린다.
  // 서버는 그동안 원장에 행을 쓰지 않는다 — 마감을 넘기면 아래 원래 규칙으로 돌아간다.
  const delegationWait = working ? teamAiDelegationWait(run, Date.now()) : null;
  const waitUntil = delegationWait?.untilMs;
  useEffect(() => {
    // 분 단위 시계(위)는 마감을 최대 1분 늦게 본다: 마감 순간에 한 번 더 그린다.
    if (waitUntil === undefined) return;
    const timer = setTimeout(() => tick((value) => value + 1), Math.max(0, waitUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [waitUntil]);
  const quiet = working && live && delegationWait === null && lastReport !== undefined && Date.now() - lastReport >= IDLE_CUTOFF_MS;
  const waitHint = delegationWait === null ? null : formatMessage(TEAM_AI_DELEGATION_WAIT_COPY[delegationWait.kind], { minutes: delegationWait.minutes });
  const waitHintShort = delegationWait === null ? null : formatMessage(TEAM_AI_DELEGATION_WAIT_SHORT_COPY[delegationWait.kind], { minutes: delegationWait.minutes });
  const stage = Array.from(run.latestStage?.replace(/\s+/g, " ").trim() ?? "").slice(0, 40).join("");
  const name = memberFor(directory, run.agentMemberId)?.displayName ?? "에이전트";
  const duration = run.finishedAtMs === undefined ? undefined : Math.max(0, run.finishedAtMs - (run.startedAtMs ?? run.createdAtMs));
  // 요약의 숫자는 에이전트가 말한 것만이에요(단계·활동 합계). oort가 잰 호출 수는 출처가 달라 섞지 않아요(#4654).
  const summary = duration === undefined ? REQUEST_WORD[state] : runReportChipText(duration, ledger.report ?? NO_REPORT, formatMessage);
  const stageLabel = `${REQUEST_WORD[state]}${stage ? ` · ${stage}` : ""}`;
  // 마감 안내는 stage **뒤**에 같은 줄의 꼬리로 붙는다(줄 높이 24 그대로 — 대화가 밀리지 않는다). 몸(이름·stage)이 먼저 줄임표를
  // 받고 꼬리의 안내는 남는다. 줄 칸이 24rem보다 좁으면(스레드 패널 320·폭 390) 꼬리는 짧은 글이다 — 긴 글은 그 폭에서 이름까지
  // 밀어낸다(#5375 수리 1회차, 검수 M2). 낭독 이름은 늘 긴 글 전체다.
  const label = open ? `${stageLabel}${waitHint === null ? "" : ` · ${waitHint}`}` : summary;
  // 보이는 글은 몸과 꼬리표로 나눠 그린다: 좁은 칸에서 몸이 줄임표를 받아도 「에이전트 보고」(숫자가 누구의 말인지)는 남는다.
  const chip = duration === undefined ? null : runReportChipParts(duration, ledger.report ?? NO_REPORT, formatMessage);
  if (!open) {
    return (
      <div className="flex h-6 min-w-0 shrink-0 items-center" data-testid="request-thought-slot" data-run-id={run.id}>
        <span role="status" aria-live="polite" className="sr-only">{name} {REQUEST_WORD[state]}</span>
        <button
          type="button"
          aria-label={formatMessage("timeline.workSummary.openPanel", { name, summary: label })}
          onClick={(event) => openWorkPanel({ runId: run.id, memberId: run.agentMemberId, channelId: run.channelId, origin: "message" }, event.currentTarget)}
          // 좁은 칸에서는 이 칩이 열의 거의 전폭이다(390px에서 98%). 전폭은 폭이다(README §2.6): 눌림은 채움만이고
          // `.press`의 축소(scale 0.98)는 없다. 칩 폭은 글에 달려 있어 폭마다 클래스를 가르지 않고 어디서나 채움이다.
          className="flex h-full min-w-0 max-w-full items-center gap-2 rounded-sm text-left text-meta text-ink-muted press-instant-fill hover:bg-surface-hover focus-visible:focus-ring"
          data-testid="request-thought-line"
        >
          <RespondingAvatar directory={directory} memberId={run.agentMemberId} />
          {state === "done" && <Check className="size-4 shrink-0 text-ok" aria-hidden="true" />}
          {chip === null ? (
            <span className="min-w-0 truncate" data-numeric>{name} · {label}</span>
          ) : (
            <span className="flex min-w-0 items-baseline">
              <span className="min-w-0 truncate" data-numeric>{name} · {chip.body}</span>
              {chip.tail !== null && <span className="shrink-0 whitespace-pre" data-testid="request-thought-tail">{" · "}{chip.tail}</span>}
            </span>
          )}
          <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
        </button>
      </div>
    );
  }
  return (
    // `@container`: 마감 안내 꼬리가 이 줄 칸의 폭(대화 열 폭에서 옴)을 보고 긴 글·짧은 글을 고른다. 칸은 행 몸의 블록 자식이라 폭이 바뀌지 않는다.
    <div className="flex h-6 min-w-0 shrink-0 items-center @container" data-testid="request-thought-slot" data-run-id={run.id}>
      <span role="status" aria-live="polite" className="sr-only">{name} {REQUEST_WORD[state]}</span>
      <Popover open={expanded} onOpenChange={setExpanded}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${name} ${label}, 과정 ${expanded ? "접기" : "보기"}`} className="flex h-full min-w-0 max-w-full items-center gap-2 rounded-sm text-left text-meta text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring" data-testid="request-thought-line">
            <RespondingAvatar directory={directory} memberId={run.agentMemberId} />
            {!open && state === "done" && <Check className="size-4 shrink-0 text-ok" aria-hidden="true" />}
            {waitHint === null ? (
              <span className="min-w-0 truncate" data-numeric={!open || quiet ? "" : undefined}>{name} · {quiet ? `${Math.floor((Date.now() - lastReport!) / 60_000)}분째 소식 없음` : label}</span>
            ) : (
              <span className="flex min-w-0 items-baseline">
                <span className="min-w-0 truncate">{name} · {stageLabel}</span>
                {/* 꼬리는 줄지 않되 글 칸보다 넓어지지는 않는다: 스레드 패널을 가장 좁힌 192에서는 몸이 0이 된 뒤 꼬리도 줄임표를 받고,
                    점·화살표를 덮지 않는다. */}
                <span className="max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-pre" data-testid="request-thought-wait">
                  {" · "}
                  <span className="hidden @sm:inline">{waitHint}</span>
                  <span className="@sm:hidden">{waitHintShort}</span>
                </span>
              </span>
            )}
            {working && live && <RespondingDots />}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="popover-fit max-h-menu-available overflow-y-auto p-3" aria-label={`${name} 과정`} data-testid="request-thought-process">
          {!live && <p className="text-meta text-warn">연결이 끊겼어요. 다시 연결되면 진행을 확인해요.</p>}
          {ledger.isLoading && <p className="text-meta text-ink-muted">과정을 불러오는 중이에요</p>}
          {ledger.isError && <p className="text-meta text-warn">과정을 불러오지 못했어요. 다시 열어 주세요.</p>}
          {!ledger.isLoading && !ledger.isError && ledger.rows.length === 0 && <p className="text-meta text-ink-muted">아직 보고한 단계가 없어요</p>}
          <ol className="space-y-2 text-meta text-ink">
            {ledger.rows.map((row) => <li key={row.key}>{row.kind === "stage" ? Array.from(row.text).slice(0, 40).join("") : row.text}</li>)}
          </ol>
          {expanded && working && live && text && <div role="region" aria-label="실시간 생각 글" tabIndex={0} className="request-thought-stream mt-2 whitespace-pre-wrap break-words text-meta text-ink-muted focus-visible:focus-ring" data-testid="request-thought-stream">{text}</div>}
          <p className="mt-2 text-timestamp text-ink-muted">{RUN_LEDGER_KEPT_SENTENCE} 흐르는 글은 이 칸을 연 뒤에만 보이고 저장하지 않아요.</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
