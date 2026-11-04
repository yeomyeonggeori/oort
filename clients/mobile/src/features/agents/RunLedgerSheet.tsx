import type {AgentRunLedgerEvent, AgentRunProgress} from '@momo/core/lib/api';
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
  isQueuedPhase,
  isRunningPhase,
  runPhaseDetail,
  serverFactsOf,
} from '@momo/core/features/agents/runPhase';
import {runStateWord} from '@momo/core/features/agents/runWaiting';
import {
  agentLabel,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from '@momo/core/features/agents/turnCopy';
import {nextRunDeadlineMs} from '@momo/core/features/agents/runDeadline';
import {workToolRecord} from '@momo/core/features/agents/workTimeline';
import {workActivityRecord} from '@momo/core/features/agents/workReport';
import {workHealth, workHealthLine} from '@momo/core/features/agents/workHealth';
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
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {useRunRow} from './agentRunProgressStore';
import {
  RUN_LEDGER_POLL_MS,
  runLedgerQueryOptions,
  useRunLedgerFrames,
} from './runLedgerQuery';
import {useRerenderAt} from './sheetClock';
import {AgentReportSection, OortRecordSection} from './WorkTimelineParts';

const NO_EVENTS: readonly AgentRunLedgerEvent[] = [];

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
//
// ## 작업 타임라인으로 (#4658, 웹 v1 #4657의 짝)
//
// 웹 작업 패널과 **같은 코어 모델**을 같은 말·같은 순서로 그린다: 요약 카드(머리 칩·걸린 시간·건강 줄) → 「기록」(수명주기·단계,
// 서버가 적은 것) → 「에이전트 보고」(계획 블록 → 활동 줄 → 합계, 에이전트가 스스로 알린 것) → 「oort 기록」(서버가 잰 도구 호출).
// 두 칸은 출처가 달라 **따로 서고** 한 목록에 섞지 않는다(ADR-0200 증보 7 7-7 ①). 칸·줄·모션은 `WorkTimelineParts`다.
//
// - **시계가 없다.** 옛 시트는 열린 run이 있는 동안 1초 시계(`useTickingNow`)로 시트 전체를 매초 다시 그렸다. 지금은 그릴 때의
//   시각을 읽고, 시간만으로 사실이 바뀌는 순간(유예 마감 · 분 숫자가 오르는 때 · 조용함·머문 시간의 문턱)에 **한 번만** 다시
//   그린다(코어 `runDeadline` + `sheetClock`의 `useRerenderAt`, 입력창 레일 #4620과 같은 길). 1분이 안 된 구간은 초 숫자 없이 「방금」·「중」으로 말한다
//   (`minutesOnly`) — 시계 없이 그린 「40초째」는 다음에 그릴 때까지 거짓으로 남는다.
// - **연결이 끊기면**(열린 run만) 맨 위에 「…마지막으로 확인된 상태예요」 한 줄이 서고, 점과 에이전트색은 걷히고, 건강 줄은 시간 신호를
//   빼고 개수만 남긴다. 끝난 run은 더 바뀌지 않으므로 그 줄이 없다.
// ==============================================================================

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
  const formatMessage = useFormatMessage();
  const slideClose = usePageSheetClose() ?? onClose;
  const {workspaceId} = useSession();
  // 실시간 연결이 살아 있는가. 끊긴 화면은 마지막으로 확인된 상태라 지금 하고 있다고 움직이지 않는다(점·에이전트색·시간 신호).
  const connected = useRealtime().status === 'connected';
  const liveRow = useRunRow(opened.id);
  const progress = liveRow ?? opened;
  const open = isOpenRunPhase(progress.phase);
  // 서버가 `running`이라고 말하는가: 점과 계획의 「지금 단계」를 세울 자격이다(가져감·승인 대기는 열려 있어도 일하는 중이 아니다).
  const working = isRunningPhase(progress.phase);
  // 머리 칩의 에이전트색은 「지금 돈다」는 표지라서 연결이 끊기면 걷힌다(줄의 칩·점과 같은 규칙): 끊긴 화면은 마지막으로 확인된 상태다.
  const workingLook = working && connected;
  const key = progress.id.toLowerCase();
  const query = useQuery({
    ...runLedgerQueryOptions(workspaceId, key),
    refetchInterval: open ? RUN_LEDGER_POLL_MS : false,
  });
  useRunLedgerFrames(key, query.refetch);
  const data = query.data;
  const events = data?.events ?? NO_EVENTS;
  const rows = useMemo(
    () => (data === undefined ? [] : ledgerRows(data.events)),
    [data],
  );
  // 「에이전트 보고」·「oort 기록」 칸의 재료. 아직 읽은 원장이 없으면 null(칸이 서지 않는다).
  const activity = useMemo(
    () => (data === undefined ? null : workActivityRecord(data, {open, working})),
    [data, open, working],
  );
  const tools = useMemo(() => (data === undefined ? null : workToolRecord(data)), [data]);
  const facts = serverFactsOf(progress);
  // 시계가 아니라 **그릴 때의 시각**이다. 시간만으로 사실이 바뀌는 순간은 마감 시계(`sheetClock`)가 한 번 다시 그린다.
  const nowMs = Date.now();
  useRerenderAt(open ? nextRunDeadlineMs({facts, events, nowMs, live: connected}) : null);
  // 시트는 1분 단위로만 말한다(`minutesOnly`): 초를 말하려면 초마다 다시 그려야 한다.
  const detail = runPhaseDetail(facts, nowMs, {minutesOnly: true});
  // 건강 줄(#4657): 서버가 적어 둔 사실만으로 말한다. 시간 신호는 연결이 살아 있을 때만 센다. 말할 신호가 없으면 줄이 서지 않는다.
  // 머리의 근거 글이 이미 「마지막 보고 n분 전」을 말하므로 이 줄은 그 시간을 되풀이하지 않는다.
  const healthLine = workHealthLine(
    workHealth({facts, events, nowMs, live: connected}),
    formatMessage,
    {lastReportShownElsewhere: true},
  );
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
        {/* 연결이 끊긴 열린 run: 이 화면은 마지막으로 확인된 상태다(입력창 레일·웹 작업 패널과 같은 문장). */}
        {open && !connected ? (
          <Text
            style={styles.stale}
            lineBreakStrategyIOS="hangul-word"
            testID="run-ledger-stale">
            {TURN_STALE_SENTENCE}
          </Text>
        ) : null}
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
                  workingLook && styles.chipWorking,
                  progress.phase === 'awaiting_approval' && styles.chipWaiting,
                ]}>
                <Text
                  style={[
                    styles.chipText,
                    workingLook && styles.chipWorkingText,
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
              {runDurationBreakdown(facts, nowMs, true)}
            </Text>
            {healthLine !== null ? (
              <Text
                style={styles.health}
                lineBreakStrategyIOS="hangul-word"
                testID="run-ledger-health">
                {healthLine}
              </Text>
            ) : null}
          </View>
        </GroupCard>

        <View style={styles.section} testID="run-ledger-record">
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

        {/* 에이전트가 스스로 알린 활동·계획(#4657, ADR-0200 증보 7). 서버가 잰 줄과 **다른 칸**이고 항상 「에이전트 보고」 꼬리표가
            달린다. 아직 아무도 가져가지 않은 요청에는 알릴 것이 없어 서지 않는다. 점은 서버가 지금 돈다고 말하고 연결도 살아 있을
            때만 선다. */}
        {activity !== null && !isQueuedPhase(progress.phase) ? (
          <AgentReportSection
            record={activity}
            open={open}
            live={connected && working}
            nowMs={nowMs}
          />
        ) : null}

        {/* 서버가 직접 잰 도구 호출(#4654). 위 「기록」(수명주기·에이전트 단계)과 **다른 칸**이다: 출처가 달라 한 목록에 섞지 않는다. */}
        {tools !== null ? (
          <OortRecordSection record={tools} open={open} nowMs={nowMs} />
        ) : null}
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
    // 건강 줄: 걸린 시간 줄 아래의 보조 문장(웹 패널과 같은 자리).
    health: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    // 연결이 끊긴 열린 run의 한정 문장 — 입력창 레일의 끊긴 줄과 같은 `warn` 색(한 사실을 두 위험도로 말하지 않는다).
    stale: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.warn,
      paddingHorizontal: space.xs,
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
