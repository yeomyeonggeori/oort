import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { readExpressionApproval } from "@momo/core/features/expressions/cards";
import type { ExpressionApproval, ExpressionResult } from "@momo/core/features/expressions/types";
export function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Read only alongside a server-owned approval/action-result card, never plain messages. */
export function expressionApprovalPayload(props: unknown): ExpressionApproval | null {
  const action = record(record(props).action);
  // A candidate with a code this build does not know stays on the card as that one neutral line (#5934).
  const payload = action.id === "expression.create" ? readExpressionApproval(action.expression) : null;
  if (payload === null) return null;
  const first = payload.candidates[0];
  return payload.candidates.every((draft) => draft.workspaceId === first.workspaceId && draft.subjectMemberId === first.subjectMemberId) ? payload : null;
}
export function expressionResultPayload(props: unknown): ExpressionResult | null {
  const result = record(record(props).result);
  return result.status === "executed" && matchesExpressionContract("Result", result.expression) ? result.expression as ExpressionResult : null;
}

