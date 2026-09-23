import type {DividerSegment} from '@momo/core/features/timeline/divider';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  font,
  line,
  radius,
  slopTo,
  space,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// 타임라인 점프 필 (#1892 — 웹 `UnreadPill` 의 폰판).
//
// 위 「안읽음으로」와 아래 「최신으로」는 목적지만 다르고 옷은 같다. 두 벌을 그리면
// 한쪽만 손대는 다음 티켓이 얼굴을 가른다 — 웹과 같은 이유로 `direction` 하나로
// 같은 버튼을 쓴다.
//
// 옷은 웹 `UNREAD_PILL_CLASS` 를 폰 토큰으로 옮긴 것이다:
//
//   bg-surface-raised → surface         border-line-strong → textFaint (3:1)
//   rounded-sm → radius.sm              px-3 → space.md · gap-2 → space.sm
//   text-meta text-ink → font.meta · text   shadow-lg → 팔레트 그림자
//   h-control-sm (28) + tap-target (44) → PILL_HEIGHT + slopTo
// =============================================================================

/**
 * 필의 보이는 높이 = 웹 `--spacing-control-sm`(28px).
 *
 * 손가락이 받는 44 는 높이를 키워서가 아니라 `slopTo` 로 채운다. 떠 있는 필이
 * 44pt 로 두꺼워지면 그만큼 타임라인의 줄을 덮는다 — 웹이 `tap-target` 으로 같은
 * 거래를 한다.
 */
const PILL_HEIGHT = 28;
const PILL_HIT_SLOP = {
  top: slopTo(PILL_HEIGHT),
  bottom: slopTo(PILL_HEIGHT),
  left: 0,
  right: 0,
};

export function JumpPill({
  direction,
  segments,
  accessibilityLabel,
  onPress,
  testID,
}: {
  direction: 'up' | 'down';
  segments: readonly DividerSegment[];
  /** 보이는 문장과 같은 낱말. 위 필만 「위쪽의」를 붙인다(`jumpPills.ts`). */
  accessibilityLabel: string;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={PILL_HIT_SLOP}
      style={({pressed}) => [styles.pill, pressed && styles.pressed]}
      testID={testID}>
      {/* 방향은 화살표가 진다. 낭독에는 이미 문장이 있으므로 글리프는 숨긴다. */}
      <Text
        style={styles.arrow}
        accessibilityElementsHidden
        importantForAccessibility="no">
        {direction === 'up' ? '↑' : '↓'}
      </Text>
      {/* 라벨은 한 조각. 쪼개서 flex 자식으로 두면 gap 이 낱말 사이에 끼어
          「새 메시지  1  개」가 된다(웹 같은 자리의 주석). 숫자만 자릿폭을 고정한다. */}
      <Text style={styles.label}>
        {segments.map((segment, index) =>
          segment.kind === 'figure' ? (
            <Text key={index} style={styles.figure}>
              {segment.text}
            </Text>
          ) : (
            segment.text
          ),
        )}
      </Text>
    </Pressable>
  );
}

/**
 * 타임라인 위/아래에 띄우는 자리. 필만 누름을 받고, 그 옆의 빈 폭은 아래 행으로
 * 통과시킨다 — 안 그러면 이 띠가 덮은 폭만큼 메시지가 눌리지 않는 줄이 된다.
 */
export function JumpPillDock({
  side,
  children,
}: {
  side: 'top' | 'bottom';
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, side === 'top' ? styles.dockTop : styles.dockBottom]}>
      {children}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    dock: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
    dockTop: {top: space.sm},
    dockBottom: {bottom: space.sm},
    pill: {
      minHeight: PILL_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      // 떠 있는 것은 목록 위의 한 층이다. 그림자가 없으면 필이 행의 일부로 읽힌다.
      shadowColor: color.shadow,
      shadowOffset: {width: 0, height: 4},
      shadowOpacity: 0.18,
      shadowRadius: 10,
    },
    pressed: {backgroundColor: color.surfacePressed},
    arrow: {fontSize: font.label, lineHeight: line.meta, color: color.text},
    label: {fontSize: font.meta, lineHeight: line.meta, color: color.text},
    figure: {fontVariant: ['tabular-nums']},
  });
