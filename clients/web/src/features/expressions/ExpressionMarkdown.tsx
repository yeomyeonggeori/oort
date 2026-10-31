import { ExpressionMarkdownContext, ExpressionLinkContext } from "./markdown";
import { Fragment, useContext } from "react";
import { ExpressionImage } from "./ExpressionImage";

export function PreparedExpressionText({ text }: { text: string }) {
  const context = useContext(ExpressionMarkdownContext);
  const link = useContext(ExpressionLinkContext);
  if (!context || context.expressions.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${context.marker}[0-9]+\\ue001)`, "g");
  return <>{text.split(pattern).map((part, index) => {
    const entry = part.startsWith(context.marker) && part.endsWith("\ue001") ? context.expressions[Number(part.slice(context.marker.length, -1))] : undefined;
    return entry && link ? <Fragment key={index}>{`:${entry.name}:`}</Fragment> : entry ? <ExpressionImage key={index} item={entry} size={context.size} /> : <Fragment key={index}>{part}</Fragment>;
  })}</>;
}
