import { useLayoutEffect, useRef, useState } from "react";
import type { AgentRunProgress } from "@momo/core/lib/api";
import { REQUEST_WORD } from "@momo/core/features/agents/runPhase";
import { requestBundleState, runBundleSnapshot } from "@momo/core/features/timeline/requestBundle";
import { ApprovalActions, APPROVAL_VERBS } from "./ApprovalActions";
import { rememberSettledApproval, useSettledApproval } from "./settledApprovals";
import { decisionNote } from "@/features/inbox/approvalsPanel";
import { useSession } from "@/app/session";
import { useExpiryNow } from "./useExpiryNow";

/** 요약 줄은 서버가 명시한 inline·권한·문장을 모두 아는 경우에만 결정해요. */
export function ThreadRequestSummary({ runs, onOpen }: {
  runs: readonly AgentRunProgress[];
  onOpen: () => void;
}) {
  const { session } = useSession();
  const observedAt = Date.now();
  const deadlines = runs.flatMap((run) => run.approvalExpiresAtMs !== undefined && run.approvalExpiresAtMs > observedAt && requestBundleState({ ...runBundleSnapshot(run), run, expiresAtMs: run.approvalExpiresAtMs, nowMs: observedAt }) === "approval" ? [run.approvalExpiresAtMs] : []);
  const nowMs = useExpiryNow(deadlines.length ? Math.min(...deadlines) : undefined, true);
  const pending = runs.flatMap((run) => {
    const bundle = runBundleSnapshot(run);
    return bundle && requestBundleState({ ...bundle, run, nowMs, expiresAtMs: run.approvalExpiresAtMs }) === "approval" ? [bundle] : [];
  });
  const proposal = pending.length === 1 ? pending[0] : undefined;
  const receipt = useSettledApproval(proposal?.approvalId ?? null);
  const questionRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  const question = proposal?.intent;
  useLayoutEffect(() => {
    const node = questionRef.current;
    if (!node) { setFits(false); return; }
    const measure = () => setFits(node.clientWidth > 0 && node.scrollWidth <= node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [question]);
  // 줄 자리는 run이 생긴 뒤 끝까지 남아요. 버튼이 서고 져도 다음 행을 밀지 않아요.
  const active = pending.length > 0 && receipt === null;
  const questionSentence = question !== undefined && /[?？](?:\s*·|\s*$)/.test(question);
  const human = session.member.kind === "human" && !runs.some((run) => run.agentMemberId.toLowerCase() === session.member.id.toLowerCase());
  const inline = active && human && proposal?.decisionMode === "inline" && proposal.canDecide === true && proposal.approvalId !== undefined && questionSentence;
  return (
    <div className="flex h-control-sm min-w-0 items-center gap-2 text-meta text-ink-muted" data-testid="thread-request-summary">
      {active && <>
        <button type="button" onClick={onOpen} className="shrink-0 rounded-sm press hover:text-ink focus-visible:focus-ring" data-testid="thread-request-open">
          {REQUEST_WORD.approval}{pending.length > 1 ? ` ${pending.length}` : ""}
        </button>
        <span ref={questionRef} className="min-w-0 flex-1 truncate" data-testid="thread-request-question">{question}</span>
        {inline ? <span className="relative shrink-0">
          {/* 같은 폭을 먼저 예약해 문장을 잰 뒤에만 실제 컨트롤을 마운트해요. */}
          <span aria-hidden="true" className="invisible flex items-center gap-2"><span className="h-control-sm px-3">{APPROVAL_VERBS.approve}</span><span className="h-control-sm px-3">{APPROVAL_VERBS.reject}</span></span>
          {fits && <span className="absolute inset-0" data-testid="thread-request-actions"><ApprovalActions approvalId={proposal.approvalId!} lead="" decisionLabel={question} className="p-0" testIdPrefix="thread-approval" onSettled={(outcome) => {
            rememberSettledApproval(proposal.approvalId!, { status: outcome.status ?? "pending", note: decisionNote(outcome).text });
          }} /></span>}
          {!fits && <button type="button" onClick={onOpen} className="absolute inset-0 rounded-full bg-surface-muted px-3 text-ink press hover:bg-surface-hover focus-visible:focus-ring">열어서 결정</button>}
        </span> : <button type="button" onClick={onOpen} className="shrink-0 rounded-full bg-surface-muted px-3 py-1 text-ink press hover:bg-surface-hover focus-visible:focus-ring">열어서 결정</button>}
      </>}
    </div>
  );
}
