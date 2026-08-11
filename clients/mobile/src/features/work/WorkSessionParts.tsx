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
        : status.key === 'done'
          ? styles.statusDone
          : styles.statusNeutral;
  const textTone =
    status.key === 'running'
      ? styles.statusTextRunning
      : status.key === 'orphaned' || status.key === 'unavailable'
        ? styles.statusTextAttention
        : status.key === 'done'
          ? styles.statusTextDone
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
    statusDone: {backgroundColor: color.okSurface, borderColor: color.okBorder},
    statusNeutral: {backgroundColor: color.surface, borderColor: color.border},
    statusText: {fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
    statusTextRunning: {color: color.warn},
    statusTextAttention: {color: color.accentText},
    statusTextDone: {color: color.ok},
    statusTextNeutral: {color: color.textMuted},
  });
