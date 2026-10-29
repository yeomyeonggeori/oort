import type {DividerSegment} from '@momo/core/features/timeline/divider';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {
  ds2Radius,
  font,
  line,
  radius,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {GlassSurface} from '../../design/glass';
import {useStyles} from '../../design/theme';
import {useKeyboardShown} from '../../lib/useKeyboardShown';

// =============================================================================
// 타임라인 점프 필 — 위는 안 읽음 문장, 아래는 44pt 유리 원 (#4789).
// 목적지·낭독 문구는 jumpPills.ts가 계속 정한다.
// =============================================================================

/** 위쪽 안 읽음 필은 기존 높이와 44pt 터치 여유를 유지한다. */
export const PILL_HEIGHT = 28;
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
  newCount = 0,
}: {
  direction: 'up' | 'down';
  segments: readonly DividerSegment[];
  /** 보이는 문장과 같은 낱말. 위 필만 「위쪽의」를 붙인다(`jumpPills.ts`). */
  accessibilityLabel: string;
  onPress: () => void;
  testID: string;
  /** 아래 최신 단추의 새 글 수. 낭독은 기존 전체 문장을 유지한다. */
  newCount?: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  if (direction === 'down') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({pressed}) => [styles.latest, pressed && styles.pressed]}
        testID={testID}>
        <GlassSurface radius={ds2Radius.pill} style={StyleSheet.absoluteFill} testID={`${testID}-glass`} />
        <Text style={styles.latestArrow} accessibilityElementsHidden importantForAccessibility="no">↓</Text>
        {newCount > 0 ? (
          <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`${testID}-badge`}>
            <Text style={styles.badgeText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>{newCount > 99 ? '99+' : newCount}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  }
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
        ↑
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
 *
 * ## 키보드가 올라와 있으면 위 자리는 비운다 (design-review 2594 R1 M-4)
 *
 * 대화 화면은 키보드가 올라오면 판 전체를 키보드 높이만큼 들어 올리고, 그 위를
 * `overflow: 'hidden'` 으로 자른다(`ConversationLayout`). 목록의 위쪽 띠는 그때
 * 화면 밖이다 — iPhone 17 에서 302pt. 목록 맨 위 8pt 에 붙은 필은 그 띠 안에 서서
 * 보이지도 눌리지도 않는데(Fabric 의 hitTest 는 잘린 곳을 거절한다), 스크린리더에는
 * 여전히 거기 있는 단추다. 보이지 않는데 닿는 컨트롤이다.
 *
 * 그래서 그동안 위 자리는 **그리지 않는다** — 그리지 않은 단추는 접근성 트리에도
 * 없다. 키보드를 내리면 다시 선다. 필을 보이는 띠로 옮기는 길도 있었지만, 판은
 * 네이티브가 키보드의 곡선으로 들어 올리고 JS 는 그 높이를 한 박자 늦게 안다 —
 * 옮긴 필은 판과 따로 움직인다. 아래 자리는 목록과 함께 컴포저 위에 서므로 잘리지
 * 않고, 그래서 구독하지도 않는다.
 *
 * 구독은 이 자리 **안에서** 한다. 목록이나 대화 화면에서 하면 키보드가 움직이는
 * 바로 그 순간 그쪽을 다시 그린다(`useKeyboardShown`).
 */
export function JumpPillDock({
  side,
  children,
}: {
  side: 'top' | 'bottom';
  children: React.ReactNode;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const keyboardUp = useKeyboardShown(side === 'top');
  if (keyboardUp) return null;
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
    latest: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      borderRadius: ds2Radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: color.elevationRest,
    },
    latestArrow: {fontSize: font.title, lineHeight: line.title, color: color.text},
    badge: {
      position: 'absolute',
      top: -space.xs,
      right: -space.sm,
      minWidth: line.heading,
      paddingHorizontal: space.xs,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      alignItems: 'center',
      backgroundColor: color.primary,
    },
    badgeText: {fontSize: font.caption, lineHeight: line.caption, fontWeight: '600', color: color.onPrimary, fontVariant: ['tabular-nums']},
    pressed: {backgroundColor: color.surfacePressed},
    arrow: {fontSize: font.label, lineHeight: line.meta, color: color.text},
    label: {fontSize: font.meta, lineHeight: line.meta, color: color.text},
    figure: {fontVariant: ['tabular-nums']},
  });
