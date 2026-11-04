import type {Directory} from '@momo/core/features/workspace/directory';
import {replyHomeCopy} from '@momo/core/features/timeline/replyHomeCopy';
import {replyHomeLineOf} from '@momo/core/features/timeline/threadHome';
import type {Message} from '@momo/core/lib/api';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {HEAD_MAX_SCALE} from '../../design/atoms';
import {PRESS_VISUAL_DELAY_MS} from '../../design/motion';
import {font, line, slopTo, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useExpressionItems} from '../expressions/ExpressionProvider';

// =============================================================================
// 「↳ ○○님 스레드에 답글」 + 원문 한 줄 — 대화에 선 답글이 **어느 스레드의 것인지** 말하는 줄 (이슈 #4888).
//
// 이 줄이 서는 답글은 둘이다: 「대화에도 보내기」로 보낸 답글, 그리고 서버가 이 값을 아직 모르는 옛 서버의 모든 답글(오늘 폰 동작 유지,
// 코어 `phoneMainFlowMessages`). 그 밖의 답글은 대화에 서지 않는다 — 요약 줄(#4878)만 남는다. 웹의 같은 줄과 **같은 코어 문장**이다
// (`replyHomeCopy`) — 웹은 한 줄, 폰은 좁은 폭이라 두 줄(첫 줄 ↳ 머리 / 둘째 줄 원문, 각각 한 줄 말줄임)이다.
//
// ## 눌리는 것은 열 스레드가 있을 때만
//
// 루트를 불러왔고 열 곳(`onOpen`)이 있으면 그 스레드로 가는 단추이고, 루트가 불러온 범위 위에 있으면 문장이다 — 없는 방으로 가는 문은
// 짓지 않는다. 답글 달기가 아니라 이미 속한 스레드로 **이동**이라 한 단계 규칙을 건드리지 않는다.
//
// 화살표는 모양이라 낭독에서 뺀다(「아래로 꺾인 화살표」로 읽힌다). 한 접근성 원소가 「머리, 원문」을 한 번에 읽는다.
// =============================================================================

const SLOP = slopTo(line.meta);
const HIT_SLOP = {top: SLOP, bottom: SLOP, left: SLOP, right: SLOP} as const;

export function ReplyHomeLine({
  rootId,
  root,
  directory,
  myMemberId,
  onOpen,
}: {
  /** 이 답글이 달린 스레드의 루트 id — 루트를 못 불러왔어도 안다. */
  rootId: string;
  /** 불러온 루트. 아직 못 불러왔으면 `null`(모르면 모른다고 말한다). */
  root: Message | null;
  directory: Directory;
  myMemberId: string | undefined;
  /** 그 스레드를 연다. 열 곳이 없으면 생략 — 줄은 글이 된다. */
  onOpen?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const expressions = useExpressionItems();
  const copy = replyHomeCopy(replyHomeLineOf(rootId, root ?? undefined, expressions), {
    directory,
    myMemberId,
    formatMessage,
  });
  const body = (
    <View style={styles.lines}>
      <Text
        style={styles.header}
        numberOfLines={1}
        maxFontSizeMultiplier={HEAD_MAX_SCALE}
        testID="reply-marker-header">
        {'↳ '}
        {copy.header}
      </Text>
      {copy.excerpt !== null ? (
        <Text
          style={styles.excerpt}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={HEAD_MAX_SCALE}
          testID="reply-marker-excerpt">
          {copy.excerpt}
        </Text>
      ) : null}
    </View>
  );
  if (onOpen === undefined) {
    return (
      <View accessible accessibilityLabel={copy.spoken} testID="reply-marker">
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.spoken}
      accessibilityHint={copy.openLabel}
      hitSlop={HIT_SLOP}
      onPress={onOpen}
      unstable_pressDelay={PRESS_VISUAL_DELAY_MS}
      style={({pressed}) => [styles.link, pressed && styles.pressed]}
      testID="reply-marker">
      {body}
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    lines: {},
    header: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
      // 가장 짧은 판(「↳ 스레드에 답글」)도 슬롭과 더해 가로 44 가 되도록 바닥을 깐다(M-14).
      minWidth: TOUCH_TARGET - 2 * SLOP,
    },
    // 원문 발췌는 이 답글이 **어느 글의 스레드인지** 알려 주는 내용이라 뜻을 나르는 글자다 — `textFaint`(밝음 3.76:1·어두움 3.89:1)는 본문 AA 를
    // 못 넘는다. 웹 짝(`ReplyHomeLine.tsx`)도 두 줄 모두 `ink-muted` 다(#5294, 화면 검수 5a H1).
    excerpt: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    link: {alignSelf: 'flex-start', maxWidth: '100%'},
    pressed: {opacity: 0.6},
  });
