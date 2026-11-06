import {TRIGGER_CHIP_FACES, type TriggerChip} from '@momo/core/features/agents/triggerChip';
import {
  REQUEST_BUNDLE_FACE,
  type RequestBundleState,
} from '@momo/core/features/timeline/requestBundle';
import React, {useRef} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
} from 'react-native';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {CONV_ICONS} from '../../design/icons';
import {font, line, slopTo, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// Lucide(ISC), 셸과 같은 24 viewBox·1.8 선의 1/2/3배 래스터예요.
export const ICONS: Record<string, ImageSourcePropType> = {
  CircleDot: require('../../design/icons/request-loop/circle-dot.png'),
  ShieldQuestion: require('../../design/icons/request-loop/shield-question.png'),
  Ban: require('../../design/icons/request-loop/ban.png'),
  Octagon: require('../../design/icons/request-loop/octagon.png'),
  CircleX: require('../../design/icons/request-loop/circle-x.png'),
  Check: CONV_ICONS.check,
  Clock: CONV_ICONS.clock,
};

/** 칩이 입을 수 있는 가장 긴 낱말의 글자 수(코어 목록에서 읽는다). */
const CHIP_LONGEST_WORD = Math.max(...TRIGGER_CHIP_FACES.map(face => face.word.length));

export function RequestStateFace({
  state,
}: {
  state: RequestBundleState;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const face = REQUEST_BUNDLE_FACE[state];
  return (
    <View style={styles.face} testID={`request-state-${state}`}>
      <Image
        source={ICONS[face.icon]}
        style={[styles.icon, styles[face.tone]]}
        accessible={false}
      />
      <Text style={styles.word}>{face.word}</Text>
    </View>
  );
}

export function RequestStatusChip({
  chip,
  sentence,
  onOpen,
  reserve = true,
  testID = 'request-status-chip',
}: {
  chip: TriggerChip;
  sentence?: string;
  onOpen?: (source: React.RefObject<View | null>) => void;
  /**
   * 폭을 가장 긴 낱말에 맞춰 **미리 잡는가**. 머리 줄의 칩은 이름·시각 곁에 서므로 예약하고(기본), 줄의 맨 끝에 서는 칩(스레드 요약 줄의
   * 「작업 중」)은 서고 져도 이웃 글자가 움직이지 않으므로 예약하지 않는다(웹 `reserve={false}`). 높이는 어느 쪽이든 고정이다.
   */
  reserve?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale} = useWindowDimensions();
  const source = useRef<View | null>(null);
  const scale = Math.min(fontScale, BAR_CONTROL_MAX_SCALE);
  const height = line.meta * scale;
  const style = [
    styles.chip,
    {
      height,
      // 칩의 폭은 **어떤 낱말이 서 있든** 코어가 말하는 가장 긴 낱말(`TRIGGER_CHIP_FACES`)의 폭이다 — 낱말이 바뀌어도(받음 → 가져감 →
      // 작업 중) 머리 줄의 이름·시각 자리가 움직이지 않는다. 낱말이 번역으로 길어져도 코어 목록이 따라간다. 성공으로 끝나면
      // 이 칩 자체가 서지 않는다(#5382, 코어 `triggerChip` → null).
      ...(reserve ? {width: font.meta * scale * CHIP_LONGEST_WORD + line.meta + space.sm} : {}),
    },
  ];
  const icon =
    chip.mark === 'ban'
      ? 'Ban'
      : chip.mark === 'clock'
      ? 'Clock'
      : chip.mark === 'cross'
      ? 'CircleX'
      : chip.kind === 'approval'
      ? 'ShieldQuestion'
      : 'CircleDot';
  const content = (
    <>
      <Image
        source={ICONS[icon]}
        style={[styles.icon, styles[chip.tone]]}
        accessible={false}
      />
      <Text
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        numberOfLines={1}
        style={styles.word}
      >
        {chip.word}
      </Text>
    </>
  );
  const label = `${chip.label}${sentence ? `: ${sentence}` : ''}`;
  return onOpen ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      ref={source}
      onPress={() => onOpen(source)}
      hitSlop={{top: slopTo(height), bottom: slopTo(height)}}
      style={style}
      testID={testID}
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityLabel={label}
      style={style}
      testID={testID}
    >
      {content}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    face: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    chip: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    icon: {width: line.meta, height: line.meta, resizeMode: 'contain'},
    word: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    working: {tintColor: color.warn},
    muted: {tintColor: color.textMuted},
    warn: {tintColor: color.warn},
    ok: {tintColor: color.ok},
    danger: {tintColor: color.danger},
  });
