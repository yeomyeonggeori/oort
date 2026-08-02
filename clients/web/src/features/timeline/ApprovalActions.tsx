import { useEffect, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import {
  decideApproval,
  newDecisionId,
  type DecisionOutcome,
} from "@momo/core/features/timeline/approvalDecision";

// =============================================================================
// 승인 결정 컨트롤 (R-1 §4, goal B5.3b D-5).
//
// Lifted out of AgentCard because a SECOND surface now decides approvals: the
// inbox 결정 대기 목록 (`GET …/approvals?status=pending`). Two implementations of
// "approve or reject" would mean two idempotency policies, two confirm rules and
// two ways to word a 409, and the one that is not being looked at is the one
// that drifts. So the card and the list share this, and the only thing that
// varies is the sentence in front of the buttons.
//
// The rules it carries, unchanged from the card:
//   - one idempotency key per (row, direction), reused across retries, dropped
//     only on an idempotency conflict so the retry mints a fresh one;
//   - no decision fires on a single unguarded click: 승인/거부 arms, the second
//     press commits (design-taste-web §6, confirm in place rather than in a
//     modal so the question stays next to the evidence);
//   - a rejection is stated inline, never as a toast.
// =============================================================================

export type Armed = "approve" | "reject" | null;

export function ApprovalActions({
  approvalId,
  armed,
  setArmed,
  onSettled,
  lead = "이 작업은 승인이 필요합니다.",
  className,
  testIdPrefix = "approval",
  reversible = true,
}: {
  approvalId: string;
  armed: Armed;
  setArmed: (armed: Armed) => void;
  onSettled: (outcome: DecisionOutcome) => void;
  /** The sentence in front of the buttons before either one is armed. */
  lead?: string;
  className?: string;
  /**
   * Test ids are prefixed so a row in a list and a card in the timeline can be
   * on screen at once without two elements answering to one hook.
   */
  testIdPrefix?: string;
  /** M2(design-review): 비가역 승인이면 확정 문장이 그 사실을 재진술한다. */
  reversible?: boolean;
}) {
  // workspaceId comes from session context rather than a prop chain: both
  // callers sit several components below the shell.
  const { workspaceId } = useSession();
  const [busy, setBusy] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  const keysRef = useRef<{ approve?: string; reject?: string }>({});

  async function commit(approve: boolean) {
    if (busy) return;
    const slot = approve ? "approve" : "reject";
    keysRef.current[slot] ??= newDecisionId();
    setBusy(true);
    setErrorCopy(null);
    try {
      const outcome = await decideApproval(
        workspaceId,
        approvalId,
        approve,
        keysRef.current[slot]
      );
      if (outcome.kind === "error") {
        if (outcome.errorCode === "idempotency_conflict") {
          delete keysRef.current[slot];
        }
        setErrorCopy(outcome.errorCopy ?? "결정을 처리하지 못했습니다.");
        return;
      }
      setArmed(null);
      onSettled(outcome);
    } finally {
      setBusy(false);
    }
  }

  // H2(design-review): 무장 시 승인/거부 버튼이 언마운트되며 초점이 body로
  // 떨어진다 — 키보드 사용자가 처음부터 Tab하지 않도록 확정 버튼으로 옮긴다.
  const commitRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (armed !== null) commitRef.current?.focus();
  }, [armed]);

  return (
    <div className={cn("px-3 py-2", className)}>
      {armed === null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-meta text-ink-muted">{lead}</span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid={`${testIdPrefix}-reject`}
              onClick={() => setArmed("reject")}
            >
              거부
            </Button>
            <Button
              size="sm"
              data-testid={`${testIdPrefix}-approve`}
              onClick={() => setArmed("approve")}
            >
              승인
            </Button>
          </span>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          data-testid={`${testIdPrefix}-confirm`}
        >
          <span className="text-meta text-ink">
            {armed === "approve"
              ? reversible
                ? "승인하면 에이전트가 바로 실행합니다."
                : "승인하면 에이전트가 바로 실행합니다. 되돌릴 수 없습니다."
              : "거부하면 이 실행은 취소됩니다."}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              data-testid={`${testIdPrefix}-cancel`}
              onClick={() => setArmed(null)}
            >
              취소
            </Button>
            <Button
              variant={armed === "approve" ? "default" : "destructive"}
              size="sm"
              disabled={busy}
              ref={commitRef}
              data-testid={`${testIdPrefix}-commit`}
              onClick={() => void commit(armed === "approve")}
            >
              {busy
                ? "보내는 중"
                : armed === "approve"
                  ? "승인 확정"
                  : "거부 확정"}
            </Button>
          </span>
        </div>
      )}
      {errorCopy !== null && (
        <p
          role="alert"
          data-testid={`${testIdPrefix}-error`}
          className="pt-2 text-meta text-danger"
        >
          {errorCopy}
        </p>
      )}
    </div>
  );
}
