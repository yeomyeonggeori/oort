import { record, expressionResultPayload } from "./cards";
import { useEffect, useRef, useState } from "react";
import { authedResponse } from "@momo/core/lib/api";
import { expressionApprovalSummary } from "@momo/core/features/expressions/cards";
import { expressionResultMessage } from "@momo/core/features/expressions/message";
import type { ExpressionApproval, ExpressionChoice, ExpressionDraft, ExpressionResult } from "@momo/core/features/expressions/types";
import { interpretReceipt, newDecisionId, type ApprovalDecisionReceipt } from "@momo/core/features/timeline/approvalDecision";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { useSettledApproval, rememberSettledApproval } from "@/features/timeline/settledApprovals";
import { seedComposerText } from "@/features/chat/draftStore";
import { Button } from "@/design/ui/button";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { ExpressionSourceRow } from "./ExpressionSourceRow";
import { useExpressions } from "./context";

export function ExpressionResultSend({ result, channelId }: { result: ExpressionResult; channelId?: string }) {
  const { store, offline } = useExpressions();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!store || !channelId) return null;
  return <div className="flex flex-wrap items-center gap-2 px-3 py-2"><Button type="button" size="sm" variant="secondary" disabled={busy || offline} onClick={async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      await store.refresh();
      const message = expressionResultMessage(result, store.getSnapshot().cache.items);
      if (store.getSnapshot().status !== "ready" || !message) setNote("이 그림은 사용할 수 없어요. 팀 보관함을 확인해 주세요.");
      else if (!seedComposerText(store.workspaceId, channelId, message.body)) setNote("입력 중인 글이 있어요. 비우고 다시 눌러 주세요.");
    } finally { setBusy(false); }
  }}>보내기</Button>{note && <p role="status" className="text-meta text-ink-muted">{note}</p>}</div>;
}

export function ExpressionApprovalCard({ card, payload, result }: { card: AgentApprovalCard; payload: ExpressionApproval | null; result: ExpressionResult | null }) {
  const { store, offline } = useExpressions();
  const remembered = useSettledApproval(card.approvalId);
  const [drafts, setDrafts] = useState(payload?.candidates ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<ExpressionResult | null>(null);
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());
  useEffect(() => { setDrafts(payload?.candidates ?? []); }, [payload]);
  useEffect(() => {
    if (!card.expiresAtMs) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, card.expiresAtMs - Date.now())));
    return () => window.clearTimeout(timer);
  }, [card.expiresAtMs]);
  const status = remembered?.status ?? card.status;
  const validScope = drafts.every((draft) => draft.workspaceId === store?.workspaceId);
  // The head says what the candidates below say, so it is not made when they are not shown.
  const head = validScope ? expressionApprovalSummary(drafts) : null;
  const pending = status === "pending" && (!card.expiresAtMs || now < card.expiresAtMs);
  async function decide(choice?: ExpressionChoice) {
    if (!store || !card.approvalId || !pending || lock.current || offline || (choice && !validScope)) return;
    const selected = drafts.find((draft) => draft.draftId === choice?.draftId);
    if (choice && selected?.subjectMemberId && selected.subjectMemberId !== store.memberId) throw new Error("subject");
    lock.current = true; setBusy(true); setError(null);
    const pin = choice ? JSON.stringify(choice) : "reject";
    const key = keys.current.get(pin) ?? newDecisionId(); keys.current.set(pin, key);
    try {
      const response = await authedResponse(`${store.base}/approvals/${card.approvalId}/decision`, { method: "POST", body: JSON.stringify({ approval_id: card.approvalId, approve: !!choice, client_decision_id: key, ...(choice ? { expressionChoice: choice } : {}) }) });
      const receipt = response.json<ApprovalDecisionReceipt>();
      const outcome = interpretReceipt(response.status, receipt);
      if (outcome.kind === "error") { if (outcome.errorCode === "idempotency_conflict") keys.current.delete(pin); throw new Error("decision"); }
      if (!outcome.status || outcome.status === "pending") throw new Error("pending");
      rememberSettledApproval(card.approvalId, { status: outcome.status, note: outcome.status === "approved" ? "팀 보관함에 저장했어요" : "처리가 끝난 요청이에요" });
      setLocalResult(expressionResultPayload({ result: record(receipt).result }));
      await store.refresh();
    } catch { setError("결정하지 못했어요. 권한과 새 미리보기를 확인하고 다시 시도해 주세요."); throw new Error("expression decision"); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!store) return <p className="text-body">팀 보관함을 불러올 수 없어요.</p>;
  return <section className="rounded-lg border border-line bg-surface p-3" aria-label="팀 그림 등록 요청" data-testid="expression-approval">
    <p className="text-body font-semibold">{card.title}</p>
    {(!payload || !validScope) && pending && <p role="alert" className="text-body">그림 후보를 읽지 못했어요. 에이전트에게 다시 제안해 달라고 해 주세요.</p>}
    {pending ? <>
      <p className="text-meta text-ink-muted">후보 중 한 장만 골라 팀 보관함에 등록해요.</p>
      {head && (head.countLabel !== null || head.sources.length > 0) && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-ink-muted" data-testid="expression-approval-head">
        {head.countLabel !== null && <span data-numeric data-testid="expression-approval-count">{head.countLabel}</span>}
        {head.sources.map((line) => <ExpressionSourceRow key={line.attachmentId ?? "none"} line={line} workspaceId={store.workspaceId} channelId={card.channelId} offline={offline} />)}
      </div>}
      {validScope && drafts.map((draft: ExpressionDraft) => <ExpressionDraftCard key={draft.draftId} draft={draft} busy={busy || (!!draft.subjectMemberId && draft.subjectMemberId !== store.memberId)} onReplace={(next) => setDrafts((items) => items.map((item) => item.draftId === next.draftId ? next : item))} onApprove={decide} />)}
      {drafts.some((draft) => draft.subjectMemberId && draft.subjectMemberId !== store.memberId) && <p className="text-meta text-ink-muted">얼굴 당사자만 승인할 수 있어요.</p>}
      <Button type="button" variant="secondary" disabled={busy || offline} onClick={() => { void decide().catch(() => {}); }}>거부하기</Button>
    </> : <><p role="status" className="text-body">{remembered?.note ?? card.summary ?? (status === "approved" ? "팀 보관함에 저장했어요" : status === "pending" ? "승인을 기다리다 만료됐어요" : "처리가 끝난 요청이에요")}</p>{(localResult ?? result) && <ExpressionResultSend result={(localResult ?? result)!} channelId={card.channelId} />}</>}
    {error && <p role="alert" className="text-body text-danger">{error}</p>}
  </section>;
}
