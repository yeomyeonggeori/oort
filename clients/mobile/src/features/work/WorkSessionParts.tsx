import type {WorkExecutionLocation} from '@momo/core/features/work/workLocation';
import type {WorkSessionStatus} from '@momo/core/features/work/workSessionModel';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

const LOCATION_MARK: Readonly<Record<WorkExecutionLocation['key'], string>> = {
  t1: '▣',
  t2: '▤',
  t3: '☁',
  unknown: '?',
};

/** Text + shape: no execution tier relies on colour or an icon alone. */
export function WorkLocationBadge({
  location,
  testID,
}: {
  location: WorkExecutionLocation;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const spokenLocation =
    location.key === 'unknown'
      ? '실행 위치를 확인해야 합니다'
      : `실행 위치 ${location.label}`;
  const tone =
    location.key === 't1'
      ? styles.locationT1
      : location.key === 't2'
        ? styles.locationT2
        : location.key === 't3'
          ? styles.locationT3
          : styles.locationUnknown;
  const textTone =
    location.key === 't2'
      ? styles.locationTextT2
      : location.key === 'unknown'
        ? styles.locationTextUnknown
        : styles.locationTextAccent;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={spokenLocation}
      style={[styles.location, tone]}
      testID={testID}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[styles.locationMark, textTone]}>
        {LOCATION_MARK[location.key]}
      </Text>
      <Text style={[styles.locationText, textTone]}>{location.label}</Text>
    </View>
  );
}

/**
 * 수명주기 칩. 색을 버는 상태는 **지금 무언가가 벌어지고 있는** 상태(실행 중)와
 * **사람을 기다리는** 상태(호스트 연결 끊김)뿐이고, 끝난 세션은 낱말로만 말한다.
 *
 * 종료됨은 `okSurface` 위의 초록이었다(#1491 이전). 웹의 코어 역할표
 * (`SESSION_STATUS_CLASS`)가 같은 자리를 muted 로 내린 것과 같은 이유로 여기서도
 * 내렸다: 「멈췄다」는 이 행에서 가장 정보가 없는 사실인데 가장 눈에 띄는 색을
 * 지고 있었고, 게이트 결과가 이 표면에 서게 되면 벌어서 든 초록과 나란히 놓인다.
 * 폰과 웹이 같은 상태를 다른 색으로 부르면 한 원장에 두 어휘가 생긴다.
 */
export function WorkStatusBadge({
  status,
  testID,
}: {
  status: WorkSessionStatus;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const tone =
    status.key === 'running'
      ? styles.statusRunning
      : status.key === 'orphaned' || status.key === 'unavailable'
        ? styles.statusAttention
        : styles.statusNeutral;
  const textTone =
    status.key === 'running'
      ? styles.statusTextRunning
      : status.key === 'orphaned' || status.key === 'unavailable'
        ? styles.statusTextAttention
        : styles.statusTextNeutral;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`상태 ${status.label}`}
      style={[styles.status, tone]}
      testID={testID}>
      <Text style={[styles.statusText, textTone]}>{status.label}</Text>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    location: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    locationT1: {backgroundColor: color.accentSurface, borderColor: color.accent},
    locationT2: {backgroundColor: color.agentSurface, borderColor: color.agent},
    locationT3: {backgroundColor: color.accentSurface, borderColor: color.accent},
    locationUnknown: {backgroundColor: color.warnSurface, borderColor: color.warnBorder},
    locationMark: {fontSize: font.label, lineHeight: line.label, fontWeight: '700'},
    locationText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    locationTextAccent: {color: color.accentText},
    locationTextT2: {color: color.agent},
    locationTextUnknown: {color: color.warn},
    status: {
      alignSelf: 'flex-start',
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    statusRunning: {backgroundColor: color.warnSurface, borderColor: color.warnBorder},
    statusAttention: {backgroundColor: color.accentSurface, borderColor: color.accent},
    statusNeutral: {backgroundColor: color.surface, borderColor: color.border},
    statusText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    statusTextRunning: {color: color.warn},
    statusTextAttention: {color: color.accentText},
    statusTextNeutral: {color: color.textMuted},
  });
