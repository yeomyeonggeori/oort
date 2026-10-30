import type {TriggerChip} from '@momo/core/features/agents/triggerChip';
import {
  REQUEST_BUNDLE_FACE,
  type RequestBundleState,
} from '@momo/core/features/timeline/requestBundle';
import React from 'react';
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
const ICONS: Record<string, ImageSourcePropType> = {
  CircleDot: require('../../design/icons/request-loop/circle-dot.png'),
  ShieldQuestion: require('../../design/icons/request-loop/shield-question.png'),
  Ban: require('../../design/icons/request-loop/ban.png'),
  Octagon: require('../../design/icons/request-loop/octagon.png'),
  CircleX: require('../../design/icons/request-loop/circle-x.png'),
  Check: CONV_ICONS.check,
  Clock: CONV_ICONS.clock,
};

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
}: {
  chip: TriggerChip;
  sentence?: string;
  onOpen?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {fontScale} = useWindowDimensions();
  const scale = Math.min(fontScale, BAR_CONTROL_MAX_SCALE);
  const height = line.meta * scale;
  const style = [
    styles.chip,
    {
      height,
      width:
        font.meta * scale * '아직 받지 않았어요'.length + line.meta + space.sm,
    },
  ];
  const icon =
    chip.mark === 'ban'
      ? 'Ban'
      : chip.mark === 'clock'
      ? 'Clock'
      : chip.mark === 'cross'
      ? 'CircleX'
      : chip.mark === 'check'
      ? 'Check'
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
      onPress={onOpen}
      hitSlop={{top: slopTo(height), bottom: slopTo(height)}}
      style={style}
      testID="request-status-chip"
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityLabel={label}
      style={style}
      testID="request-status-chip"
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
