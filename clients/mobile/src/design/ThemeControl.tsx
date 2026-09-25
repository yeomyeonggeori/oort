import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {GroupRow} from './atoms';
import {
  THEME_CHOICES,
  themeChoiceLabel,
  useStyles,
  useTheme,
  type ThemeChoice,
} from './theme';
import {font, radius, space, type Palette} from './tokens';

// =============================================================================
// 「테마」 — 폰에서 스킴을 고르는 유일한 자리 (U2 → #2702).
//
// ## 어디에 서는가
//
// 프로필 시트의 「테마 ›」 줄이 여는 한 장이다(#2702). U2 에서는 대화 목록 발치의
// 세그먼트 세 칸이었는데, 성재가 그 발치를 「UI랑 UX가 너무 구리다」고 짚었다:
// 목록 아래에 계정·로그아웃·테마가 붙박여 목록을 가리고, 한 번 고르면 다시 볼
// 일이 없는 설정이 매일 보는 화면의 한 줄을 차지하고 있었다. 설정 화면은 여전히
// 폰에 없다(ADR-0137 D5) — 이것은 새 화면이 아니라 내 계정 시트 안의 한 장이다.
//
// ## 세 값이고 두 값이 아니다
//
// 토글(라이트↔다크)로 만들면 「시스템을 따른다」를 표현할 방법이 사라진다. 그것이
// 기본값이자 대부분의 사람이 원하는 상태이므로, 토글은 첫 탭에서 그 상태를 **잃게**
// 만든다. 웹 설정(`clients/web/src/features/settings/AppearanceSection.tsx`)도
// 같은 이유로 세 값이고, 값 이름(system/light/dark)과 기본값이 두 클라에서 같다.
// 「시스템」 줄은 그 칸이 **지금** 무엇을 뜻하는지를 설명 줄로 적는다 — 웹이
// 설명 줄에 적는 그 문장이고, 보조기술에게는 힌트로도 간다.
//
// ## 라디오지 탭이 아니다
//
// 세 줄은 서로 배타적인 **설정값**이지 세 개의 장소가 아니다. `radio` +
// `radiogroup` 은 "선택됨"과 "3개 중"을 함께 읽고, 그것이 이 컨트롤이 실제로
// 하는 일이다. 고른 줄은 체크 표시·글자색·굵기 **셋**이 함께 바뀐다 — 체크 하나만
// 바꾸면 손가락이 그것을 덮는 동안 신호가 없다.
// =============================================================================

export function ThemeControl(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice, systemScheme, setChoice} = useTheme();
  // **`scheme` 이 아니라 `systemScheme` 이다** (U2 리뷰 H-1). 풀린 스킴으로 이
  // 문장을 만들면 다크를 **고른** 동안에는 시스템이 라이트여도 「시스템은
  // 다크입니다」라고 말한다 — 이 문장이 있는 이유가 「고르지 않으면 무엇이
  // 되는가」인데, 고른 사람에게 그 답을 자기 선택으로 되돌려 주는 거짓말이 된다.
  const systemNow = `지금 이 기기의 시스템은 ${systemScheme === 'dark' ? '다크' : '라이트'}입니다.`;
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="테마"
      style={styles.card}
      testID="theme-control">
      {THEME_CHOICES.map((value, index) => (
        <Choice
          key={value}
          value={value}
          selected={value === choice}
          separated={index > 0}
          onSelect={setChoice}
          detail={value === 'system' ? systemNow : undefined}
        />
      ))}
    </View>
  );
}

function Choice({
  value,
  selected,
  separated,
  onSelect,
  detail,
}: {
  value: ThemeChoice;
  selected: boolean;
  separated: boolean;
  onSelect: (choice: ThemeChoice) => void;
  detail?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <GroupRow
      title={themeChoiceLabel(value)}
      detail={detail}
      tone={selected ? 'accent' : 'default'}
      separated={separated}
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityState={{selected}}
      accessibilityLabel={themeChoiceLabel(value)}
      accessibilityHint={detail}
      trailing={
        <Text
          style={[styles.check, !selected && styles.checkHidden]}
          importantForAccessibility="no"
          testID={selected ? `theme-${value}-check` : undefined}>
          ✓
        </Text>
      }
      testID={`theme-${value}`}
    />
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  check: {
    fontSize: font.body,
    fontWeight: '700',
    color: color.accentText,
    minWidth: space.lg,
    textAlign: 'center',
  },
  // 자리는 지킨다 — 고른 줄이 바뀔 때 글자가 옆으로 움찔하지 않게.
  checkHidden: {opacity: 0},
});
