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
// 만든다 — 되돌릴 방법도 없다(앱 삭제 말고는).
//
// 웹 설정(`clients/web/src/features/settings/AppearanceSection.tsx`)도 같은 이유로
// 세 값이고, 값 이름(system/light/dark)과 기본값이 두 클라에서 같다. 화면에 보이는
// 낱말 하나만 다르다: 웹은 자기 줄과 설명 줄을 가진 목록이라 「시스템 설정 따르기」로
// 풀어 쓰고, 여기는 세 칸이 한 줄을 나눠 갖는 세그먼트라 「시스템」이다. 그 칸이
// **지금** 무엇을 뜻하는지는 힌트가 답한다 — 웹이 설명 줄에 적는 그 문장이고, 폰은
// 발치에 줄을 하나 더 쓰는 대신 보조기술에게 말한다.
//
// ## 라디오지 탭이 아니다
//
// 세 칸은 서로 배타적인 **설정값**이지 세 개의 장소가 아니다. VoiceOver 가 그것을
// "탭 3의 2"로 읽으면 사람은 화면이 바뀔 것을 기대한다. `radio` + `radiogroup` 은
// "선택됨"과 "3개 중"을 함께 읽고, 그것이 이 컨트롤이 실제로 하는 일이다.
// =============================================================================

export function ThemeControl(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice, scheme, setChoice} = useTheme();
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
            // 「시스템」이 지금 무엇으로 풀리는지. 다른 두 칸은 라벨이 곧 답이라
            // 힌트가 없다 — 아는 것을 두 번 말하면 보조기술 사용자가 매번 그것을
            // 듣는다.
            hint={
              value === 'system'
                ? `지금 이 기기의 시스템은 ${scheme === 'dark' ? '다크' : '라이트'}입니다.`
                : undefined
            }
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
  hint,
}: {
  value: ThemeChoice;
  selected: boolean;
  onSelect: (choice: ThemeChoice) => void;
  hint?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{selected}}
      accessibilityLabel={themeChoiceLabel(value)}
      accessibilityHint={hint}
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
