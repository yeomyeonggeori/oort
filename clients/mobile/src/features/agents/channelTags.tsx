import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, radius, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// 에이전트가 들어 있는 채널을 보여 주는 두 가지 모양 (성재 2026-10-16).
//
// 이전에는 `#agent-lab  #general  #grokbot-lab` 이 공백 두 칸으로 이어진 글자
// 한 줄이었다. 어디서 한 채널이 끝나고 다음이 시작하는지 눈으로도 소리로도
// 알기 어려웠다. 이제:
//
//  - 상세 화면: 채널마다 칩 하나(태그형). 칩 묶음은 접근성 요소 **하나**이고 낭독
//    라벨은 쉼표로 끊은 이름(「agent-lab, general, grokbot-lab」)이다. 칩 하나하나가
//    포커스를 받으면 열 개가 열 번의 낭독이 되고, 「샵」 기호까지 읽힌다.
//  - 목록 줄: 쉼표로 이은 글자(`#a, #b, #c +2`). 세 개까지 보이고 나머지는 +N.
//
// 이름 목록의 정본은 `channelPlacement` 이다. 여기서는 모양만 만든다.
// =============================================================================

/** 목록 줄에 이름으로 보이는 채널 수. 나머지는 +N 으로 접는다. */
export const ROW_CHANNEL_LIMIT = 3;

/** 낭독용: 기호 없이 쉼표로. */
export function spokenChannels(names: readonly string[]): string {
  return names.join(', ');
}

/** 목록 줄용 글자: `#agent-lab, #general, #grokbot-lab +2`. 비면 빈 문자열. */
export function channelListText(
  names: readonly string[],
  limit: number = ROW_CHANNEL_LIMIT,
): string {
  const shown = names.slice(0, limit).map(name => `#${name}`);
  const rest = names.length - shown.length;
  const text = shown.join(', ');
  return rest > 0 ? `${text} +${rest}` : text;
}

/** 상세 화면의 칩 묶음. */
export function ChannelTags({
  names,
  testID,
}: {
  names: readonly string[];
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessible
      accessibilityLabel={spokenChannels(names)}
      style={styles.wrap}
      testID={testID}>
      {names.map(name => (
        <View key={name} style={styles.chip} testID="channel-tag">
          <Text style={styles.chipText} numberOfLines={1} ellipsizeMode="tail">
            {`#${name}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    wrap: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
    chip: {
      // 눌러지는 것이 아니라 읽는 표지다 — 터치 높이를 채우지 않는다.
      maxWidth: '100%',
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    chipText: {fontSize: font.meta, color: color.text, fontWeight: '600'},
  });
