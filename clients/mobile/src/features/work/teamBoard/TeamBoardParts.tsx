import type {SharedSessionState, SharedWorkSession} from '@momo/core/lib/api';
import {
  diffFacts,
  laneLabel,
  stateChipLabel,
} from '@momo/core/features/workbench/teamBoard';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useStyles} from '../../../design/theme';
import {font, line, radius, space, type Palette} from '../../../design/tokens';

// =============================================================================
// 보드 줄과 시트가 같이 쓰는 작은 부분 (#2864, 웹 `TeamBoardParts`의 폰 짝).
//
// 상태는 **글자와 모양**으로 말한다: 칩에는 늘 글자가 있고, 앞의 기호가 모양을 더한다
// (색만으로 말하지 않는다). 색 역할은 웹 보드의 표와 같다: 응답 필요 = warn, 끝남 = ok,
// 멈춤 = danger, 나머지는 중성. 칩의 말은 코어 `stateChipLabel`이고 여기서 지어내지 않는다.
// 에이전트 레인 표시만 `agent` 색을 쓴다(에이전트 정체성).
// =============================================================================

const STATE_MARK: Readonly<Record<SharedSessionState, string>> = {
  waiting: '!',
  running: '●',
  review: '◐',
  idle: '○',
  done: '✓',
  stopped: '■',
};

export function StateChip({
  item,
  testID,
}: {
  item: SharedWorkSession;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const label = stateChipLabel(item);
  const tone =
    item.state === 'waiting'
      ? styles.chipWarn
      : item.state === 'done'
        ? styles.chipOk
        : item.state === 'stopped'
          ? styles.chipDanger
          : styles.chipNeutral;
  const textTone =
    item.state === 'waiting'
      ? styles.textWarn
      : item.state === 'done'
        ? styles.textOk
        : item.state === 'stopped'
          ? styles.textDanger
          : item.state === 'idle'
            ? styles.textMuted
            : styles.textInk;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`상태 ${label}`}
      style={[styles.chip, tone]}
      testID={testID}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[styles.chipMark, textTone]}>
        {STATE_MARK[item.state]}
      </Text>
      <Text style={[styles.chipLabel, textTone]}>{label}</Text>
    </View>
  );
}

export function LaneLabel({
  item,
  testID,
}: {
  item: SharedWorkSession;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const agent = item.origin === 'host';
  return (
    <Text
      style={[styles.lane, agent ? styles.laneAgent : styles.laneLocal]}
      testID={testID}>
      {agent ? '◆ ' : ''}
      {laneLabel(item)}
    </Text>
  );
}

/** 「+128 −40」. 숫자가 하나도 없으면(에이전트 레인) 아무것도 그리지 않는다. */
export function DiffNumbers({
  item,
  testID,
}: {
  item: SharedWorkSession;
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const facts = diffFacts(item.diff);
  if (facts === null || (facts.added === null && facts.deleted === null)) {
    return null;
  }
  return (
    <Text style={styles.diff} testID={testID}>
      {facts.added !== null ? (
        <Text style={styles.textOk}>+{facts.added}</Text>
      ) : null}
      {facts.added !== null && facts.deleted !== null ? ' ' : ''}
      {facts.deleted !== null ? (
        <Text style={styles.textDanger}>−{facts.deleted}</Text>
      ) : null}
    </Text>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    chip: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    chipWarn: {backgroundColor: color.warnSurface, borderColor: color.warnBorder},
    chipOk: {backgroundColor: color.okSurface, borderColor: color.okBorder},
    chipDanger: {
      backgroundColor: color.dangerSurface,
      borderColor: color.dangerBorder,
    },
    chipNeutral: {backgroundColor: color.surface, borderColor: color.border},
    chipMark: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '700'},
    chipLabel: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    textWarn: {color: color.warn},
    textOk: {color: color.ok},
    textDanger: {color: color.danger},
    textMuted: {color: color.textMuted},
    textInk: {color: color.text},
    lane: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    laneAgent: {color: color.agent},
    laneLocal: {color: color.textMuted},
    diff: {
      fontSize: font.meta,
      lineHeight: line.meta,
      fontVariant: ['tabular-nums'],
    },
  });
