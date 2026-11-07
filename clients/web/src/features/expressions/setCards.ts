import { authedResponse } from "@momo/core/lib/api";
import { expressionSetDecisionFailure, type ExpressionDecisionRequest, type ExpressionSetDecisionFailure } from "@momo/core/features/expressions/setWire";
import type { MessageArgs, MessageKey } from "@momo/core/i18n";
import { APPROVAL_STATUS_LABEL, type ApprovalStatus } from "@momo/core/features/timeline/agentCardModel";
import { interpretReceipt, type ApprovalDecisionReceipt } from "@momo/core/features/timeline/approvalDecision";

// =============================================================================
// 계획 카드와 세트 카드(ADR-0218 §12 L2.5·L5, #5462)가 함께 쓰는 곳: 결정 요청을 보내고 그 답을 읽는 한 곳, 그리고 승인 상태 이름.
// 카드가 어느 props 자리에 사는지, 어떤 묶음을 그리지 않는지, 요청의 모양은 코어(`setWire.ts`)에 있다: 폰 칸(S4)도 같은 것을 읽는다.
//
// 이 파일에 상태 이름을 문자열로 두지 않는다(직접 문구 장부: 새 파일은 0줄이어야 한다). 이름은 코어가 이미 가진 목록의 키에서 오고,
// 갈래는 숫자다. `Status.approved === "approved"`가 타입으로도 성립한다.
// =============================================================================

/** 승인 상태 이름: 코어의 `APPROVAL_STATUS_LABEL` 키를 그대로 이름 객체로 만든다. 코어가 목록을 바꾸면 타입이 먼저 깨진다. */
export const Status = Object.fromEntries(Object.keys(APPROVAL_STATUS_LABEL).map((name) => [name, name])) as { readonly [K in ApprovalStatus]: K };
/** 아직 결정할 수 있는 상태인가. 상태마다 한 칸이라 새 상태가 생기면 타입이 채우라고 한다. */
export const OPEN: Readonly<Record<ApprovalStatus, boolean>> = { pending: true, approved: false, rejected: false, expired: false, cancelled: false };

/** 인자가 없는 문장의 키: 카드가 상태로 들고 있다가 그대로 그리는 한 줄은 이 키여야 `formatMessage(키)` 한 인자로 불린다. */
export type PlainKey = { [K in MessageKey]: MessageArgs[K] extends Record<string, never> ? K : never }[MessageKey];

/** 결정 한 번의 결과 갈래. */
export const Decided = { ok: 0, settled: 1, failed: 2 } as const;
export type SetDecisionOutcome =
  /** 200: 서버가 이 결정을 받았다(승인이든 거절이든). 영수증을 그대로 넘긴다. */
  | { kind: typeof Decided.ok; receipt: unknown }
  /** 409인데 영수증이 끝난 상태를 말한다: 다른 곳에서 이미 결정됐거나 그 전에 만료됐다. */
  | { kind: typeof Decided.settled; status: ApprovalStatus }
  /** 결정은 기록되지 않았다. `freshKey`가 참이면 같은 멱등 키가 다른 결정에 묶여 있어 새 키로 다시 눌러야 한다. */
  | { kind: typeof Decided.failed; line: PlainKey; freshKey: boolean };

/**
 * 결정 라우트가 세트 승인에 대해 아무것도 쓰지 않고 돌려주는 닫힌 코드 셋과 그 한 줄. **실서버는 코드를 오류 봉투가 아니라 영수증의 `status`에 싣는다**
 * (코어 `expressionSetDecisionFailure`가 그렇게 읽는다). 가짜 서버는 아직 `{error:{code}}` 봉투로 주므로 가짜 서버로는 이 갈래가 안 닿는다.
 */
const FAILURE_LINE = {
  expression_preview_stale: "expressions.set.errorStale",
  expression_name_reserved: "expressions.set.errorTaken",
  expression_quota: "expressions.set.errorQuota",
} as const satisfies Record<ExpressionSetDecisionFailure, PlainKey>;

const refused = (line: PlainKey, freshKey = false): SetDecisionOutcome => ({ kind: Decided.failed, line, freshKey });

/**
 * 결정 한 번을 보낸다. `request`는 코어 `expressionDecisionRequest`가 만든 것이다. 같은 키로 다시 보내면 같은 결정이라 서버가 첫 영수증을 돌려주고,
 * 영수증이 아닌 답이나 닿지 못한 요청은 `failed`다(기록된 것이 없으니 다시 누를 수 있다).
 */
export async function sendSetDecision(request: ExpressionDecisionRequest): Promise<SetDecisionOutcome> {
  let response;
  try { response = await authedResponse(request.path, { method: request.method, body: JSON.stringify(request.body) }); }
  catch { return refused("expressions.set.errorGeneric"); }
  let receipt: unknown;
  try { receipt = response.json(); } catch { return refused("expressions.set.errorGeneric"); }
  if (response.status === 200) return { kind: Decided.ok, receipt };
  const code = expressionSetDecisionFailure(receipt);
  if (code !== null) return refused(FAILURE_LINE[code]);
  const outcome = interpretReceipt(response.status, (receipt ?? {}) as ApprovalDecisionReceipt);
  // 200이 아닌 답에서 `status`가 실리는 갈래는 「이미 끝난 승인」(409) 하나뿐이다.
  if (outcome.status !== undefined) return { kind: Decided.settled, status: outcome.status };
  return refused("expressions.set.errorGeneric", outcome.errorCode === "idempotency_conflict");
}
