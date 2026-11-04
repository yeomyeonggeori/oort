import {CONNECTION_KEYS} from '@momo/core/features/connection/copyKeys';
import React from 'react';
import {Image, Pressable, StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {CARD_ICONS} from '../../design/icons/cardIcons';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {ROW_FACE} from './rowFace';

// =============================================================================
// 「N개 모두 다시 보내기」 — 보내지 못한 글이 둘 이상일 때 첫 실패 줄 위에 한 번만 서는 단추 (#5222, #5201 S-D).
//
// 줄마다 있는 새로고침 아이콘(#5210, `SendFailureActions`)을 줄 수만큼 누르는 대신 한 번에 보낸다. 같은 새로고침 아이콘을 앞에 두어
// 두 단추가 한 가족임을 보인다(새로 그리지 않고 있던 `CARD_ICONS.refresh`). 보내는 규칙(보낸 순서·같은 멱등 키·한 번씩·닿지 못하면 멈춤)은
// `useTimeline.resendAll` 이 지고, 이 부품은 그리기만 한다.
//
// 누르는 면은 44pt(`TOUCH_TARGET`)를 상자가 진다. 글자는 사전(`connection.send.resendAll`)이다: 한국어는 「N개 모두 다시 보내기」,
// 영어는 복수형 틀이다.
// =============================================================================

export function ResendAllBar({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const label = formatMessage(CONNECTION_KEYS.resendAll, {count});
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({pressed}) => [styles.bar, pressed && styles.pressed]}
        testID="resend-all">
        <Image source={CARD_ICONS.refresh} style={styles.glyph} />
        <Sentence style={styles.label}>{label}</Sentence>
      </Pressable>
    </View>
  );
}

const GLYPH = 16;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 행의 안쪽 가장자리에 맞춘다(행 바깥 여백 + 행 안쪽 여백) — 아래 실패 줄의 글과 같은 왼쪽 선이다.
    wrap: {
      alignItems: 'flex-start',
      marginHorizontal: ROW_FACE.outer + ROW_FACE.inner,
      marginTop: space.sm,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.accentSurface,
    },
    pressed: {opacity: 0.6},
    glyph: {width: GLYPH, height: GLYPH, tintColor: color.accentText},
    label: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
  });
