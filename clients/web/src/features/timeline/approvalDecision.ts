import { NetworkError, fetchWithDeadline, type HttpResponse } from "@/lib/http";
import { apiBase } from "@/lib/serverBase";
import { getAccessToken } from "@/lib/session";
import {
  ABSENT_STATUSES,
  serverSurface,
} from "@/features/capabilities/serverSurfaces";
import { parseApprovalStatus, type ApprovalStatus } from "./agentCardModel";

// =============================================================================
// Approval decision transport (R-1 §4). Existing landed REST, nothing new:
//   POST /v1/workspaces/{ws}/approvals/{approval}/decision
// (server/Sources/MomoServer/Routes/ApprovalDecisionRoutes.swift).
//
// This does NOT go through lib/api.ts `request<T>()` on purpose. That helper
// throws on any non-2xx and discards the body, but here 403 / 404 / 409 return
// the SAME ApprovalDecisionReceipt schema as 200 and ARE the contract: a 409
// carrying a settled status means the approval was decided on another device or
// expired, which is a normal state transition for the card, not an error. A
// wrapper that throws it away would force the UI to lie about what happened.
//
// Idempotency: `client_decision_id` is caller-held. Retrying the SAME decision
// reuses the key; the server replays the original receipt. A 409 whose receipt
// status is `idempotency_conflict` means the server holds that key bound to a
// DIFFERENT decision, so replaying it can only conflict again and the retry has
// to mint a fresh key.
// =============================================================================

export interface ApprovalDecisionReceipt {
  approval_id: string;
  status: string;
  decided_by?: string | null;
  decided_at_ms?: number | null;
  decision_reason?: string | null;
}

export interface DecisionOutcome {
  kind: "committed" | "superseded" | "error";
  /** Authoritative status when the receipt supplied a known one. */
  status?: ApprovalStatus;
  /** Epoch ms the server recorded the decision at. */
  decidedAtMs?: number;
  /** Member the server credited the decision to (the audit trail line). */
  decidedByMemberId?: string;
  /** Quiet note for `superseded` (decided elsewhere, or expired first). */
  note?: string;
  /** User copy for `error`. States what happened and what to do next. */
  errorCopy?: string;
  /** Set when the cached idempotency key must be dropped before a retry. */
  errorCode?: "idempotency_conflict";
}

