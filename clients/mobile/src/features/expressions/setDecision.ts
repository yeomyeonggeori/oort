import {authedResponse} from '@momo/core/lib/api';
import {
  expressionSetDecisionFailure,
  type ExpressionDecisionRequest,
  type ExpressionSetDecisionFailure,
} from '@momo/core/features/expressions/setWire';
import {
  APPROVAL_STATUS_LABEL,
  type ApprovalStatus,
} from '@momo/core/features/timeline/agentCardModel';
import {
  interpretReceipt,
  type ApprovalDecisionReceipt,
  type DecisionOutcome,
} from '@momo/core/features/timeline/approvalDecision';
import type {PlainMessageKey} from './useExpressionMessages';

// =============================================================================
// 계획 카드와 세트 카드(ADR-0218 §12 L2.5·L5, #5463 폰)가 함께 쓰는 곳: 결정 요청을 보내고 그 답을 읽는 한 곳, 그리고 승인 상태 이름.
// 웹 `setCards.ts` 의 폰 짝이다. 카드가 어느 자리에 사는지·어떤 묶음을 그리지 않는지·요청의 모양은 코어(`setWire.ts`)가 말한 그대로고,
// 이 파일은 **폰이 보내는 길**(`authedResponse`)만 안다. 결정은 서버 라우트(`POST …/approvals/{id}/decision`)로만 나간다: 이 화면은
// 등록도 publish 도 직접 하지 않는다.
//
// 이 파일에는 상태 이름을 글자 리터럴로 두지 않는다(직접 문구 장부: 새 파일은 0칸). 이름은 코어가 이미 가진 목록의 키에서 오고,
// 갈래는 숫자다. `Status.approved === 'approved'` 가 타입으로도 성립한다.
//
// 왜 `ApprovalDecision`·`decideApproval` 이 아닌가: 둘 다 결정 본문이 `{approve, hostId}` 로 닫혀 있어 `expressionChoices`·`planRevision`
// 을 실을 수 없다. 대신 결과는 같은 `DecisionOutcome` 으로 접어 화면의 영수증 표(`onApprovalSettled`)에 그대로 넣는다 — 카드가 끝났다는
// 사실은 다른 승인 카드와 같은 한 곳에서 읽힌다.
// =============================================================================

/** 승인 상태 이름: 코어 `APPROVAL_STATUS_LABEL` 의 키를 이름 객체로 만든다. 코어가 목록을 바꾸면 타입이 먼저 깨진다. */
export const Status = Object.fromEntries(
  Object.keys(APPROVAL_STATUS_LABEL).map(name => [name, name]),
) as {readonly [K in ApprovalStatus]: K};

/** 결정 한 번의 결과 갈래. */
export const Decided = {ok: 0, settled: 1, failed: 2} as const;

export type SetDecisionOutcome =
  /** 200: 서버가 이 결정을 받았다(승인이든 거절이든). `receipt` 는 영수증 그대로, `outcome` 은 화면 영수증 표에 넣을 값이다. */
  | {kind: typeof Decided.ok; receipt: unknown; outcome: DecisionOutcome}
  /** 409 인데 영수증이 끝난 상태를 말한다: 다른 곳에서 이미 결정됐거나 그 전에 만료됐다. */
  | {kind: typeof Decided.settled; outcome: DecisionOutcome}
  /** 결정은 기록되지 않았다. `freshKey` 가 참이면 같은 멱등 키가 다른 결정에 묶여 있어 새 키로 다시 눌러야 한다. */
  | {kind: typeof Decided.failed; line: PlainMessageKey; freshKey: boolean};

/**
 * 결정 라우트가 세트 승인에 대해 아무것도 쓰지 않고 돌려주는 닫힌 코드 셋과 그 한 줄. 실서버는 코드를 오류 봉투가 아니라 영수증의 `status` 에
 * 싣는다(코어 `expressionSetDecisionFailure` 가 그렇게 읽는다).
 */
const FAILURE_LINE = {
  expression_preview_stale: 'expressions.set.errorStale',
  expression_name_reserved: 'expressions.set.errorTaken',
  expression_quota: 'expressions.set.errorQuota',
} as const satisfies Record<ExpressionSetDecisionFailure, PlainMessageKey>;

/** 객체(영수증 본문)인가: `typeof` 낱말 비교 대신 — 글자 리터럴이 직접 문구 장부에 한 칸으로 세어진다. */
const isRecord = (value: unknown): value is object =>
  value !== null && Object(value) === value && !Array.isArray(value);

const refused = (
  line: PlainMessageKey,
  freshKey = false,
): SetDecisionOutcome => ({kind: Decided.failed, line, freshKey});

/**
 * 결정 한 번을 보낸다. `request` 는 코어 `expressionDecisionRequest` 가 만든 것이다. 같은 키로 다시 보내면 같은 결정이라 서버가 첫
 * 영수증을 돌려주고, 영수증이 아닌 답이나 닿지 못한 요청은 `failed` 다(기록된 것이 없으니 다시 누를 수 있다).
 * `approve` 는 **사람이 누른 방향**이다: 200 이면 서버가 그 방향으로 기록한 것이므로 화면 영수증은 그 방향을 말한다(실서버의 성공 `status`
 * 낱말이 `approved`·`executed` 어느 쪽이든 같은 길이다).
 */
export async function sendSetDecision(
  request: ExpressionDecisionRequest,
  approve: boolean,
): Promise<SetDecisionOutcome> {
  let response;
  try {
    response = await authedResponse(request.path, {
      method: request.method,
      body: JSON.stringify(request.body),
      headers: {'Content-Type': 'application/json'},
    });
  } catch {
    return refused('expressions.set.errorGeneric');
  }
  const receipt: unknown = response.jsonOrNull();
  if (!isRecord(receipt)) return refused('expressions.set.errorGeneric');
  if (response.status === 200) {
    const read = interpretReceipt(200, receipt as ApprovalDecisionReceipt);
    // 200 의 `read` 는 `committed` 다. 방향만 사람이 누른 것으로 덮는다.
    return {
      kind: Decided.ok,
      receipt,
      outcome: {...read, status: approve ? Status.approved : Status.rejected},
    };
  }
  const code = expressionSetDecisionFailure(receipt);
  if (code !== null) return refused(FAILURE_LINE[code]);
  const outcome = interpretReceipt(
    response.status,
    receipt as ApprovalDecisionReceipt,
  );
  // 200 이 아닌 답에서 `status` 가 실리는 갈래는 「이미 끝난 승인」(409) 하나뿐이다.
  if (outcome.status !== undefined) return {kind: Decided.settled, outcome};
  return refused(
    'expressions.set.errorGeneric',
    outcome.errorCode === 'idempotency_conflict',
  );
}
