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
  const {choice, systemScheme, setChoice} = useTheme();
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
            //
            // **`scheme` 이 아니라 `systemScheme` 이다** (리뷰 H-1). 첫 판은 풀린
            // 스킴으로 이 문장을 만들었고, 그래서 다크를 **고른** 동안에는 시스템이
            // 라이트여도 「시스템은 다크입니다」라고 말했다 — 이 힌트가 있는 유일한
            // 이유가 「고르지 않으면 무엇이 되는가」인데, 고른 사람에게는 그 답을
            // 자기 선택으로 되돌려 주는 거짓말이 된다. 그 사람이 시스템으로 되돌릴지
            // 판단할 근거가 바로 이 문장이므로 틀리면 쓸모가 없는 것이 아니라
            // 해롭다.
            hint={
              value === 'system'
                ? `지금 이 기기의 시스템은 ${systemScheme === 'dark' ? '다크' : '라이트'}입니다.`
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
    // 안 고른 두 칸의 테두리. **`border` 가 아니다** (리뷰 M-1).
    //
    // `border` 는 이 컨트롤이 서는 발치 바탕(`bg`) 위에서 3:1 **아래**인 값이고
    // (다크 1.406:1 · 라이트 1.315:1),
    // 그 토큰 자신이 「선이지 컨트롤이 아니다」라고 적고 있다(`tokens.ts`). 그런데
    // 여기서 그 선이 지는 일은 hairline 이 아니라 **누를 것의 가장자리**다 — 고르지
    // 않은 두 칸은 채움도 글자 강조도 없으므로 테두리 하나가 「여기가 버튼이다」를
    // 말하는 전부다. 그 값이 3:1 아래면 라이트에서 종이 위에 자국만 남는다.
    //
    // `textFaint` 는 웹 `--line-strong` 과 같은 자리이고 두 스킴 모두에서 3:1 을
    // 넘는다(바탕 위 다크 3.909:1 · 라이트 3.587:1). `paletteContrast.test.ts` 가
    // 그것을 재고, `border` 가 못 넘는 것도 같이 잰다 — 그래서 이 선택은 주석이
    // 아니라 게이트가 진다. 인용의 세로 규정선이 같은 이유로 이미 이 토큰을 빌려 쓴다
    // (`features/conversation/Quote.tsx` 의 `rule`) — 이름 있는 테두리 토큰이 생기면
    // 두 자리가 함께 옮겨 간다.
    borderColor: color.textFaint,
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
