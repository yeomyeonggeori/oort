import { NetworkError, fetchWithDeadline, type HttpResponse } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";
import {
  ABSENT_STATUSES,
  serverSurface,
} from "../capabilities/serverSurfaces";
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

/**
 * 결정 영수증. **두 표기를 모두 읽는다** (goal W-AP1 2R, 지적 N2).
 *
 * 이 클라이언트는 Swift 서버의 계약을 보고 자랐고, 그 서버는 이 본문을
 * snake_case로 냈다(`ApprovalDecisionRoutes.swift`의 `CodingKeys`). Rust 포팅은
 * 같은 구조체에 `#[serde(rename_all = "camelCase")]`를 달아 `approvalId` ·
 * `decidedBy` · `decidedAtMs`로 낸다(`dto.rs:2269-2279`, 그리고 손으로 쓴
 * `crates/momo-agent/src/approval.rs:638-644`도 같은 표기다).
 *
 * 그 차이가 조용했던 이유는 `status`가 두 표기에서 같은 글자이기 때문이다. 그래서
 * 커밋/이미 결정됨/멱등 충돌 **판정은 멀쩡히 살아 있고**, 버려지는 것은 "누가,
 * 언제 결정했는가"뿐이었다. 그 두 값은 웹 카드의 「승인」 원장 줄
 * (`AgentCard.tsx:254-259`)이 서는 조건 그 자체라, 결정한 직후 그 줄이 통째로
 * 사라진다. 아무 오류도 나지 않으므로 화면은 "결정은 됐는데 누가 했는지는 없다"고
 * 말한다.
 *
 * 표기를 하나로 고르지 않고 **둘 다** 읽는 이유: 이 레포에는 지금 두 서버가 산다.
 * 어느 한쪽을 고르면 다른 쪽 앞에서 같은 결함이 반대 방향으로 재현된다. 서버
 * 쪽 정정(정본 스펙 `docs/api/openapi.yaml`은 snake_case다)은 별도 goal이고,
 * 그것이 오더라도 이 파서는 그대로 옳다.
 */
export interface ApprovalDecisionReceipt {
  /** 이 클라이언트는 읽지 않는다(경로가 이미 어느 승인인지 안다). 계약 기록용. */
  approval_id?: string;
  approvalId?: string;
  /** 두 표기에서 글자가 같은 유일한 필드. 그래서 이 결함이 조용했다. */
  status: string;
  decided_by?: string | null;
  decidedBy?: string | null;
  decided_at_ms?: number | null;
  decidedAtMs?: number | null;
  decision_reason?: string | null;
  decisionReason?: string | null;
}

/**
 * 표기 판정은 **필드마다 따로** 한다.
 *
 * 한 필드를 보고 표기를 정한 뒤 나머지를 그 표기로 읽으면, 서버가 `None`인 필드를
 * 아예 빼는 순간(`skip_serializing_if = "Option::is_none"`, Rust 영수증이 정확히
 * 그렇다) 판정의 근거가 사라져 나머지가 통째로 버려진다. 필드별로 물으면 어떤
 * 조합이 와도 있는 것만 읽고 없는 것만 없다.
 *
 * snake를 먼저 보는 이유는 그것이 정본 스펙이고, 두 표기가 함께 온다면 정본이
 * 이겨야 하기 때문이다.
 */
function receiptString(
  snake: string | null | undefined,
  camel: string | null | undefined
): string | undefined {
  const value = typeof snake === "string" ? snake : camel;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function receiptNumber(
  snake: number | null | undefined,
  camel: number | null | undefined
): number | undefined {
  const value = typeof snake === "number" ? snake : camel;
  return typeof value === "number" ? value : undefined;
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
  /**
   * 왜 `error`인지를 읽는 쪽이 **색으로** 구분할 수 있게 하는 갈래
   * (goal W-AP1 2R M1).
   *
   *   idempotency_conflict  캐시된 멱등 키를 버리고 새 키로 다시 시도해야 한다.
   *   surface_absent        이 서버에 승인 라우트가 없다. **장애가 아니다.**
   *
   * `surface_absent`가 별도의 `kind`가 아니라 여기 있는 이유: 이 결과는
   * `kind: "error"`로 남아야 한다. 결정은 실제로 기록되지 않았고, 그것을
   * `committed` 옆의 새 갈래로 빼면 그 갈래를 모르는 호출자가 조용히 "결정됨"
   * 쪽으로 떨어뜨린다(모바일 푸시 경로 `push/notifications.ts:139-145`가 정확히
   * 그 모양이다 — `kind === 'error'`만 실패로 세고 나머지는 전부 decided).
   * 아무 일도 일어나지 않았는데 결정됐다고 보고하는 것이 이 필드가 막는 것이다.
   *
   * 그래서 판정은 error로 두되 이유를 함께 실어, 화면이 빨간 alert 대신 미제공
   * 문구로 그릴 수 있게 한다. 같은 404를 목록 쪽은 이미 미제공으로 접고 있으므로
   * (features/capabilities/serverSurfaces.ts), 한 화면에서 같은 사실이 두 가지
   * 색을 갖는 일이 없어야 한다.
   */
  errorCode?: "idempotency_conflict" | "surface_absent";
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

/**
 * 서버가 답은 했지만 그 답이 영수증이 아닐 때, 사람에게 할 말 (2R, 리뷰 M5 이관).
 *
 * **상태 코드를 화면에 그대로 올리지 않는다.** "서버가 500로 응답했습니다"는
 * 사람에게 문장이 아니라 로그 조각이고, 읽는 사람이 그 숫자로 할 수 있는 일이
 * 없다. 대신 그가 실제로 판단할 수 있는 세 갈래로 접는다: 지금 다시 눌러도
 * 되는가, 조금 기다려야 하는가, 서버 쪽 문제인가. 원문이 필요한 사람은 네트워크
 * 탭을 본다.
 *
 * 이 접는 방식은 이 코드베이스가 이미 쓰던 것이다
 * (clients/web/src/features/routing/capability.ts `unsettledAnswerClause`).
 * 규칙이 두 벌로 갈라지면 한쪽만 고쳐지는 날이 온다.
 */
export function unsettledAnswerClause(status: number): string {
  if (status === 429) return "요청이 잦아 서버가 이번 결정을 받지 않았습니다.";
  if (status >= 500) return "서버가 오류로 답했습니다. 잠시 후 다시 시도하세요.";
  return "서버가 이 결정을 받지 않았습니다. 다시 시도하세요.";
}

export async function decideApproval(
  workspaceId: string,
  approvalId: string,
  approve: boolean,
  clientDecisionId: string
): Promise<DecisionOutcome> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = coreSession().getAccessToken();
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
      errorCopy: `결정을 처리하지 못했습니다. ${unsettledAnswerClause(response.status)}`,
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
    // 2R M1: 문구만으로는 부족했다. 읽는 쪽은 이것을 `kind: "error"`로만 보고
    // 빨간 alert(role="alert" + --danger)로 그렸고, 그 화면의 목록은 같은 404를
    // 조용한 미제공으로 접고 있었다. 한 화면이 같은 사실을 두 색으로 말한 것이다.
    return {
      kind: "error",
      errorCode: "surface_absent",
      errorCopy: serverSurface("approvals").absentReason,
    };
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
  const decidedAtMs = receiptNumber(receipt.decided_at_ms, receipt.decidedAtMs);
  const decidedBy = receiptString(receipt.decided_by, receipt.decidedBy);

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
