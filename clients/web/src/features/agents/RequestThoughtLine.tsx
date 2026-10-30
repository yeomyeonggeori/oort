import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { isOpenRunPhase, REQUEST_WORD, serverFactsOf } from "@momo/core/features/agents/runPhase";
import { requestBundleState, runBundleSnapshot } from "@momo/core/features/timeline/requestBundle";
import { IDLE_CUTOFF_MS } from "@momo/core/features/agents/workingSignal";
import { RUN_LEDGER_KEPT_SENTENCE } from "@momo/core/features/agents/runLedger";
import { useSession } from "@/app/session";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { RespondingAvatar, RespondingDots } from "./RespondingIndicator";
import { useRunLedger } from "./useRunLedger";
import { useVisibleThoughtRun } from "./visibleThoughtRuns";
import { isTerminalProgressFrame } from "@momo/core/features/agents/agentRail";

/** 24px 자리는 요청 때부터 남고, 과정은 팝오버로 열어 읽던 행과 바닥을 밀지 않아요. */
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
  const ledger = useRunLedger(run.id, serverFactsOf(effectiveRun), true);
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
  const quiet = working && live && lastReport !== undefined && Date.now() - lastReport >= IDLE_CUTOFF_MS;
  const stage = Array.from(run.latestStage?.replace(/\s+/g, " ").trim() ?? "").slice(0, 40).join("");
  const name = memberFor(directory, run.agentMemberId)?.displayName ?? "에이전트";
  const duration = run.finishedAtMs === undefined ? undefined : Math.max(0, run.finishedAtMs - (run.startedAtMs ?? run.createdAtMs));
  const counts = ledger.counts;
  const summary = duration === undefined ? REQUEST_WORD[state] : `${duration < 60_000 ? "1분 미만" : `${Math.floor(duration / 60_000)}분`} 작업${counts?.tools === undefined ? "" : ` · 도구 ${counts.tools}`}${counts ? ` · 승인 ${counts.approvals}` : ""}`;
  const label = open ? `${REQUEST_WORD[state]}${stage ? ` · ${stage}` : ""}` : summary;
  return (
    <div className="flex h-6 min-w-0 shrink-0 items-center" data-testid="request-thought-slot" data-run-id={run.id}>
      <span role="status" aria-live="polite" className="sr-only">{name} {REQUEST_WORD[state]}</span>
      <Popover open={expanded} onOpenChange={setExpanded}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${name} ${label}, 과정 ${expanded ? "접기" : "보기"}`} className="flex h-full min-w-0 max-w-full items-center gap-2 rounded-sm text-left text-meta text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring" data-testid="request-thought-line">
            <RespondingAvatar directory={directory} memberId={run.agentMemberId} />
            {!open && state === "done" && <Check className="size-4 shrink-0 text-ok" aria-hidden="true" />}
            <span className="min-w-0 truncate" data-numeric={!open || quiet ? "" : undefined}>{name} · {quiet ? `${Math.floor((Date.now() - lastReport!) / 60_000)}분째 소식 없음` : label}</span>
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
