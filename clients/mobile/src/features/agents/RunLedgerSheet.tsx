import type {AgentRunProgress} from '@momo/core/lib/api';
import {
  clockLabel,
  ledgerRows,
  RUN_LEDGER_KEPT_SENTENCE,
  RUN_LEDGER_LIMIT_SENTENCE,
  runEmptyState,
  type RunLedgerRow,
} from '@momo/core/features/agents/runLedger';
import {runDurationBreakdown} from '@momo/core/features/agents/runDuration';
import {
  isOpenRunPhase,
  runPhaseDetail,
  runPhaseLabel,
  serverFactsOf,
} from '@momo/core/features/agents/runPhase';
import {agentLabel, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import {useQuery} from '@tanstack/react-query';
import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BAR_CONTROL_MAX_SCALE, ErrorState, LoadingState} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useSession} from '../../session/useSession';
import {useRunRow} from './agentRunProgressStore';
import {
  RUN_LEDGER_POLL_MS,
  runLedgerQueryOptions,
  useRunLedgerFrames,
} from './runLedgerQuery';
import {useTickingNow} from './workingSignal';

// =============================================================================
// 폰의 run 기록 시트 (#3824). 웹 작업 패널의 「기록」 쪽(`AgentRunLedgerView`)과 같은
// core(`runLedger`·`runPhase`·`runDuration`)를 읽는다. 폰에는 이 기록을 볼 곳이 없었다:
// 에이전트가 가져갔는지, 어디서 시간이 갔는지를 알려면 데스크탑을 열어야 했다.
//
// 서버가 기억하는 것만 그린다. 원장은 닫아도·다른 기기에서 열어도 같다. 에이전트가 보낸
// 단계 문자열은 일반 텍스트로만 그린다(서버도 80자·신뢰하지 않는 텍스트로 다룬다). 이
// 앱이 모르는 종류의 줄이 와도 시트는 깨지지 않는다(core가 `unknown` 한 줄로 접는다).
// =============================================================================

export const RUN_LEDGER_SHEET_TITLE = '작업 기록';

export function RunLedgerSheet({
  progress,
  directory,
  onClose,
}: {
  /** 연 순간의 run. 스토어가 더 새 답을 갖고 있으면 그것을 쓴다. */
  progress: AgentRunProgress;
  directory: Directory;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel={RUN_LEDGER_SHEET_TITLE}
      testID="run-ledger-sheet">
      <SheetBody progress={progress} directory={directory} onClose={onClose} />
    </PageSheet>
  );
}

