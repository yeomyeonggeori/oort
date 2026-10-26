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
  serverFactsOf,
} from '@momo/core/features/agents/runPhase';
import {runStateWord} from '@momo/core/features/agents/runWaiting';
import {agentLabel, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import {useQuery} from '@tanstack/react-query';
import React, {useMemo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {ErrorState, LoadingState} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, GroupLabel, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SHEET,
  space,
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
//
// ## 공용 시트로 (#4458)
//
// 머리는 오른쪽 원형 X 의 `SheetHeader`(옛 직접 짠 머리의 글자 「닫기」는 없다 — 이름은 그대로 「작업 기록 닫기」)이고
// 몸은 `SheetScroll` 이다. 요약(에이전트·요청·상태·시간)은 카드 하나, 기록 줄은 **묶음 카드의 줄**이고 줄 사이는 카드의
// 구분선이다(옛 줄마다 아래 테두리 없음). 기록 한계·보관 문장은 「기록」 라벨 아래·목록 위다(ADR-0200 D5 — 스크롤을 내려야만
// 보이는 자리의 한계는 사실상 숨기는 것이다). 읽기 전용의 긴 목록이라 규칙상 페이지
// 후보다(`docs/design-system/phone-sheets.md` §1) — 이 이슈는 시트로 둔 채 머리·부품만 옮겼다.
// =============================================================================

export const RUN_LEDGER_SHEET_TITLE = '작업 기록';
const RUN_LEDGER_CLOSE_LABEL = `${RUN_LEDGER_SHEET_TITLE} 닫기`;

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
      scrimLabel={RUN_LEDGER_CLOSE_LABEL}
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
      <SheetHeader
        title={RUN_LEDGER_SHEET_TITLE}
        closeLabel={RUN_LEDGER_CLOSE_LABEL}
        onClose={slideClose}
        closeTestID="run-ledger-close"
      />

      <SheetScroll testID="run-ledger-scroll">
        <GroupCard>
          <View style={styles.head}>
            <Text style={styles.agent} testID="run-ledger-agent">
              {name}
            </Text>
            {summary !== undefined && summary !== '' ? (
              <Text
                style={styles.summary}
                numberOfLines={3}
                lineBreakStrategyIOS="hangul-word"
                testID="run-ledger-summary">
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
                  {/* 홈 카드·웹 패널 머리 칩과 같은 낱말 고르기(`runStateWord`, design-review #4285 r1 H5). */}
                  {runStateWord(facts, nowMs)}
                </Text>
              </View>
              {detail !== undefined ? (
                <Text
                  style={styles.detail}
                  lineBreakStrategyIOS="hangul-word"
                  testID="run-ledger-detail">
                  {detail}
                </Text>
              ) : null}
            </View>
            <Text
              style={styles.durations}
              lineBreakStrategyIOS="hangul-word"
              testID="run-ledger-durations">
              {runDurationBreakdown(facts, nowMs)}
            </Text>
          </View>
        </GroupCard>

        <View style={styles.section}>
          <GroupLabel>기록</GroupLabel>
          {/* 한계·보관 문장은 행을 어떻게 읽을지 정하는 지시다(안 보이는 것은 안 한 일이 아니다). 목록 위, 스크롤 몸의 첫머리에 둔다 —
              스크롤을 내려야만 보이는 자리의 한계는 사실상 숨기는 것이다(ADR-0200 D5, 웹 `PanelFooter` 주석과 같은 결정). 이 PR 의
              1단계가 목록 아래 각주로 옮겼던 것을 design-review r1b M1 이 되돌렸다. */}
          <View style={styles.limits}>
            <Text
              style={styles.note}
              lineBreakStrategyIOS="hangul-word"
              testID="run-ledger-limit">
              {RUN_LEDGER_LIMIT_SENTENCE}
            </Text>
            <Text
              style={styles.note}
              lineBreakStrategyIOS="hangul-word"
              testID="run-ledger-kept">
              {RUN_LEDGER_KEPT_SENTENCE}
            </Text>
          </View>
          {query.isLoading ? (
            // 상태 블록은 가로 여백(16)을 스스로 든다 — 카드 안에 서야 시트 몸의 거터와 겹치지 않고 카드 행과 글자 열이 맞는다.
            <GroupCard>
              <LoadingState label="기록을 읽고 있어요" testID="run-ledger-loading" />
            </GroupCard>
          ) : query.isError && rows.length === 0 ? (
            <GroupCard>
              <ErrorState
                headline="기록을 읽지 못했어요."
                detail={open ? '잠시 뒤에 다시 읽어요.' : '다시 시도하거나 시트를 다시 열어 주세요.'}
                onRetry={() => void query.refetch()}
                testID="run-ledger-error"
              />
            </GroupCard>
          ) : rows.length === 0 ? (
            <GroupCard>
              <View style={styles.emptyBlock} testID="run-ledger-empty">
                {/* 어절 단위로 접는다 — 같은 시트의 요약·기록 줄·한계 문장과 같은 규칙(design-review r2 L2). */}
                <Text
                  style={styles.emptyHeadline}
                  lineBreakStrategyIOS="hangul-word"
                  testID="run-ledger-empty-headline">
                  {empty.headline}
                </Text>
                <Text
                  style={styles.note}
                  lineBreakStrategyIOS="hangul-word"
                  testID="run-ledger-empty-detail">
                  {empty.detail}
                </Text>
              </View>
            </GroupCard>
          ) : (
            <GroupCard testID="run-ledger-rows">
              {rows.map(row => (
                <LedgerRowView key={row.key} row={row} nowMs={nowMs} />
              ))}
            </GroupCard>
          )}
        </View>
      </SheetScroll>
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
          ]}
          lineBreakStrategyIOS="hangul-word">
          {row.text}
          {row.count !== undefined ? (
            <Text style={styles.rowTextNeutral}>{` · ${row.count}번`}</Text>
          ) : null}
        </Text>
      </View>
      {row.reason !== undefined ? (
        <Text style={styles.rowReason} lineBreakStrategyIOS="hangul-word">
          {row.reason}
        </Text>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // 카드 안의 요약 — 안쪽 가로 여백은 카드 행과 같은 값이다.
    head: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.sm,
    },
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
    // 섹션 라벨과 그 아래 카드는 한 묶음이다(`GroupCard` 의 라벨과 같은 간격).
    section: {gap: space.sm},
    limits: {gap: space.xs, paddingHorizontal: space.xs},
    note: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    emptyBlock: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.xs,
    },
    emptyHeadline: {fontSize: font.body, lineHeight: line.body, color: color.text},
    // 카드 안의 한 줄. 줄 사이는 카드의 구분선이 그린다.
    row: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
      gap: space.xs,
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
