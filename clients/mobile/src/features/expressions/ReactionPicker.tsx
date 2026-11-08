import {buildExpressionMessage} from '@momo/core/features/expressions/message';
import type {Expression} from '@momo/core/features/expressions/types';
import type {Channel} from '@momo/core/lib/api';
import React, {useCallback, useRef, useState} from 'react';
import {Keyboard, StyleSheet, Text, TextInput, View} from 'react-native';
import {useKeyboardAppearance, useStyles} from '../../design/theme';
import {font, line, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {EmojiPickerHeader} from '../emoji/EmojiPicker';
import {ExpressionKeyboardPanel} from './ExpressionKeyboardPanel';
import {useExpressions} from './ExpressionProvider';
import {resolveActiveExpression} from './TeamExpressionPicker';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 반응 고르개 (#5504, owner 2026-11-07: GIF·이모티콘도 반응으로) - 메시지 액션 시트의 「+」가 여는 큰 단.
//
// 웹 고르개와 같은 세 탭 - 이모티콘 · 이모지 · GIF - 이고, 탭·격자·세트 띠는 입력창 이모티콘 창(`ExpressionKeyboardPanel`, #5452)의 부품 그대로다(두 벌이 아니다).
// 달라지는 것은 **고른 뒤**뿐이다: 입력창 창은 미리 보기에 올리거나 글에 넣지만, 여기서는 **고르면 그 표현이 반응으로 달린다**. 큰 그림 메시지를 보내지 않는다 -
// 와이어는 그대로 `:이름:` 반응이다(ADR-0218 D1: 한 등록이 반응(작게)·글 사이·큰 그림에 모두 쓰인다). 표준 그림 문자는 글자 그대로 반응이 된다.
// 처음은 「이모지」 탭이다(예전 반응 고르개처럼, 웹 반응 고르개도 같다). 이 고르개가 탭을 옮겨도 입력창 창이 기억한 탭은 바뀌지 않는다.
// 시트의 모양과 높이는 예전 반응 시트 그대로다: 같은 머리(`EmojiPickerHeader`)·같은 큰 단·검색 칸 하나(세 탭이 모두 이 글자로 거른다).
//
// 고르는 사이 그 등록이 신고·삭제될 수 있어서, 등록(이모티콘·GIF)은 고른 순간 다시 읽어 지금도 쓸 수 있는지 확인한 뒤에야 반응으로 넘긴다
// (`resolveActiveExpression`, 팀 이모지 줄이 쓰는 길과 같다). 쓸 수 없으면 한 문장으로 말하고 시트는 그대로 둔다.
// =============================================================================

export function ReactionPicker({
  onReact,
  onClose,
  onOpenConversation,
}: {
  /** 고른 반응: 표준 그림 문자 그대로, 또는 팀 표현의 `:이름:`. 호스트가 시트를 내린 뒤 반응을 쓴다. */
  onReact: (reaction: string) => void;
  /** 머리의 X: 빠른 행동 목록으로 돌아간다. */
  onClose: () => void;
  onOpenConversation?: (channel: Channel) => void;
}): React.JSX.Element {
  const {store} = useExpressions();
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const keyboardAppearance = useKeyboardAppearance();
  const [query, setQuery] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const locked = useRef(false);

  const pickBig = useCallback(
    async (item: Expression) => {
      if (!store || locked.current) return;
      locked.current = true;
      setUnavailable(false);
      const active = await resolveActiveExpression(store, item);
      if (!active) {
        locked.current = false;
        setUnavailable(true);
        return;
      }
      // 반응 하나를 달고 시트가 내려간다: 다시 눌러도 두 번 달리지 않게 잠근 채 둔다.
      onReact(buildExpressionMessage(active).body);
    },
    [store, onReact],
  );

  return (
    <>
      <EmojiPickerHeader onClose={onClose} />
      <View style={styles.searchRow}>
        <TextInput
          accessibilityLabel={formatMessage('expressions.sheet.searchEmoji')}
          placeholder={formatMessage('expressions.sheet.placeholderEmoji')}
          placeholderTextColor={styles.placeholder.color}
          value={query}
          onChangeText={setQuery}
          keyboardAppearance={keyboardAppearance}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={Keyboard.dismiss}
          style={styles.search}
          testID="emoji-search"
        />
      </View>
      {unavailable ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="reaction-picker-unavailable">
          {formatMessage('expressions.sheet.unavailable')}
        </Text>
      ) : null}
      <View style={styles.panel}>
        <ExpressionKeyboardPanel
          previewId={null}
          initialTab="emoji"
          rememberTab={false}
          compact={false}
          inSheet
          query={query}
          onClearQuery={() => setQuery('')}
          onPickBig={item => {
            void pickBig(item);
          }}
          onInsertText={onReact}
          onInsertToken={onReact}
          onOpenConversation={onOpenConversation}
        />
      </View>
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    placeholder: {color: color.textMuted},
    searchRow: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
    search: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderWidth: 1,
      borderColor: color.textFaint,
      borderRadius: radius.md,
      fontSize: font.body,
      color: color.text,
    },
    alert: {
      paddingHorizontal: SAFE_GUTTER,
      paddingBottom: space.sm,
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    panel: {flex: 1},
  });
