import { EXPRESSION_LIMITS } from "@momo/core/features/expressions/types";
import type { Expression, ExpressionDraft, ExpressionVariant } from "@momo/core/features/expressions/types";
export function expressionImagePath(base: string, item: Expression | ExpressionDraft, variant: ExpressionVariant) {
  const image = item.media?.[variant];
  if (!image) return null;
  const resource = "draftId" in item ? `expression-drafts/${item.draftId}` : `expressions/${item.id}`;
  return `${base}/${resource}/image?size=${variant}&v=${image.sha256}`;
}
/** 표현의 그림 경로(`…/expressions/{id}/image?…`)에서 표현 id. 초안 미리보기 경로(`expression-drafts/…`)와 다른 모양은 `null`. */
export function expressionIdOfImagePath(path: string): string | null {
  return /\/expressions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/image\?/.exec(path)?.[1] ?? null;
}
export const EXPRESSION_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export function validExpressionFile(file: File) { return file.size > 0 && file.size <= EXPRESSION_LIMITS.inputBytes && EXPRESSION_FILE_ACCEPT.split(",").includes(file.type); }
