import React, {createContext, useContext} from 'react';
import {Text, type StyleProp, type TextStyle} from 'react-native';

import {highlightParts, queryRanges} from './localSearch';

// =============================================================================
// 말풍선 본문 안의 찾은 글자 강조 (#5384).
//
// 대화 안 검색으로 착지한 메시지는 행 틴트(1.5초)만 있었고 **어느 글자가 찾은 말인지**는 말풍선 안에서 알 수 없었다. 이 맥락이 서 있는 동안(`MessageBody` 가 세운다)
// 본문의 글자 잎(`ExpressionText`)이 찾은 말과 같은 조각을 `style` 로 칠한다. 칠하는 일만 한다 — 규칙(대소문자 접기·코드포인트·겹치지 않는 나열)은 `localSearch.queryRanges` 의
// 것이고, 색은 `bubble.searchMatchFor` 가 말풍선에서 유도한다.
//
// 맥락은 **본문 글자 잎**만 읽는다. 인용 머리·작성자·시각·코드 블록·인라인 코드·멘션은 이 잎을 거치지 않으므로 칠해지지 않는다(「본문 부분에만」).
// =============================================================================

export interface SearchMatchSpec {
  /** 찾은 말(다듬은 것). */
  query: string;
  /** 일치한 조각이 입는 스타일. 글자색은 두지 않는다 — 말풍선 잉크를 상속한다. */
  style: StyleProp<TextStyle>;
}

export const SearchMatchContext = createContext<SearchMatchSpec | null>(null);

/** 본문 하나를 이 범위에 둔다. 찾은 말이 없으면(`null`) 맥락을 세우지 않는다 — 평소 행은 아무것도 달라지지 않는다. */
export function MatchScope({
  spec,
  children,
}: {
  spec: SearchMatchSpec | null;
  children: React.ReactNode;
}): React.JSX.Element {
  if (spec === null) return <>{children}</>;
  return <SearchMatchContext.Provider value={spec}>{children}</SearchMatchContext.Provider>;
}

/** `text` 를 찾은 말 기준으로 조각내 일치한 조각만 칠한다. 일치가 없으면 글 그대로다(요소를 만들지 않는다). */
export function MatchedText({text}: {text: string}): React.JSX.Element {
  const spec = useContext(SearchMatchContext);
  if (spec === null) return <>{text}</>;
  const ranges = queryRanges(text, spec.query);
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((part, index) =>
        part.match ? (
          <Text key={index} style={spec.style} testID="message-search-match">
            {part.text}
          </Text>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}
