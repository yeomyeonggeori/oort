import {expressionAltText} from '@momo/core/features/expressions/message';
import type {Expression} from '@momo/core/features/expressions/types';
import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {useStyles} from '../../design/theme';
import {WORD} from '../../lib/techWords';
import {font, line, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {ExpressionImage} from './ExpressionImage';
import {EXPRESSION_POINTS} from './expressionBox';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 입력창 위의 이모티콘 미리 보기 (#5452, owner 2026-11-07 「안내 글 없이 카카오톡처럼」).
//
// 이모티콘·GIF 를 고르면 입력창 위에 **그림과 작은 ✕만** 선다. 설명 글이나 힌트 글은 화면에 두지 않고 낭독 이름만 둔다(✕ 의 「…미리 보기 지우기」). 창이 열려 있든 키보드가 올라와
// 있든 그대로이고, 다른 것을 누르면 바뀌고, 보내면 사라진다. 그림은 대화 줄의 큰 이모티콘과 **같은 부품**(`ExpressionImage`, #5451 이 칸을 못 박았다)이라 받는 동안에도 칸이 안 흔들린다.
// 보이는 글자는 하나뿐이다: 고른 뒤 그 표현이 숨겨지거나 지워져 보낼 수 없을 때의 한 문장(상태 설명이라 남긴다).
// =============================================================================

/** 미리 보기 그림의 한 변(pt). 대화 줄의 큰 이모티콘(160)을 같은 그림 파일 그대로 줄여 그린다 - 입력창 위에서 대화를 덜 밀어 올린다. */
export const PREVIEW_POINTS = 112;
const SCALE = PREVIEW_POINTS / (EXPRESSION_POINTS.large ?? 160);

export function ComposerExpressionPreview({
  expression,
  unavailable,
  onClear,
  marginHorizontal,
}: {
  expression: Expression;
  /** 고른 뒤 쓸 수 없게 되었다: 한 문장이 선다. */
  unavailable: boolean;
  onClear: () => void;
  /** 알약이 화면 가장자리에서 뜬 거리. 그림이 알약의 왼쪽 가장자리와 맞는다. */
  marginHorizontal: number;
}) {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const name = expressionAltText(expression);
  return (
    <View style={[styles.row, {marginHorizontal}]} testID="composer-expression-preview">
      <View style={styles.frame} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={styles.scaled}>
          <ExpressionImage expression={expression} size="large" visible />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={formatMessage('expressions.preview.cancel', {name})}
        hitSlop={space.sm}
        onPress={onClear}
        style={({pressed}) => [styles.clear, pressed && styles.pressed]}
        testID="composer-expression-preview-clear">
        <Image source={CONV_ICONS.cross} style={styles.glyph} importantForAccessibility="no" />
      </Pressable>
      {unavailable ? (
        <Text accessibilityRole="alert" style={styles.alert} testID="composer-expression-unavailable">
          {formatMessage('expressions.sheet.unavailable')}
        </Text>
      ) : null}
    </View>
  );
}

const CLEAR_SIZE = 28;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: WORD.row,
      alignItems: 'flex-start',
      paddingBottom: space.sm,
      gap: space.xs,
    },
    // 칸은 줄인 크기(112)로 서고, 안쪽 160 칸을 왼쪽 위 기준으로 줄여 그린다 - 큰 그림 파일이 그대로 쓰여 흐려지지 않는다.
    frame: {width: PREVIEW_POINTS, height: PREVIEW_POINTS, overflow: WORD.hidden},
    scaled: {
      width: EXPRESSION_POINTS.large ?? 160,
      height: EXPRESSION_POINTS.large ?? 160,
      transform: [{scale: SCALE}],
      transformOrigin: [0, 0, 0],
    },
    clear: {
      width: CLEAR_SIZE,
      height: CLEAR_SIZE,
      borderRadius: CLEAR_SIZE / 2,
      alignItems: WORD.center,
      justifyContent: WORD.center,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      // 큰 글자에서도 눌림 면이 44 아래로 내려가지 않게 바깥쪽 여백으로 채운다.
      marginTop: Math.max(0, (TOUCH_TARGET - CLEAR_SIZE) / 2 - space.xs),
    },
    pressed: {opacity: 0.6},
    glyph: {
      width: CONV_ICON_SIZE.cross,
      height: CONV_ICON_SIZE.cross,
      tintColor: color.icon,
    },
    alert: {flex: 1, fontSize: font.meta, lineHeight: line.meta, color: color.warn, alignSelf: WORD.center},
  });
