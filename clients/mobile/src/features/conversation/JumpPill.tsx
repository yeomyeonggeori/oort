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
import {useKeyboardShown} from '../../lib/useKeyboardShown';

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
//   h-control-sm (28) → PILL_HEIGHT     터치 44 → slopTo (웹과 다르다, 아래)
// =============================================================================

/**
 * 필의 보이는 높이 = 웹 `--spacing-control-sm`(28px). 짝은
 * `__tests__/designSystem.test.ts` 가 웹 `tokens.css` 를 읽어 대조한다.
 *
 * ## 터치 44 는 웹과 다른 길로 채운다 — 폰의 결정이다 (design-review 2594 R1 M-5)
 *
 * 웹은 터치 기기에서 필 **자체를** 44 로 키운다(`tokens.css` 의
 * `@media (hover: none) { [data-unread-pill] { min-block-size: var(--tap-target) } }`
 * 와 폭 600 미만 규칙). 그래서 같은 폰에서 oort 웹은 44 짜리 필을, 이 앱은 28 짜리
 * 필을 그린다. 첫 판의 주석은 「웹이 같은 거래를 한다」고 적었고, 그것은 사실이
 * 아니었다.
 *
 * 폰이 28 을 지키는 이유는 **필이 타임라인 위에 떠 있기 때문이다.** 떠 있는 것은
 * 자기 높이만큼 아래 줄을 덮고, 44 면 그 덮는 띠가 한 줄 반이 된다. 웹은 CSS 에
 * 누르는 영역만 넓히는 수단이 없어 상자를 키울 수밖에 없지만, RN 에는 `hitSlop` 이
 * 있다. 그래서 보이는 상자는 웹의 컨트롤 높이 그대로 두고, 손가락이 받는 44 는
 * `slopTo` 가 채운다. Fabric 은 자식의 `hitSlop` 을 부모의 `overflowInset` 에
 * 넣으므로(`YogaLayoutableShadowNode.cpp`, `RCTViewComponentView.mm`) 필을 띄우는
 * 띠 밖으로 나간 여유 영역도 실제로 눌린다 — design-review R1 이 소스로 확인했다.
 */
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
    pressed: {backgroundColor: color.surfacePressed},
    arrow: {fontSize: font.label, lineHeight: line.meta, color: color.text},
    label: {fontSize: font.meta, lineHeight: line.meta, color: color.text},
    figure: {fontVariant: ['tabular-nums']},
  });
