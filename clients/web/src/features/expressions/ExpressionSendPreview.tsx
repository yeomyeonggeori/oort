import { expressionMessageModel } from "@momo/core/features/expressions/message";
import { ExpressionImage } from "./ExpressionImage";
import { useExpressions } from "./context";

/** Picking only fills the composer. Its existing Send/Enter is the second action. */
export function ExpressionSendPreview({ body }: { body: string }) {
  const { cache, offline } = useExpressions();
  const model = expressionMessageModel(body, cache.items);
  if (model.size !== "large") return null;
  const token = model.tokens.find((part) => part.type === "expression");
  if (!token || token.type !== "expression") return null;
  return <div className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="expression-send-preview">
    <ExpressionImage item={token.expression} size="large" />
    <p className="text-meta text-ink-muted">{offline ? "연결되면 보낼 수 있어요." : "큰 그림으로 보내요. 보내기 버튼이나 Enter를 한 번 더 눌러 주세요."}</p>
  </div>;
}
