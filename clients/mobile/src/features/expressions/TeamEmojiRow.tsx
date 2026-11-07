import {
  buildExpressionMessage,
  expressionAltText,
} from '@momo/core/features/expressions/message';
import type {Expression} from '@momo/core/features/expressions/types';
import React, {useMemo, useRef, useState} from 'react';
import {FlatList, Keyboard, Pressable, Text, View} from 'react-native';
import {useStyles} from '../../design/theme';
import {TOUCH_TARGET} from '../../design/tokens';
import {ExpressionImage} from './ExpressionImage';
import {useExpressions} from './ExpressionProvider';
import {browseExpressions, type ExpressionTab} from './expressionViews';
import {buildStyles, resolveActiveExpression} from './TeamExpressionPicker';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 이모지 탭의 팀 이모지 한 줄 (#5453, owner 2026-11-07) - 웹 고르개의 `TeamEmojiStrip` 과 같은 쓰임이다.
//
// 이모지 탭은 표준 그림 문자 목록(`EmojiPicker` 본문)에 팀의 작은 이모지(코어 `EXPRESSION_TAB_SHELVES.emoji` = `team` 칸)를 한 탭으로 합친다. 우리 팀 것과 기본을
// 탭으로 가르지 않으므로 이 줄에는 머리글이 없다 - 낭독 이름(`expressions.picker.teamGroup`)만 있다. 검색어는 시트의 검색 칸 하나가 준다.
// 고르면 `:이름:` 을 돌려준다(입력칸에 넣는다): 작은 그림은 글 사이에 들어가는 쓰임이라 미리 보기도 보내기도 없다.
//
// 네 상태: 있음(그림 한 줄) · 비어 있음(줄이 서지 않는다 - 표준 목록이 이 탭의 본문이다) · 불러오는 중·오류(줄이 서지 않는다, 표준 목록은 이미 서 있고
// 받아 둔 목록이 있으면 읽기가 실패해도 그대로 둔다) · 고르는 사이 사라짐(한 문장).
// =============================================================================

// 시험 열쇠는 컴포넌트 밖에서 만든다: 직접 문구 장부는 JSX 안의 문자열 조각을 문구로 센다. 이름은 보관함 격자의 칸과 같은 열쇠다.
const cellTestId = (name: string) => `expression-pick-${name}`;

export function TeamEmojiRow({
  tab,
  query,
  onSelect,
}: {
  /** 이 줄이 서는 탭(이모지). 호스트가 준다 - 탭 분류의 정본은 코어 표 하나다. */
  tab: ExpressionTab;
  query: string;
  /** 고른 등록의 `:이름:` 과 그 등록. */
  onSelect: (token: string, item: Expression) => void;
}) {
  const {items, store, usage} = useExpressions();
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const [unavailable, setUnavailable] = useState(false);
  const locked = useRef(false);
  const found = useMemo(
    () => browseExpressions(items, tab, query, usage),
    [items, tab, query, usage],
  );
  if (!store || found.length === 0) return null;
  const choose = async (item: Expression) => {
    if (locked.current) return;
    locked.current = true;
    setUnavailable(false);
    const active = await resolveActiveExpression(store, item);
    if (!active) {
      locked.current = false;
      setUnavailable(true);
      return;
    }
    Keyboard.dismiss();
    onSelect(buildExpressionMessage(active).body, active);
  };
  return (
    <View testID="team-emoji-row">
      <FlatList
        horizontal
        data={found}
        keyExtractor={item => item.id}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel={formatMessage('expressions.picker.teamGroup')}
        contentContainerStyle={styles.row}
        renderItem={({item}) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expressionAltText(item)}
            accessibilityHint={formatMessage('expressions.sheet.hintInsert')}
            onPress={() => {
              void choose(item);
            }}
            style={[styles.cell, {width: TOUCH_TARGET}]}
            testID={cellTestId(item.name)}
          >
            <ExpressionImage expression={item} size="grid" />
          </Pressable>
        )}
      />
      {unavailable ? (
        <View style={styles.row}>
          <Text accessibilityRole="alert" style={styles.label}>
            {formatMessage('expressions.sheet.unavailable')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
