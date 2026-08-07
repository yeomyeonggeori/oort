import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {
  THEME_CHOICES,
  themeChoiceLabel,
  useStyles,
  useTheme,
  type ThemeChoice,
} from './theme';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from './tokens';

// =============================================================================
// 「테마」 — 폰에서 스킴을 고르는 유일한 자리 (U2).
//
// ## 왜 사이드바 발치인가
//
// 폰에는 설정 화면이 없다(ADR-0137 D5 가 설정을 데스크탑에 둔다). 그래서 이
// 컨트롤은 이 앱이 **이미 갖고 있는 설정 비슷한 한 자리** — 계정 줄이 서 있는
// 사이드바 발치 — 로 간다. 세 값짜리 컨트롤 하나를 위해 화면을 새로 세우는 것은
// 그 결정을 뒤집는 일이고, 그것은 ADR 이 할 말이지 이 배치가 할 말이 아니다.
//
// ## 세 값이고 두 값이 아니다
//
// 토글(라이트↔다크)로 만들면 「시스템을 따른다」를 표현할 방법이 사라진다. 그것이
// 기본값이자 대부분의 사람이 원하는 상태이므로, 토글은 첫 탭에서 그 상태를 **잃게**
// 만든다 — 되돌릴 방법도 없다(앱 삭제 말고는). 웹 설정도 같은 이유로 세 값이고,
// 두 클라가 같은 것을 다르게 부르지 않도록 낱말도 같다(시스템 · 라이트 · 다크).
//
// ## 라디오지 탭이 아니다
//
// 세 칸은 서로 배타적인 **설정값**이지 세 개의 장소가 아니다. VoiceOver 가 그것을
// "탭 3의 2"로 읽으면 사람은 화면이 바뀔 것을 기대한다. `radio` + `radiogroup` 은
// "선택됨"과 "3개 중"을 함께 읽고, 그것이 이 컨트롤이 실제로 하는 일이다.
// =============================================================================

export function ThemeControl(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice, setChoice} = useTheme();
  return (
    <View style={styles.wrap} testID="theme-control">
      <Text style={styles.label}>테마</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="테마"
        style={styles.segments}>
        {THEME_CHOICES.map(value => (
          <Segment
            key={value}
            value={value}
            selected={value === choice}
            onSelect={setChoice}
          />
        ))}
      </View>
    </View>
  );
}

function Segment({
  value,
  selected,
  onSelect,
}: {
  value: ThemeChoice;
  selected: boolean;
  onSelect: (choice: ThemeChoice) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{selected}}
      accessibilityLabel={themeChoiceLabel(value)}
      onPress={() => onSelect(value)}
      style={({pressed}) => [
        styles.segment,
        selected && styles.segmentSelected,
        // 눌림은 선택 **위에** 얹힌다. 이미 고른 칸을 다시 누를 때도 손가락이
        // 닿았다는 것은 보여야 하고, 그 자리에서 아무 일도 안 일어나는 것과
        // 아무 반응도 없는 것은 다른 말이다.
        pressed && styles.segmentPressed,
      ]}
      testID={`theme-${value}`}>
      <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>
        {themeChoiceLabel(value)}
      </Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: SAFE_GUTTER,
    paddingBottom: space.sm,
  },
  label: {fontSize: font.label, color: color.textMuted},
  segments: {flex: 1, flexDirection: 'row', gap: space.xs},
  segment: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
  },
  // 고른 칸은 채움과 테두리와 글자, **셋 다** 바뀐다. 테두리만 바꾸면 1px 차이가
  // 유일한 신호가 되고, 그 1px 은 손가락이 덮고 있는 동안 보이지 않는다.
  segmentSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentSurface,
  },
  segmentPressed: {backgroundColor: color.surfacePressed},
  segmentLabel: {fontSize: font.label, color: color.textMuted},
  segmentLabelSelected: {color: color.accentText, fontWeight: '600'},
});
