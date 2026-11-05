import React, {useEffect, useRef} from 'react';
import {Animated, Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {BAR_CONTROL_MAX_SCALE} from '../design/atoms';
import {MENU_ICONS, MENU_ICON_SIZE, type MenuIconName} from '../design/icons';
import {usePalette, useStyles} from '../design/theme';
import {ds2Radius, type Palette, font} from '../design/tokens';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import {PLUS_LABEL, SHELL} from './ShellChrome';

// =============================================================================
// + 메뉴 — 탭바 위에 뜨는 작은 팝오버 (DS2-2b #2750).
//
// owner: 「우린 누르면 바로 뭔가 뜨는데, 버즈는 … 바로 +로 사용성도 챙기는 느낌」.
// 이전 FAB 은 누르면 전면 시트가 곧바로 열렸다. 이제 + 는 가벼운 메뉴를 열고, 무거운
// 일(사람 고르기, 채널 이름 짓기)만 그다음 시트로 간다.
//
// ## 사양 표 (Buzz IMG_4161, 393pt 환산)
//
//   | 항목        | Buzz 실측                         | 이 파일                              |
//   |-------------|-----------------------------------|--------------------------------------|
//   | 가로        | 좌우 ≈20 여백(폭 ≈354)            | 좌우 20                              |
//   | 탭바와 틈   | ≈8                                | 8                                    |
//   | 그릇        | 검정 · 반경 ≈17 · 안 여백 ≈8      | surface · 반경 20(card) · 8          |
//   | 행          | 높이 ≈60 · 반경 ≈13 · 틈 ≈8       | 최소 54 · 반경 14(row) · 틈 8        |
//   | 행 채움     | 그릇보다 한 단 밝은 회색          | text(잉크) 8% — 눌림 16%             |
//   | 아이콘·글자 | ≈21 · 17 semibold · 흰색          | 22 · 17(headline) 600 · text         |
//
// ## 색은 고른 테마를 따른다 (#5329)
//
// 처음에는 Buzz 의 검은 그릇을 시안 A 의 잉크 반전(`.a-fab` 의 primary/onPrimary)으로 옮겼다. 라이트에서는
// Buzz 처럼 어두운 카드였지만, 다크에서는 primary 가 밝은 잉크(`#F1F1F3`)라 어두운 화면 위에 흰 판이 떴다
// (owner 2026-11-05 피드백: 다크에서 + 메뉴가 너무 밝다, 테마가 안 입혀진 듯하다, 레퍼런스를 그대로 옮긴 것 같다). primary/onPrimary 는
// **주 행동**(FAB·보내기·주 버튼, `docs/design-system/README.md` §2.2)의 역할이지 떠 있는 판의 역할이 아니다 —
// 떠 있는 판은 `surface` 다. 그래서 그릇은 `surface`, 행 타일은 `text`(잉크) 8%(탭바 선택 캡슐 `ShellChrome.capsule` 과
// 같은 8%), 글자·아이콘은 `text`, 그림자는 `elevationFloat` 다. 라이트에서는 밝은 카드, 다크에서는 어두운 카드이고
// Buzz 에서 잰 치수(폭·반경·행 간격)는 그대로다. 옆의 + 단추(FAB)는 주 행동이라 계속 primary 다 —
// 다크에서 밝은 원이 어두운 메뉴 옆에 서는 것은 의도다.
//
// 행 높이를 60 에서 54 로 줄인 것은 행이 Buzz 의 셋보다 많기 때문이다(최대 넷: 새 DM · 새 채널 · AI · 작업).
// 54 는 터치 44 를 넉넉히 넘는다.
//
// ## 닫힘
//
// 바깥(투명 스크림)을 누르면, 행을 고르면, VoiceOver escape(두 손가락 Z)로 닫힌다.
// 스크림은 보조기술에서 숨는다. `accessibilityViewIsModal` 은 **레이어 뿌리**에
// 둔다 — iOS 는 그 뷰의 형제를 무시하므로, 뿌리에 있어야 형제인 탭바·+·목록이
// 가려지고 VoiceOver 가 메뉴 안에 머문다(design-review M1). escape 로 나간다.
// =============================================================================

export interface PlusMenuItem {
  key: 'dm' | 'channel' | 'ai' | 'work';
  icon: MenuIconName;
  label: string;
  hint: string;
  onPress: () => void;
}

/** 사양 수치. 시험이 같은 이름을 읽는다. */
export const PLUS_MENU = {
  inset: 20,
  gap: 8,
  padding: 8,
  rowGap: 8,
  rowHeight: 54,
  iconGap: 14,
  rowPadding: 16,
} as const;

const APPEAR_MS = 140;

export function PlusMenu({
  items,
  onClose,
}: {
  items: readonly PlusMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const reduceMotion = useReduceMotionRef();
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion.current) {
      appear.setValue(1);
      return;
    }
    Animated.timing(appear, {
      toValue: 1,
      duration: APPEAR_MS,
      useNativeDriver: true,
    }).start();
  }, [appear, reduceMotion]);

  return (
    <View
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
      style={StyleSheet.absoluteFill}
      testID="plus-menu-layer">
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID="plus-menu-scrim"
      />
      <Animated.View
        accessibilityLabel={PLUS_LABEL}
        style={[
          styles.menu,
          {
            opacity: appear,
            transform: [
              {
                translateY: appear.interpolate({
                  inputRange: [0, 1],
                  outputRange: [8, 0],
                }),
              },
            ],
          },
        ]}
        testID="plus-menu">
        {items.map(item => (
          <Pressable
            key={item.key}
            accessibilityRole="menuitem"
            accessibilityLabel={item.label}
            accessibilityHint={item.hint}
            onPress={() => {
              onClose();
              item.onPress();
            }}
            style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
            testID={`plus-menu-${item.key}`}>
            <Image
              source={MENU_ICONS[item.icon]}
              style={{
                width: MENU_ICON_SIZE,
                height: MENU_ICON_SIZE,
                tintColor: palette.text,
              }}
              testID={`plus-menu-${item.key}-icon`}
            />
            <Text
              style={styles.label}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              numberOfLines={2}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    menu: {
      position: 'absolute',
      left: PLUS_MENU.inset,
      right: PLUS_MENU.inset,
      bottom: SHELL.bottom + SHELL.barHeight + PLUS_MENU.gap,
      padding: PLUS_MENU.padding,
      gap: PLUS_MENU.rowGap,
      borderRadius: ds2Radius.card,
      // 떠 있는 판은 `surface` 다(위 「색은 고른 테마를 따른다」) — 주 행동 색(`primary`)이 아니다.
      backgroundColor: color.surface,
      boxShadow: color.elevationFloat,
    },
    row: {
      minHeight: PLUS_MENU.rowHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: PLUS_MENU.iconGap,
      paddingHorizontal: PLUS_MENU.rowPadding,
      paddingVertical: 8,
      borderRadius: ds2Radius.row,
      // text(잉크) 8%(0x14) — 그릇보다 한 단 떨어진 행 타일. 라이트에서는 살짝 어둡게, 다크에서는 살짝 밝게.
      backgroundColor: `${color.text}14`,
    },
    // 눌림은 한 단 더(16%, 0x29).
    rowPressed: {backgroundColor: `${color.text}29`},
    label: {
      flex: 1,
      fontSize: font.heading,
      fontWeight: '600',
      color: color.text,
    },
  });
