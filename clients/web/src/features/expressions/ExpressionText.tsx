import { Fragment } from "react";
import { expressionMessageModel, tokenizeExpressionReaction } from "@momo/core/features/expressions/message";
import { ExpressionImage } from "./ExpressionImage";
import { useExpressions } from "./context";

export function ExpressionText({ text, size, reaction = false }: { text: string; size?: "inline" | "medium" | "large"; reaction?: boolean }) {
  const { cache } = useExpressions();
  const model = expressionMessageModel(text, cache.items);
  const tokens = reaction ? [tokenizeExpressionReaction(text, cache.items)] : model.tokens;
  return <>{tokens.map((token, index) => token.type === "text" ? <Fragment key={index}>{token.text}</Fragment> :
    <ExpressionImage key={token.expression.id + ":" + index} item={token.expression} size={reaction ? "reaction" : size ?? model.size} />)}</>;
}
