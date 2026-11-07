import type { Message } from "../../lib/api";
import { matchesExpressionContract } from "./contracts";
import {
  EXPRESSION_SET_ACTION_ID, expressionSetIssues, expressionSetPlanIssues, parseExpressionSetResult,
  type ExpressionSetApproval, type ExpressionSetPlanCard, type ExpressionSetResult,
} from "./set";

/**
 * ADR-0218 §12 (#5442) as the two TS clients read it off the wire (#5462 web, S4 phone). `set.ts` has the types and the pure rules; this file
 * is the seam between those and a chat message: where on `approval_request.props` each card lives, what is refused before anything is drawn,
 * and the one shape of the decision request. No DOM, no network (the clients send it), no sentences.
 */

/** The plan card's action id (L2.5). The core had no constant: the server slice (S5a) raises the card, this names it. */
export const EXPRESSION_SET_PLAN_ACTION_ID = "expression.set.plan" as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The approved set a card shows (`props.action.expressionSet`, L5.2), or null when this is not a readable set card. Two checks, not one:
 * the schema refuses a 41st slot, and `expressionSetIssues` refuses what a schema cannot say (a name used twice, a still that is a GIF,
 * and a set inside 40 slots whose pictures together pass the 24 MiB budget). Either way the card is not drawn ("한도 초과는 보이지 않음").
 */
export function expressionSetFromProps(props: unknown): ExpressionSetApproval | null {
  const action = record(record(props).action);
  if (action.id !== EXPRESSION_SET_ACTION_ID || !matchesExpressionContract("SetApproval", action.expressionSet)) return null;
  const set = action.expressionSet as ExpressionSetApproval;
  return expressionSetIssues(set).length === 0 ? set : null;
}

/**
 * The plan a plan card shows (`props.action.expressionSetPlan`). **[추정]**: ADR-0218 L2.5 leaves the carrier of the plan card to the
 * server slice (S5a, "전달 [추정, S5a가 확정]"); this reads it beside `expressionSet`. If the server fixes another key, this is the one line to change.
 */
export function expressionSetPlanFromProps(props: unknown): ExpressionSetPlanCard | null {
  const action = record(record(props).action);
  if (action.id !== EXPRESSION_SET_PLAN_ACTION_ID || !matchesExpressionContract("SetPlanCard", action.expressionSetPlan)) return null;
  const plan = action.expressionSetPlan as ExpressionSetPlanCard;
  return expressionSetPlanIssues(plan).length === 0 ? plan : null;
}

/** What a settled set card says it did (`props.result.expressionSet`, L5.5): the card changes in place, there is no second message. */
export function expressionSetResultFromProps(props: unknown): ExpressionSetResult | null {
  const result = record(record(props).result);
  return result.status === "executed" ? parseExpressionSetResult(result.expressionSet) : null;
}

/** What the decision receipt of an approval says it did (`result.expressionSet`). The receipt's `result` has no `status` of its own. */
export function expressionSetResultFromReceipt(receipt: unknown): ExpressionSetResult | null {
  return parseExpressionSetResult(record(record(receipt).result).expressionSet);
}

/**
 * The same three readers for a whole chat message (S4 phone, #5463). The phone hands MESSAGES to the core and never touches their props
 * itself (`actionApprovalCard.test.tsx` fails on any `.props` read in `clients/mobile/src`), so the seam takes `Pick<Message, "props">`
 * the way `appsRunIdOf` does. Nothing is decided here: each reads exactly what its `...FromProps` twin reads.
 */
export const expressionSetOfMessage = (message: Pick<Message, "props">): ExpressionSetApproval | null => expressionSetFromProps(message.props);
export const expressionSetPlanOfMessage = (message: Pick<Message, "props">): ExpressionSetPlanCard | null => expressionSetPlanFromProps(message.props);
export const expressionSetResultOfMessage = (message: Pick<Message, "props">): ExpressionSetResult | null => expressionSetResultFromProps(message.props);

/**
 * The closed codes the decision route answers a set approval with when it spent nothing (L5.4, L6.1). The real route carries them in the
 * RECEIPT's `status` (a 409 receipt `expression_preview_stale`, as the 403 `role_required` of ADR-0186 is a receipt too), not in an error
 * envelope; the fake server still answers `{error:{code}}` and so does not reach this.
 */
export const EXPRESSION_SET_DECISION_FAILURES = ["expression_preview_stale", "expression_name_reserved", "expression_quota"] as const;
export type ExpressionSetDecisionFailure = (typeof EXPRESSION_SET_DECISION_FAILURES)[number];

/** The failure a refused decision receipt names, or null (an unknown word is not one of ours: the generic reading applies). */
export function expressionSetDecisionFailure(receipt: unknown): ExpressionSetDecisionFailure | null {
  const status = record(receipt).status;
  return EXPRESSION_SET_DECISION_FAILURES.find((code) => code === status) ?? null;
}

export interface ExpressionDecisionRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}
/**
 * The one decision request (`POST …/approvals/{id}/decision`, an existing route: the sets add fields, not paths). `fields` is what the card adds
 * to the three that always travel: `{approve: true, expressionChoices}` for a set, `{approve: false}` for a refusal, and for the plan card
 * `{approve: true}` (make it) or `{approve: false}` (cancel). The same `clientDecisionId` makes a retry the same decision (the server answers
 * the first receipt again). The identity keys are written last: `fields` cannot name another approval.
 */
export function expressionDecisionRequest(base: string, approvalId: string, clientDecisionId: string, fields: Readonly<Record<string, unknown>>): ExpressionDecisionRequest {
  return {
    method: "POST",
    path: `${base}/approvals/${approvalId}/decision`,
    body: { ...fields, approval_id: approvalId, client_decision_id: clientDecisionId },
  };
}
