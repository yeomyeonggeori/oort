import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {font, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {SET_WORD} from './setWords';

// =============================================================================
// 계획 카드·세트 카드(ADR-0218 §12, #5463 폰)가 함께 쓰는 알약 단추.
//
// 모양은 대화 안 행동 승인 카드의 알약(`ApprovalDecision` `shape="pill"`, 시안 `.a-pill`)과 같다: 주 행동 = 잉크 채움, 보조 = 옅은 칸, 높이는
// 엄지 바닥(`TOUCH_TARGET`) 이상이고 큰 글씨에서는 글이 자라는 만큼 자란다(고정 높이가 아니라 `minHeight` 다).
//
// **동작 줄이기**: 보내는 중의 표시는 낱말 하나(`busyLabel`)이고, 도는 표시기(`ActivityIndicator`)는 동작 줄이기가 꺼져 있을 때만 곁든다.
// 돌아가는 것이 낱말 옆의 장식이라 빠져도 사실(「보내는 중」)이 같다.
// =============================================================================

export function PillButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  busyLabel,
  quiet = false,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** 보내는 중에 라벨을 대체하는 낱말. 없으면 라벨 그대로. */
  busyLabel?: string;
  /** 보조(옅은 칸). 아니면 주(잉크 채움). */
  quiet?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const reduceMotion = useReduceMotion();
  const inert = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (busy ? busyLabel ?? label : label)}
      accessibilityState={{disabled: inert, busy}}
      disabled={inert}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        quiet ? styles.quiet : styles.commit,
        disabled && !busy && styles.inert,
        pressed && !inert && styles.pressed,
      ]}
      testID={testID}>
      {busy && !reduceMotion ? (
        <ActivityIndicator
          color={quiet ? palette.text : palette.onPrimary}
          testID="expression-set-spinner"
        />
      ) : null}
      <Sentence style={quiet ? styles.quietLabel : styles.commitLabel}>
        {busy ? busyLabel ?? label : label}
      </Sentence>
    </Pressable>
  );
}

/** 알약 단추를 한 줄(좁으면 줄바꿈)로 세우는 틀. 주 행동이 맨 끝이다. */
export function PillRow({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <View style={styles.row}>{children}</View>;
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: SET_WORD.row,
      flexWrap: SET_WORD.wrap,
      justifyContent: 'flex-end',
      gap: space.sm,
    },
    button: {
      minHeight: TOUCH_TARGET,
      flexDirection: SET_WORD.row,
      alignItems: SET_WORD.center,
      justifyContent: SET_WORD.center,
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: radius.pill,
    },
    commit: {backgroundColor: color.primary},
    quiet: {backgroundColor: color.surfaceMuted},
    inert: {opacity: 0.6},
    pressed: {opacity: 0.85},
    commitLabel: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.onPrimary,
      textAlign: SET_WORD.center,
    },
    quietLabel: {
      fontSize: font.label,
      fontWeight: '600',
      color: color.text,
      textAlign: SET_WORD.center,
    },
  });
