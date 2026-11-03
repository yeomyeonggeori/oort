import React from 'react';
import {Animated, Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {HEAD_MAX_SCALE} from '../../design/atoms';
import {SHEET_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, radius, slopTo, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';

// =============================================================================
// 「대화에도 보내기」 체크 (이슈 #4888, ADR-0148 증보 2026-10-31).
//
// 스레드 입력칸 둘(스레드 화면, 밀어서 답글)이 한 부품을 쓴다. 규칙은 웹과 같다: **기본은 꺼짐이고 마지막 선택을 기억하지 않는다**(Slack
// 기본) — 상태는 이 부품이 아니라 컴포저가 들고(보내면 꺼지고 답글 대상이 바뀌면 꺼진다), 이 부품은 그리고 누르게만 한다.
//
// 모양: 입력 줄 바로 위, 답글 머리말과 같은 글자 열(`textLeft`)에 서는 한 줄. 네모 칸 + 글. 눌림 영역은 44pt가 되도록 슬롭으로 채운다(줄 자체는
// 얇게 둬 알약이 키보드 위에서 더 자라지 않게 한다 — 같은 저장소의 메타 줄 눌림과 같은 산수, M-14). 한 접근성 원소(`checkbox` 역할, 켜짐
// 상태가 따라온다) — 이름은 보이는 글이다. 눌리는 면은 칸 + 글 전체다(가로는 글의 폭만큼, 따로 늘리지 않는다).
// =============================================================================

const CHECK_SIZE = 18;
/** 줄의 높이는 칸(18)이 정한다(글의 줄 높이는 그보다 낮다). 세로 슬롭은 그 높이를 44 로 채운다. */
export const ALSO_IN_CHANNEL_ROW_HEIGHT = Math.max(CHECK_SIZE, line.meta);
const SLOP_Y = slopTo(ALSO_IN_CHANNEL_ROW_HEIGHT);
const SLOP_X = 8;
const SLOP = {top: SLOP_Y, bottom: SLOP_Y, left: SLOP_X, right: SLOP_X} as const;

export function AlsoInChannelCheck({
  checked,
  onChange,
  textLeft,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 글자 열의 왼쪽(pt) — 답글 머리말·입력창 글자와 같은 선. 스프링 중에는 보간값이 온다. */
  textLeft: number | Animated.AnimatedInterpolation<number>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const label = formatMessage('reply.alsoInChannel.label');
  return (
    <Animated.View style={[styles.row, {paddingLeft: textLeft}]} testID="also-in-channel-row">
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityState={{checked}}
        hitSlop={SLOP}
        onPress={() => onChange(!checked)}
        style={styles.press}
        testID="also-in-channel-check">
        <View style={[styles.box, checked && styles.boxOn]} testID="also-in-channel-box">
          {checked ? (
            <Image
              source={SHEET_ICONS.check}
              style={[styles.tick, {tintColor: palette.bg}]}
              importantForAccessibility="no"
            />
          ) : null}
        </View>
        <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={HEAD_MAX_SCALE}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {alignItems: 'flex-start', paddingTop: space.xs},
    press: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    box: {
      width: CHECK_SIZE,
      height: CHECK_SIZE,
      borderRadius: radius.sm,
      borderWidth: 1.5,
      borderColor: color.textMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxOn: {backgroundColor: color.text, borderColor: color.text},
    tick: {width: 12, height: 12},
    label: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
  });
