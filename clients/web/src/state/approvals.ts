import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalProjection } from "../api/client";
import { decideApproval, listApprovals } from "../api/client";

// =============================================================================
// Approvals store (MOMO-400, ADR-0112 basic mode).
//
// One shared status map feeds BOTH surfaces (approvals panel + timeline
// approval_request cards) so a decision made on either updates the other.
//
// Receipt semantics (openapi.yaml, canonical): 200 AND the expected failures
// 403/404/409 all return the ApprovalDecisionReceipt schema. A 409 means the
// approval was already settled (decided on another device/tab, or expired)
// — that is a NORMAL state transition for the card, never an error toast.
// =============================================================================

/** Card-facing outcome of a decision attempt. */
export interface DecisionOutcome {
  kind: "committed" | "superseded" | "error";
  /** Approval status to render when known (approved/rejected/expired/…). */
  status?: string;
  /** User copy for kind === "error" (retryable). */
  errorCopy?: string;
  /** Extra note for kind === "superseded" (decided elsewhere / expired). */
  note?: string;
}

const SETTLED_STATUSES = new Set([
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export interface ApprovalsStore {
  /** Pending projections, expiry-soonest first (server order). */
  pending: ApprovalProjection[];
  pendingLoaded: boolean;
  /** Locally known status for an approval id; null = not known here. */
  statusFor: (approvalId: string) => string | null;
  refreshPending: () => Promise<void>;
  /**
   * Decide an approval. `clientDecisionId` is the caller-held idempotency
   * key: reuse it to retry the SAME decision after a network failure.
   */
  decide: (
    approvalId: string,
    approve: boolean,
    clientDecisionId: string
  ) => Promise<DecisionOutcome>;
}

export function useApprovals(workspaceId: string): ApprovalsStore {
  const [pending, setPending] = useState<ApprovalProjection[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [statusById, setStatusById] = useState<Map<string, string>>(
    () => new Map()
  );
  const statusByIdRef = useRef(statusById);
  statusByIdRef.current = statusById;

  const noteStatus = useCallback((approvalId: string, status: string) => {
    const key = approvalId.toLowerCase();
    setStatusById((current) => {
      // A locally settled status is final for this session; never let a
      // stale "pending" from a projection refresh overwrite it.
      const existing = current.get(key);
      if (existing && SETTLED_STATUSES.has(existing) && status === "pending") {
        return current;
      }
      if (existing === status) return current;
      const next = new Map(current);
      next.set(key, status);
      return next;
    });
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      const page = await listApprovals(workspaceId, "pending");
      setPending(page.approvals);
      setPendingLoaded(true);
      for (const approval of page.approvals) {
        noteStatus(approval.id, approval.status);
      }
    } catch {
      // Transient; the panel keeps its previous contents.
    }
  }, [noteStatus, workspaceId]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  const decide = useCallback(
    async (
      approvalId: string,
      approve: boolean,
      clientDecisionId: string
    ): Promise<DecisionOutcome> => {
      let result;
      try {
        result = await decideApproval(
          workspaceId,
          approvalId,
          approve,
          clientDecisionId
        );
      } catch {
        return {
          kind: "error",
          errorCopy: "결정을 전송하지 못했습니다. 다시 시도해 주세요.",
        };
      }
      const { httpStatus, receipt } = result;

      if (httpStatus === 200) {
        noteStatus(approvalId, receipt.status);
        void refreshPending();
        return { kind: "committed", status: receipt.status };
      }
      if (httpStatus === 409) {
        if (SETTLED_STATUSES.has(receipt.status)) {
          // Settled before this decision (another device/tab, or expiry):
          // normal flow — the card transitions to the authoritative status.
          noteStatus(approvalId, receipt.status);
          void refreshPending();
          return {
            kind: "superseded",
            status: receipt.status,
            note:
              receipt.status === "expired"
                ? "결정 전에 만료되었습니다."
                : "다른 곳에서 이미 결정되었습니다.",
          };
        }
        // idempotency_conflict: same key, different decision — retryable
        // only with a fresh key, so surface as an error.
        return {
          kind: "error",
          errorCopy: "결정이 충돌했습니다. 다시 시도해 주세요.",
        };
      }
      if (httpStatus === 404) {
        return {
          kind: "error",
          errorCopy: "승인 요청을 찾을 수 없습니다.",
        };
      }
      // 403
      return {
        kind: "error",
        errorCopy: "이 승인을 결정할 권한이 없습니다.",
      };
    },
    [noteStatus, refreshPending, workspaceId]
  );

  const statusFor = useCallback(
    (approvalId: string) => statusById.get(approvalId.toLowerCase()) ?? null,
    [statusById]
  );

  return { pending, pendingLoaded, statusFor, refreshPending, decide };
}