export function SheetBody({
  progress: opened,
  directory,
  onClose,
}: {
  progress: AgentRunProgress;
  directory: Directory;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const slideClose = usePageSheetClose() ?? onClose;
  const {workspaceId} = useSession();
  const live = useRunRow(opened.id);
  const progress = live ?? opened;
  const open = isOpenRunPhase(progress.phase);
  const key = progress.id.toLowerCase();
  const query = useQuery({
    ...runLedgerQueryOptions(workspaceId, key),
    refetchInterval: open ? RUN_LEDGER_POLL_MS : false,
  });
  useRunLedgerFrames(key, query.refetch);
  const rows = useMemo(
    () => (query.data === undefined ? [] : ledgerRows(query.data.events)),
    [query.data],
  );
  const nowMs = useTickingNow(open);
  const facts = serverFactsOf(progress);
  const detail = runPhaseDetail(facts, nowMs);
  const name = agentLabel(
    memberNameParts(directory, progress.agentMemberId, UNKNOWN_AGENT_NAME),
  );
  const summary = progress.triggerSummary?.trim();
  const empty = runEmptyState(progress);

  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <View style={styles.navSide} />
        <Text
          accessibilityRole="header"
          style={styles.navTitle}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
          {RUN_LEDGER_SHEET_TITLE}
        </Text>
        <View style={[styles.navSide, styles.navSideEnd]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="작업 기록 닫기"
            onPress={slideClose}
            style={({pressed}) => [styles.navButton, pressed && styles.pressed]}
            testID="run-ledger-close">
            <Text style={styles.navButtonLabel} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              닫기
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {paddingBottom: insets.bottom + space.xl},
        ]}
        testID="run-ledger-scroll">
        <View style={styles.head}>
          <Text style={styles.agent} testID="run-ledger-agent">
            {name}
          </Text>
          {summary !== undefined && summary !== '' ? (
            <Text style={styles.summary} numberOfLines={3} testID="run-ledger-summary">
              {summary}
            </Text>
          ) : null}
          <View style={styles.stateLine}>
            <View
              style={[
                styles.chip,
                progress.phase === 'running' && styles.chipWorking,
                progress.phase === 'awaiting_approval' && styles.chipWaiting,
              ]}>
              <Text
                style={[
                  styles.chipText,
                  progress.phase === 'running' && styles.chipWorkingText,
                  progress.phase === 'awaiting_approval' && styles.chipWaitingText,
                ]}
                testID="run-ledger-phase">
                {runPhaseLabel(facts)}
              </Text>
            </View>
            {detail !== undefined ? (
              <Text style={styles.detail} testID="run-ledger-detail">
                {detail}
              </Text>
            ) : null}
          </View>
          <Text style={styles.durations} testID="run-ledger-durations">
            {runDurationBreakdown(facts, nowMs)}
          </Text>
        </View>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionHeading}>
            기록
          </Text>
          <Text style={styles.note} testID="run-ledger-limit">
            {RUN_LEDGER_LIMIT_SENTENCE}
          </Text>
          <Text style={styles.note}>{RUN_LEDGER_KEPT_SENTENCE}</Text>
        </View>

        {query.isLoading ? (
          <LoadingState label="기록을 읽고 있어요" testID="run-ledger-loading" />
        ) : query.isError && rows.length === 0 ? (
          <ErrorState
            headline="기록을 읽지 못했어요."
            detail={open ? '잠시 뒤에 다시 읽어요.' : '다시 시도하거나 시트를 다시 열어 주세요.'}
            onRetry={() => void query.refetch()}
            testID="run-ledger-error"
          />
        ) : rows.length === 0 ? (
          <View style={styles.emptyBlock} testID="run-ledger-empty">
            <Text style={styles.emptyHeadline}>{empty.headline}</Text>
            <Text style={styles.note}>{empty.detail}</Text>
          </View>
        ) : (
          <View style={styles.rows} testID="run-ledger-rows">
            {rows.map(row => (
              <LedgerRowView key={row.key} row={row} nowMs={nowMs} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function LedgerRowView({
  row,
  nowMs,
}: {
  row: RunLedgerRow;
  nowMs: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.row} testID={`run-ledger-row-${row.kind}`}>
      <View style={styles.rowLine}>
        <Text style={styles.rowTime}>{clockLabel(row.atMs, nowMs)}</Text>
        <Text
          style={[
            styles.rowText,
            row.tone === 'neutral' && styles.rowTextNeutral,
            row.tone === 'action' && styles.rowTextAction,
            row.tone === 'end' && styles.rowTextEnd,
          ]}>
          {row.text}
          {row.count !== undefined ? (
            <Text style={styles.rowTextNeutral}>{` · ${row.count}번`}</Text>
          ) : null}
        </Text>
      </View>
      {row.reason !== undefined ? (
        <Text style={styles.rowReason}>{row.reason}</Text>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_TARGET + space.md,
      paddingHorizontal: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    navSide: {flex: 1, flexDirection: 'row'},
    navSideEnd: {justifyContent: 'flex-end'},
    navTitle: {
      flexShrink: 1,
      fontSize: font.body,
      fontWeight: '600',
      color: color.text,
      textAlign: 'center',
    },
    navButton: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    navButtonLabel: {fontSize: font.body, color: color.accentText, fontWeight: '600'},
    pressed: {backgroundColor: color.surfacePressed},
    content: {paddingTop: space.lg, gap: space.lg},
    head: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    agent: {fontSize: font.heading, lineHeight: line.body, fontWeight: '700', color: color.agent},
    summary: {fontSize: font.body, lineHeight: line.body, color: color.text},
    stateLine: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
    chip: {
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.badge,
      borderWidth: 1,
      borderColor: color.border,
    },
    chipWorking: {borderColor: color.agent, backgroundColor: color.agentSurface},
    chipWaiting: {borderColor: color.warn},
    chipText: {fontSize: font.meta, fontWeight: '600', color: color.textMuted},
    chipWorkingText: {color: color.agent},
    chipWaitingText: {color: color.warn},
    detail: {flexShrink: 1, fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    durations: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
      fontVariant: ['tabular-nums'],
    },
    section: {paddingHorizontal: SAFE_GUTTER, gap: space.xs},
    sectionHeading: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.textMuted,
    },
    note: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    emptyBlock: {paddingHorizontal: SAFE_GUTTER, gap: space.xs},
    emptyHeadline: {fontSize: font.body, lineHeight: line.body, color: color.text},
    rows: {paddingHorizontal: SAFE_GUTTER},
    row: {
      paddingVertical: space.sm,
      gap: space.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    rowLine: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
    rowTime: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    rowText: {flex: 1, fontSize: font.body, lineHeight: line.body, color: color.text},
    rowTextNeutral: {color: color.textMuted},
    rowTextAction: {color: color.warn},
    rowTextEnd: {fontWeight: '600'},
    rowReason: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
  });
