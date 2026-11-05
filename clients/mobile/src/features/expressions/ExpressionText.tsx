import type {Expression} from '@momo/core/features/expressions/types';
import {
  expressionMessageModel,
  expressionToken,
} from '@momo/core/features/expressions/message';
import React, {createContext, useContext} from 'react';
import {MatchedText} from '../search/MatchedText';
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

/**
 * 본문 글자 잎. 이모티콘 표식(`\uE000…\uE001`)을 그림으로 바꾸고, 대화 안 검색 중이면(`SearchMatchContext`, #5384) **표식이 아닌 글자 조각**에서만 찾은 말을 칠한다 —
 * 표식을 먼저 가르므로 표식 안의 숫자가 찾은 말과 같아도 표식이 잘리지 않는다.
 */
export function ExpressionText({text}: {text: string}) {
  const replacements = useContext(ExpressionTextContext);
  if (replacements.size === 0) return <MatchedText text={text} />;
  return (
    <>
      {text.split(/(\uE000+\d+\uE001)/).map((part, index) => {
        const expression = replacements.get(part);
        return expression ? (
          <ExpressionImage key={index} expression={expression} size="inline" />
        ) : (
          <MatchedText key={index} text={part} />
        );
      })}
    </>
  );
}
