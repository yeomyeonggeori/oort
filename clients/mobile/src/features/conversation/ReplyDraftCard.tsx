import type {Directory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {HEAD_MAX_SCALE} from '../../design/atoms';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {CONV} from './convDesign';
import {useReplyCopy} from './replyCopy';
import type {ReplyTarget} from './replyTarget';

// =============================================================================
// 입력칸 머리의 답글 머리말 (#4869) — 입력칸과 **한 장의 둥근 카드**를 이룬다.
//
// 이 부품은 컴포저 알약 **안**, 입력 줄 바로 위에 선다(알약의 반경 27 이 카드의 모서리다). 인용의 `QuoteDraftBar` 가
// 알약 **밖** 위에 서는 것과 다른 자리다: 인용은 「이 글을 가리킨다」는 참조이고, 답글은 이 입력칸이 **어디로 가는가**
// 를 정하므로 입력과 한 몸으로 읽혀야 한다(카카오톡의 답장 머리말과 같은 구조).
//
//   첫 줄(굵게)   「○○님에게 답글」 — 내 글이면 「내 글에 답글」
//   둘째 줄(흐리게, 한 줄 말줄임)  원문 — 글이 없는 메시지는 「사진」·「파일」·「이모티콘」 같은 대체 글
//   오른쪽 ✕      답글 취소 — 대상만 떼고 **쓴 글은 남는다**(글은 이 부품이 아니라 컴포저가 들고 있다)
//
// 글자 칸의 왼쪽은 입력창의 글자와 같은 선에 서고(원 + 간격 + 글 안쪽 여백), ✕ 는 보내기 원 바로 위 같은 줄에 선다 —
// 알약 안의 세 열(왼쪽 원 · 글 · 오른쪽 원)이 머리말에서도 이어진다.
//
// 큰 글씨: 두 줄 다 한 줄 말줄임이고 배율은 `HEAD_MAX_SCALE`(1.3)에서 멈춘다 — 입력창 위에 자판과 함께 서는 머리라서
// 자라도 입력칸이 화면을 먹지 않게 하는 같은 상한이다. 문장은 한 번에 읽힌다(두 줄이 한 접근성 원소).
// =============================================================================

export function ReplyDraftCard({
  target,
  directory,
  onCancel,
}: {
  target: ReplyTarget;
  directory: Directory;
  /** ✕. 대상만 뗀다 — 입력칸의 글은 건드리지 않는다. */
  onCancel: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const copy = useReplyCopy(directory);
  const header = copy.header(target);
  const excerpt = copy.excerpt(target);
  return (
    <View style={styles.card} testID="reply-draft-card">
      <View
        accessible
        accessibilityLabel={`${header}, ${excerpt}`}
        style={styles.text}>
        <Text
          style={styles.header}
          numberOfLines={1}
          maxFontSizeMultiplier={HEAD_MAX_SCALE}
          testID="reply-draft-header">
          {header}
        </Text>
        <Text
          style={styles.excerpt}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={HEAD_MAX_SCALE}
          testID="reply-draft-excerpt">
          {excerpt}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.cancel()}
        onPress={onCancel}
        style={({pressed}) => [styles.cancel, pressed && styles.pressed]}
        testID="reply-draft-cancel">
        <Image
          source={CONV_ICONS.cross}
          style={[styles.cross, {tintColor: palette.textMuted}]}
        />
      </Pressable>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: space.xs,
      // 입력창의 글자와 같은 선: 원(36) + 원 ↔ 알약 가장자리(9) + 원 ↔ 글 시작(9).
      paddingLeft: CONV.composerGap + CONV.composerCircle + CONV.composerTextInset,
      // ✕ 의 눌림 영역(44)이 보내기 원(36) 바로 위에 가운데를 맞춘다: 원의 가운데는 가장자리에서 9 + 18 = 27.
      paddingRight: CONV.composerGap + CONV.composerCircle / 2 - TOUCH_TARGET / 2,
    },
    text: {flex: 1, minWidth: 0},
    header: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.text,
    },
    excerpt: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    cancel: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    pressed: {backgroundColor: color.surfacePressed},
    cross: {
      width: CONV_ICON_SIZE.cross,
      height: CONV_ICON_SIZE.cross,
    },
  });
