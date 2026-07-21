import { useRef, useState } from "react";
import type { DecisionOutcome } from "../state/approvals";

interface ApprovalCardProps {
  approvalId: string;
  /** One line saying WHAT the agent wants to do (ADR-0112 basic mode). */
  title: string;
  /** Optional supporting sentence — plain language only. */
  summary?: string | undefined;
  requesterName: string;
  /** Authoritative status as far as this client knows; null = pending. */
  status: string | null;
  isResumeOffer?: boolean;
  decide: (
    approvalId: string,
    approve: boolean,
    clientDecisionId: string
  ) => Promise<DecisionOutcome>;
}

const STATUS_LABEL: Record<string, string> = {
  approved: "승인됨",
  rejected: "거부됨",
  expired: "만료됨",
  cancelled: "취소됨",
};

/**
 * Approval card (ADR-0112 basic mode grammar): what the agent wants to do +
 * approve/reject. Tool JSON, arguments, and cost estimates are intentionally
 * NEVER rendered here.
 *
 * State transitions are receipt-driven: a 409 (settled elsewhere first) is
 * normal flow — the card flips to the authoritative status with a quiet
 * note, not an error.
 */
export default function ApprovalCard({
  approvalId,
  title,
  summary,
  requesterName,
  status,
  isResumeOffer = false,
  decide,
}: ApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  // One idempotency key per (card, direction): a retry of the same decision
  // reuses it; switching direction gets its own key.
  const decisionIdsRef = useRef<{ approve?: string; reject?: string }>({});

  const settled = status !== null && status !== "pending";

  async function handleDecision(approve: boolean) {
    if (busy || settled) return;
    const slot = approve ? "approve" : "reject";
    decisionIdsRef.current[slot] ??= crypto.randomUUID();
    setBusy(true);
    setErrorCopy(null);
    try {
      const outcome = await decide(
        approvalId,
        approve,
        decisionIdsRef.current[slot]
      );
      if (outcome.kind === "error") {
        if (outcome.errorCode === "idempotency_conflict") {
          // The server holds this key with a different decision; replaying it
          // can only 409 again. Drop it so the retry mints a fresh key.
          delete decisionIdsRef.current[slot];
        }
        setErrorCopy(outcome.errorCopy ?? "결정을 처리하지 못했습니다.");
        return;
      }
      // committed | superseded: the store's status map re-renders us via the
      // `status` prop; only the quiet supersede note is local.
      setNote(outcome.kind === "superseded" ? (outcome.note ?? null) : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="approval-card"
      data-testid="approval-card"
      data-approval-id={approvalId.toLowerCase()}
      data-approval-status={status ?? "pending"}
    >
      <p className="approval-title">{title}</p>
      {summary !== undefined && summary !== "" && (
        <p className="approval-summary">{summary}</p>
      )}
      <p className="approval-requester muted">{requesterName}의 승인 요청</p>

      {isResumeOffer ? (
        <p className="approval-resume-note" data-testid="resume-offer-note">
          데스크톱에서 재개하세요.
        </p>
      ) : status !== null && status !== "pending" ? (
        <p className="approval-state" data-testid="approval-state">
          {STATUS_LABEL[status] ?? status}
          {note !== null && (
            <span className="approval-note" data-testid="approval-note">
              {" "}
              · {note}
            </span>
          )}
        </p>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="primary-button approval-approve"
            data-testid="approval-approve"
            disabled={busy}
            onClick={() => void handleDecision(true)}
          >
            승인
          </button>
          <button
            type="button"
            className="ghost-button approval-reject"
            data-testid="approval-reject"
            disabled={busy}
            onClick={() => void handleDecision(false)}
          >
            거부
          </button>
        </div>
      )}

      {errorCopy !== null && (
        <p className="approval-error" data-testid="approval-error" role="alert">
          {errorCopy}
        </p>
      )}
    </div>
  );
}
