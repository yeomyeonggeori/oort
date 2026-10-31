import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import type { ExpressionApproval, ExpressionResult } from "@momo/core/features/expressions/types";
export function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Read only alongside a server-owned approval/action-result card, never plain messages. */
export function expressionApprovalPayload(props: unknown): ExpressionApproval | null {
  const action = record(record(props).action);
  if (action.id !== "expression.create" || !matchesExpressionContract("Approval", action.expression)) return null;
  const payload = action.expression as ExpressionApproval;
  const first = payload.candidates[0];
  return payload.candidates.every((draft) => draft.workspaceId === first.workspaceId && draft.subjectMemberId === first.subjectMemberId) ? payload : null;
}
export function expressionResultPayload(props: unknown): ExpressionResult | null {
  const result = record(record(props).result);
  return result.status === "executed" && matchesExpressionContract("Result", result.expression) ? result.expression as ExpressionResult : null;
}

