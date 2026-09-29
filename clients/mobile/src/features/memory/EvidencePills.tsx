import type {MemoryEvidenceLink} from '@momo/core/features/memory/model';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {font, radius, slopTo, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {evidenceA11y, evidenceLabel, evidenceMore} from './copy';

// 근거 메시지로 가는 작은 알약들. 알약은 글줄 높이라 44는 `hitSlop`이 채운다(카드가
// 두꺼워지지 않게) — 산수는 `slopTo` 한 곳에 있다.
export const PILL_HEIGHT = 28;

export function EvidencePills({
  links,
  max,
  onOpen,
  testID,
}: {
  links: readonly MemoryEvidenceLink[];
  /** 이 수만 알약으로 세우고 나머지는 「외 n개」로 말한다. */
  max: number;
  onOpen?: (link: MemoryEvidenceLink) => void;
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (links.length === 0) return null;
  const shown = links.slice(0, max);
  const rest = links.length - shown.length;
  return (
    <View style={styles.row} testID={testID}>
      {shown.map((link, index) => (
        <Pressable
          key={link.messageId}
          accessibilityRole="button"
          accessibilityLabel={evidenceA11y(index + 1)}
          disabled={onOpen === undefined}
          hitSlop={{top: slopTo(PILL_HEIGHT), bottom: slopTo(PILL_HEIGHT)}}
          onPress={() => onOpen?.(link)}
          style={({pressed}) => [styles.pill, pressed && styles.pressed]}
          testID={testID ? `${testID}-${index + 1}` : undefined}>
          <Text style={styles.pillLabel}>{evidenceLabel(index + 1)}</Text>
        </Pressable>
      ))}
      {rest > 0 ? <Text style={styles.rest}>{evidenceMore(rest)}</Text> : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: space.sm,
      // 줄이 접혀도 위아래 hitSlop(8)이 겹치지 않게 slop 두 배만큼 벌린다.
      rowGap: space.lg,
    },
    pill: {
      minHeight: PILL_HEIGHT,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.bg,
    },
    pressed: {opacity: 0.6},
    pillLabel: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
    rest: {fontSize: font.meta, color: color.textMuted},
  });
