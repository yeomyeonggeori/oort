import { createContext } from "react";
import { expressionMessageModel } from "@momo/core/features/expressions/message";
import type { Expression } from "@momo/core/features/expressions/types";
// Tokenize the ORIGINAL Markdown, before its parser removes escapes. Only
// expression leaves become opaque markers; code and URL nodes stay untouched.
export function prepareExpressionMarkdown(body: string, items: readonly Expression[]) {
  let marker = "\ue000expression";
  while (body.includes(marker)) marker += "_";
  const model = expressionMessageModel(body, items);
  const expressions: Expression[] = [];
  const text = model.tokens.map((token) => {
    if (token.type === "text") return token.text;
    expressions.push(token.expression);
    return `${marker}${expressions.length - 1}\ue001`;
  }).join("");
  return { text, marker, expressions, size: model.size };
}
type Prepared = ReturnType<typeof prepareExpressionMarkdown>;
export const ExpressionMarkdownContext = createContext<Prepared | null>(null);

export const ExpressionLinkContext = createContext(false);
