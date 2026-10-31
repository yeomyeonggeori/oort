import { EXPRESSION_LIMITS } from "@momo/core/features/expressions/types";
import type { Expression, ExpressionDraft, ExpressionVariant } from "@momo/core/features/expressions/types";
export function expressionImagePath(base: string, item: Expression | ExpressionDraft, variant: ExpressionVariant) {
  const image = item.media?.[variant];
  if (!image) return null;
  const resource = "draftId" in item ? `expression-drafts/${item.draftId}` : `expressions/${item.id}`;
  return `${base}/${resource}/image?size=${variant}&v=${image.sha256}`;
}
export const EXPRESSION_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export function validExpressionFile(file: File) { return file.size > 0 && file.size <= EXPRESSION_LIMITS.inputBytes && EXPRESSION_FILE_ACCEPT.split(",").includes(file.type); }
