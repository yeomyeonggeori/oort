import type {AgentReportedResult} from '@momo/core/lib/api';
import {
  WORK_JOBS_COPY,
  nextActionText,
  resultKindText,
  testsText,
  toolCountsText,
} from '@momo/core/features/workbench/workJobs';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {GroupCard} from '../../../design/sheetParts';
import {useStyles} from '../../../design/theme';
import {font, line, radius, SHEET, space, type Palette} from '../../../design/tokens';

// =============================================================================
// 폰 「작업」 줄·시트가 같이 쓰는 「에이전트 보고」 부분 (ADR-0202 D1, ADR-0162 증보 5 C1·C2,
// 웹 `jobs/WorkJobParts`의 짝). 에이전트가 스스로 알린 값은 **언제나 꼬리표와 함께** 그린다.
// =============================================================================

export function ReportedTag({testID}: {testID?: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.tag} testID={testID ?? 'work-job-reported-tag'}>
      <Text style={styles.tagLabel}>◆ {WORK_JOBS_COPY.reportedTag}</Text>
    </View>
  );
}

/**
 * 시트의 「에이전트 보고」 절: 닫힌 칸만 키-값으로. 꼬리표·힌트 줄 아래에 **묶음 카드**가 서고 칸마다 한 줄이다(#4458 —
 * 옛 맨 바닥의 키-값 줄). 가로 여백은 호스트(`SheetScroll`)가 준다. 값이 길어 두 줄이 되므로 `ListRow` 의 오른쪽 값이 아니라
 * 카드 안의 줄이다.
 */
export function ReportedFacts({
  reported,
}: {
  reported: AgentReportedResult;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const rows: [string, string][] = [];
  if (reported.resultKind !== null) rows.push(['한 일', resultKindText(reported.resultKind)]);
  if (reported.tests !== null) rows.push(['테스트', testsText(reported.tests)]);
  if (reported.nextAction !== null) {
    const next = nextActionText(reported.nextAction);
    if (next !== null) rows.push(['다음 할 일', next]);
  }
  if (reported.commitSha !== null) rows.push(['커밋', reported.commitSha.slice(0, 12)]);
  if (reported.toolCounts !== null) rows.push(['작업 환경 안', toolCountsText(reported.toolCounts)]);
  return (
    <View style={styles.block} testID="work-job-reported">
      <View style={styles.head}>
        <ReportedTag />
        <Text style={styles.hint}>에이전트가 스스로 알린 값이에요</Text>
      </View>
      {rows.length > 0 ? (
        <GroupCard>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row} accessible accessibilityLabel={`${label}, ${value}`}>
              <Text style={styles.key}>{label}</Text>
              <Text style={styles.value}>{value}</Text>
            </View>
          ))}
        </GroupCard>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    tag: {
      alignSelf: 'flex-start',
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    tagLabel: {fontSize: font.meta, lineHeight: line.meta, color: color.text, fontWeight: '600'},
    block: {gap: space.sm},
    head: {flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap'},
    hint: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    row: {
      flexDirection: 'row',
      gap: space.md,
      alignItems: 'baseline',
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    key: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    value: {flex: 1, fontSize: font.body, lineHeight: line.body, color: color.text},
  });
