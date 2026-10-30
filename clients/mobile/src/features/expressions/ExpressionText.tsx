import type {Expression} from '@momo/core/features/expressions/types';
import {
  expressionMessageModel,
  expressionToken,
} from '@momo/core/features/expressions/message';
import React, {createContext, useContext} from 'react';
import {ExpressionImage} from './ExpressionImage';

/** Tokenize the original Markdown before escapes/links are consumed by the host parser. */
export function prepareExpressionBody(
  body: string,
  items: readonly Expression[],
) {
  const model = expressionMessageModel(body, items);
  let prefix = '\uE000';
  while (body.includes(prefix)) prefix += '\uE000';
  const replacements = new Map<string, Expression>();
  const markdown = model.tokens
    .map(token => {
      if (token.type === 'text') return token.text;
      const marker = `${prefix}${replacements.size}\uE001`;
      replacements.set(marker, token.expression);
      return marker;
    })
    .join('');
  return {...model, markdown, replacements};
}
export const ExpressionTextContext = createContext<
  ReadonlyMap<string, Expression>
>(new Map());

/** The host parser can classify malformed Markdown differently from the scanner. */
export function useExpressionLiteral() {
  const replacements = useContext(ExpressionTextContext);
  return (text: string) =>
    text.replace(/\uE000+\d+\uE001/g, marker => {
      const expression = replacements.get(marker);
      return expression ? expressionToken(expression.name) : marker;
    });
}

export function ExpressionText({text}: {text: string}) {
  const replacements = useContext(ExpressionTextContext);
  if (replacements.size === 0) return <>{text}</>;
  return (
    <>
      {text.split(/(\uE000+\d+\uE001)/).map((part, index) => {
        const expression = replacements.get(part);
        return expression ? (
          <ExpressionImage key={index} expression={expression} size="inline" />
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        );
      })}
    </>
  );
}
