import type { ApprovalProjection } from "../api/client";
import type { ApprovalsStore } from "../state/approvals";
import {
  approvalActionType,
  approvalRequestedBy,
} from "../state/approvalModel";
import ApprovalCard from "./ApprovalCard";

interface ApprovalsPanelProps {
  approvals: ApprovalsStore;
  displayNameFor: (memberId: string) => string;
  onClose: () => void;
}

/**
 * Plain-language card copy (ADR-0112 basic mode). Only the two prose fields
 * are ever plucked from the payload; the rest (tool JSON, arguments, cost)
 * stays unrendered by design.
 */
function approvalText(approval: ApprovalProjection): {
  title: string;
  summary?: string;
} {
  let title: string | undefined;
  let summary: string | undefined;
  if (approval.payload !== null && typeof approval.payload === "object") {
    const payload = approval.payload as Record<string, unknown>;
    if (typeof payload.title === "string" && payload.title !== "") {
      title = payload.title;
    }
    if (typeof payload.summary === "string" && payload.summary !== "") {
      summary = payload.summary;
    }
  }
  // No payload title: name the action instead. When the row carries no action
  // type in either notation there is nothing true to name, and a stringified
  // `undefined` in the heading would be worse than the shorter sentence.
  const actionType = approvalActionType(approval);
  const result: { title: string; summary?: string } = {
    title:
      title ??
      (actionType !== undefined
        ? `${actionType} 실행 승인 요청`
        : "실행 승인 요청"),
  };
  if (summary !== undefined) result.summary = summary;
  return result;
}

export default function ApprovalsPanel({
  approvals,
  displayNameFor,
  onClose,
}: ApprovalsPanelProps) {
  return (
    <div className="approvals-panel" data-testid="approvals-panel">
      <header className="timeline-header approvals-panel-header">
        <h1 className="timeline-title">승인 요청</h1>
        <button
          type="button"
          className="ghost-button"
          data-testid="approvals-close"
          onClick={onClose}
        >
          닫기
        </button>
      </header>

      <div className="approvals-panel-scroll">
        {approvals.pendingLoaded && approvals.pending.length === 0 && (
          <p className="muted approvals-empty" data-testid="approvals-empty">
            대기 중인 승인 요청이 없습니다.
          </p>
        )}
        <ul className="approvals-list">
          {approvals.pending.map((approval) => {
            const text = approvalText(approval);
            // `displayNameFor` indexes by id, so an absent requester cannot go
            // through it — it would throw on `undefined.toLowerCase()` and take
            // the whole panel down with it (#1176). Say so instead.
            const requestedBy = approvalRequestedBy(approval);
            return (
              <li key={approval.id.toLowerCase()}>
                <ApprovalCard
                  approvalId={approval.id}
                  title={text.title}
                  summary={text.summary}
                  requesterName={
                    requestedBy !== undefined
                      ? displayNameFor(requestedBy)
                      : "알 수 없는 멤버"
                  }
                  status={approvals.statusFor(approval.id)}
                  decide={approvals.decide}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