const SETTLED = new Set<ApprovalStatus>([
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

/** Fresh idempotency key. One per (card, direction), reused across retries. */
export function newDecisionId(): string {
  return crypto.randomUUID();
}

/**
 * Copy for a decision that never reached an answer. Says which of the two
 * happened, because "the server took too long" and "nothing was there" lead to
 * different next moves, and neither is "the decision was recorded".
 */
export function sendFailureCopy(cause: unknown): string {
  if (cause instanceof NetworkError && cause.failure === "timeout") {
    return "서버가 제때 응답하지 않아 결정을 보내지 못했습니다. 다시 시도하세요.";
  }
  return "결정이 서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.";
}

export async function decideApproval(
  workspaceId: string,
  approvalId: string,
  approve: boolean,
  clientDecisionId: string
): Promise<DecisionOutcome> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  // Deadline, not an open-ended wait (MOMO-609): an approval card stuck on its
  // busy state is the one place where "still working" and "never sent" look
  // identical, and the person is deciding whether to press it again.
  let response: HttpResponse;
  try {
    response = await fetchWithDeadline(
      `${apiBase()}/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          approval_id: approvalId,
          approve,
          client_decision_id: clientDecisionId,
        }),
      }
    );
  } catch (error) {
    // The idempotency key is caller-held and unchanged, so pressing the same
    // button again replays this decision rather than minting a second one.
    return { kind: "error", errorCopy: sendFailureCopy(error) };
  }

  const receiptStatuses = new Set([200, 403, 404, 409]);
  if (!receiptStatuses.has(response.status)) {
    return {
      kind: "error",
      errorCopy: `결정을 처리하지 못했습니다. 서버가 ${response.status}로 응답했습니다.`,
    };
  }

  let receipt: ApprovalDecisionReceipt;
  try {
    receipt = response.json<ApprovalDecisionReceipt>();
  } catch {
    return unreadableAnswerOutcome(response.status, response.text);
  }
  return interpretReceipt(response.status, receipt);
}

/**
 * 영수증이 아닌 답을 받았을 때 할 말. 갈래가 둘이고, 뭉치면 화면이 거짓말을 한다
 * (goal B12).
 *
 * 승인 원장을 **가진** 서버의 404는 "그런 승인은 없다"는 뜻이고 영수증 스키마를
 * 싣고 온다. 그래서 404가 `receiptStatuses`에 들어 있다. 그런데 이 라우트를 아예
 * 싣지 않은 서버도 404를 답하고, 그 404는 라우터의 기본 응답이라 **본문이 없다**.
 * 두 404가 같은 칸에 있었던 탓에 이 함수는 빈 본문에서 JSON 파싱에 걸려
 * "서버 응답을 읽지 못했습니다. 다시 시도하세요"를 돌려주고 있었다. 결코 성공할
 * 수 없는 재시도를 시키는 문장이고, 사용자 자리에서는 앱이 고장난 것으로 읽힌다.
 *
 * 그래서 본문 없는 미제공 상태 코드는 재시도를 권하지 않고 못 한다고 말한다.
 * 판정은 `serverSaysAbsent`와 같은 집합을 쓴다: 규칙이 두 벌로 갈라지면 한쪽만
 * 고쳐지는 날이 온다.
 */
export function unreadableAnswerOutcome(
  status: number,
  body: string
): DecisionOutcome {
  if (ABSENT_STATUSES.includes(status) && body.trim() === "") {
    return { kind: "error", errorCopy: serverSurface("approvals").absentReason };
  }
  return {
    kind: "error",
    errorCopy: "서버 응답을 읽지 못했습니다. 다시 시도하세요.",
  };
}

/**
 * Receipt to card outcome. Split out from the fetch so the mapping is a pure
 * function the tests can drive without a network.
 */
export function interpretReceipt(
  httpStatus: number,
  receipt: ApprovalDecisionReceipt
): DecisionOutcome {
  const status = parseApprovalStatus(receipt.status);
  const decidedAtMs =
    typeof receipt.decided_at_ms === "number" ? receipt.decided_at_ms : undefined;
  const decidedBy =
    typeof receipt.decided_by === "string" && receipt.decided_by !== ""
      ? receipt.decided_by
      : undefined;

  if (httpStatus === 200) {
    const outcome: DecisionOutcome = { kind: "committed" };
    if (status !== null) outcome.status = status;
    if (decidedAtMs !== undefined) outcome.decidedAtMs = decidedAtMs;
    if (decidedBy !== undefined) outcome.decidedByMemberId = decidedBy;
    return outcome;
  }
  if (httpStatus === 409) {
    if (status !== null && SETTLED.has(status)) {
      const outcome: DecisionOutcome = {
        kind: "superseded",
        status,
        note:
          status === "expired"
            ? "결정 전에 만료되었습니다."
            : "다른 곳에서 이미 결정되었습니다.",
      };
      if (decidedAtMs !== undefined) outcome.decidedAtMs = decidedAtMs;
      if (decidedBy !== undefined) outcome.decidedByMemberId = decidedBy;
      return outcome;
    }
    return {
      kind: "error",
      errorCode: "idempotency_conflict",
      errorCopy: "같은 요청이 다른 결정으로 기록되어 있습니다. 다시 시도하세요.",
    };
  }
  if (httpStatus === 404) {
    return {
      kind: "error",
      errorCopy: "이 승인 요청을 찾을 수 없습니다. 이미 정리되었을 수 있습니다.",
    };
  }
  return {
    kind: "error",
    errorCopy: "이 승인을 결정할 권한이 없습니다. 채널 멤버인지 확인하세요.",
  };
}
