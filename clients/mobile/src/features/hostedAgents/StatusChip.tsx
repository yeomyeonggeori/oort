import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, radius, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// 하나의 상태 칩 — 연결 상태와 정리 줄 상태가 같은 낱말 모양을 쓴다 (goal HAP-UX3).
//
// 코어가 두 어휘를 낸다: 연결 상태는 `HostedChipTone`(neutral·ok·warn·danger),
// 정리 줄은 `CleanupRowTone`(ok·warn·muted·accent). 둘을 한 칩이 받되, **색은
// 두 번째 신호이지 유일한 신호가 아니다** — 칩에는 언제나 낱말이 있고(웹 `StatusChip`
// 이 outline·text-first 인 것과 같은 규율), 색맹인 사람에게도 낱말이 답한다.
//
// `accent` 는 이 기능에서 **닿지 않는 톤**이다: `cleanupRowTone` 은 ok·warn·muted
// 만 내고(accent 를 내는 상태가 없다), 연결 상태에도 accent 가 없다. 그래서 이
// 표면이 실제로 그리는 톤은 **다섯**(neutral·ok·warn·danger·muted)이지 여섯이
// 아니다 — `accent` 케이스는 타입의 완결성을 위해 남겨 둔 죽은 가지다.
//
// 웹의 `neutral → muted` 대응을 그대로 든다: 이 앱의 팔레트에는 중성 표면(`surface`)
// 위 흐린 글자(`textMuted`)가 그 자리다.
// =============================================================================

export type HostedChipTone =
  | 'neutral'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'muted'
  | 'accent';

export function StatusChip({
  tone,
  label,
  testID,
}: {
  tone: HostedChipTone;
  label: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {box, text} = toneStyles(styles, tone);
  return (
    <View style={[styles.chip, box]} testID={testID}>
      <Text style={[styles.chipText, text]}>{label}</Text>
    </View>
  );
}

function toneStyles(styles: ReturnType<typeof buildStyles>, tone: HostedChipTone) {
  switch (tone) {
    case 'ok':
      return {box: styles.boxOk, text: styles.textOk};
    case 'warn':
      return {box: styles.boxWarn, text: styles.textWarn};
    case 'danger':
      return {box: styles.boxDanger, text: styles.textDanger};
    case 'accent':
      return {box: styles.boxAccent, text: styles.textAccent};
    case 'neutral':
    case 'muted':
      return {box: styles.boxNeutral, text: styles.textNeutral};
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    chip: {
      alignSelf: 'flex-start',
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    chipText: {fontSize: font.meta, fontWeight: '600'},
    boxNeutral: {backgroundColor: color.surface, borderColor: color.border},
    textNeutral: {color: color.textMuted},
    boxOk: {backgroundColor: color.okSurface, borderColor: color.okBorder},
    textOk: {color: color.ok},
    boxWarn: {backgroundColor: color.warnSurface, borderColor: color.warnBorder},
    textWarn: {color: color.warn},
    boxDanger: {
      backgroundColor: color.dangerSurface,
      borderColor: color.dangerBorder,
    },
    textDanger: {color: color.dangerText},
    boxAccent: {
      backgroundColor: color.accentSurface,
      borderColor: color.border,
    },
    textAccent: {color: color.accentText},
  });
