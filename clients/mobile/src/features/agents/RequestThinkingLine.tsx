import type {AgentRunProgress} from '@momo/core/lib/api';
import {
  isOpenRunPhase,
  runPhaseLabel,
  serverFactsOf,
  approvalEndState,
} from '@momo/core/features/agents/runPhase';
import {RAIL_WORD} from '@momo/core/features/agents/activityRail';
import {
  ledgerRows,
  RUN_LEDGER_LIMIT_SENTENCE,
} from '@momo/core/features/agents/runLedger';
import {
  appendProgress,
  openWorkLog,
  type WorkLog,
} from '@momo/core/features/agents/workLog';
import {
  runReportChipParts,
  runReportChipText,
  runReportSummary,
  type RunReportSummary,
} from '@momo/core/features/agents/workReport';
import {
  requestBundleState,
  REQUEST_BUNDLE_FACE,
  runBundleSnapshot,
} from '@momo/core/features/timeline/requestBundle';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {useQuery} from '@tanstack/react-query';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {
  font,
  line,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {Avatar} from '../conversation/Avatar';
import {RespondingDots} from './RespondingDots';
import {
  RUN_LEDGER_POLL_MS,
  runLedgerQueryOptions,
  useRunLedgerFrames,
} from './runLedgerQuery';
import {RunLedgerSheet} from './RunLedgerSheet';

/**
 * 한 줄과 표적을 함께 예약해요. #4620 입력창 레일(`ActivityRail`)과 표적은 같은 44예요. 높이는 연결하지 않았어요: 레일은 도크의 흐름 안에서
 * 칸이 줄 상자 하나(`CONV.agentRailSlot`)이고 44는 손가락 슬롭이 채우는 반면, 이 줄은 목록 안의 행이라 칸이 곧 표적(44)이에요.
 */
export const REQUEST_THINKING_HEIGHT = TOUCH_TARGET;
const STREAM_LIMIT =
  '흐르는 글과 도구 호출은 저장하지 않아요. 이 칸을 연 뒤에 도착한 것만 보여요.';

function thinkingActive(progress: AgentRunProgress): boolean {
  return (
    isOpenRunPhase(progress.phase) &&
    ['thinking', 'approval', 'executing'].includes(
      requestBundleState({...runBundleSnapshot(progress), run: progress}),
    )
  );
}

function requestThinkingWord(progress: AgentRunProgress): string {
  if (progress.phase === 'queued') return RAIL_WORD.received;
  if (progress.phase === 'claimed') return RAIL_WORD.claimed;
  if (progress.phase === 'paused') return RAIL_WORD.paused;
  if (
    progress.phase === 'timed_out' &&
    approvalEndState(progress.endReason) === null
  )
    return runPhaseLabel(serverFactsOf(progress));
  return REQUEST_BUNDLE_FACE[
    requestBundleState({...runBundleSnapshot(progress), run: progress})
  ].word;
}

/** 아직 원장을 못 읽었을 때의 요약 재료: 시간만 말하고 에이전트 보고 숫자는 지어내지 않아요(웹 `RequestThoughtLine`과 같아요). */
const NO_REPORT: RunReportSummary = {stages: 0, kinds: []};

/**
 * 끝난 요청의 요약 칩 재료(#4658, 웹 `RequestThoughtLine`과 같은 말): 「13분 · 단계 6 · 명령 12」 + 꼬리표 「에이전트 보고」. 걸린 시간은
 * 서버 시계의 사실이고 그 뒤 숫자는 에이전트가 스스로 알린 것이라 끝에 꼬리표가 붙어요. oort가 잰 도구 호출은 출처가 달라 섞지
 * 않아요(#4654). 열린 run이거나 끝난 시각을 모르면 null이에요(시간을 지어내지 않아요).
 */
export function requestThinkingChip(
  progress: AgentRunProgress,
  report: RunReportSummary | null,
  formatMessage: ReturnType<typeof useFormatMessage>,
): {body: string; tail: string | null; text: string} | null {
  if (isOpenRunPhase(progress.phase) || progress.finishedAtMs === undefined) {
    return null;
  }
  const duration = Math.max(
    0,
    progress.finishedAtMs - (progress.startedAtMs ?? progress.createdAtMs),
  );
  const summary = report ?? NO_REPORT;
  return {
    ...runReportChipParts(duration, summary, formatMessage),
    text: runReportChipText(duration, summary, formatMessage),
  };
}

export function RequestThinkingLine({
  progress,
  directory,
  nowMs,
}: {
  progress?: AgentRunProgress;
  directory: Directory;
  nowMs: number;
}): React.JSX.Element {
  const {fontScale} = useWindowDimensions();
  // Dynamic Type가 바뀔 때 한 번만 새 예약 높이가 돼요. 국면·단계는 높이를 바꾸지 않아요.
  const height = Math.max(
    REQUEST_THINKING_HEIGHT,
    line.label * Math.min(fontScale, BAR_CONTROL_MAX_SCALE) + space.sm * 2,
  );
  return (
    <View style={{minHeight: height}} testID="request-thinking-slot">
      {progress ? (
        <ThinkingBody
          key={progress.id}
          progress={progress}
          directory={directory}
          nowMs={nowMs}
          height={height}
        />
      ) : null}
    </View>
  );
}

function ThinkingBody({
  progress,
  directory,
  nowMs,
  height,
}: {
  progress: AgentRunProgress;
  directory: Directory;
  nowMs: number;
  height: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {workspaceId} = useSession();
  const realtime = useRealtime();
  const [expanded, setExpanded] = useState(false);
  // 끝난 요청은 줄을 눌러 펼치지 않고 작업 기록 시트를 연다(웹은 작업 패널을 연다). 과정은 시트에 있다.
  const [recordOpen, setRecordOpen] = useState(false);
  const active = thinkingActive(progress);
  const query = useQuery({
    ...runLedgerQueryOptions(workspaceId, progress.id.toLowerCase()),
    enabled: workspaceId !== '',
    refetchInterval: active ? RUN_LEDGER_POLL_MS : false,
  });
  useRunLedgerFrames(progress.id, query.refetch);
  const rows = useMemo(
    () =>
      ledgerRows(query.data?.events ?? []).map(row => {
        const event = query.data?.events.find(
          candidate =>
            candidate.createdAtMs === row.atMs && candidate.kind === row.kind,
        );
        return row.kind === 'approval_decided' && event?.code === 'rejected'
          ? {...row, text: REQUEST_BUNDLE_FACE.declined.word}
          : row;
      }),
    [query.data],
  );
  const state = requestBundleState({
    ...runBundleSnapshot(progress),
    run: progress,
  });
  const phaseWord = requestThinkingWord(progress);
  // 끝난 요청의 요약 칩(웹과 같은 말). 요약의 숫자는 에이전트가 말한 것만이다: 원장을 못 읽은 동안은 시간만 말한다.
  const chip = requestThinkingChip(
    progress,
    query.data === undefined ? null : runReportSummary(query.data),
    formatMessage,
  );
  const finished = !isOpenRunPhase(progress.phase);
  const name =
    memberFor(directory, progress.agentMemberId)?.displayName ?? '에이전트';
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (
      lastPhase.current !== phaseWord &&
      (lastPhase.current !== null || state === 'approval')
    ) {
      AccessibilityInfo.announceForAccessibility(`${name} · ${phaseWord}`);
    }
    lastPhase.current = phaseWord;
  }, [phaseWord, name, state]);
  const silentMinutes =
    progress.lastEventAtMs === undefined
      ? 0
      : Math.floor((nowMs - progress.lastEventAtMs) / 60_000);
  const stage = Array.from(
    (progress.latestStage ?? '').replace(/\s+/g, ' ').trim(),
  )
    .slice(0, 40)
    .join('');
  const detail =
    active && progress.leaseState === 'stale' && silentMinutes > 0
      ? `${silentMinutes}분째 소식 없음`
      : progress.phase === 'running' && stage !== ''
      ? stage
      : undefined;
  // 끝난 요청이 끝났다는 말: 끝(done)은 확인 표시가 말하고, 그 밖의 끝(실패·거부·만료·취소)은 낱말이 줄 앞에 남는다(이 줄이 그 낱말을 말하는
  // 유일한 자리인 경우가 있다 — 승인 거부·만료는 예외 줄이 서지 않는다).
  const isDone = state === 'done';
  const endWord = isDone ? '' : `${phaseWord} · `;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          chip !== null
            ? `${name} · ${phaseWord} · ${chip.text}`
            : `${name} · ${phaseWord}${finished ? '' : `. 과정 ${expanded ? '접기' : '펼치기'}`}`
        }
        accessibilityHint={
          finished ? formatMessage('timeline.agentRail.openRecord', {name}) : undefined
        }
        accessibilityState={finished ? undefined : {expanded}}
        onPress={() =>
          finished ? setRecordOpen(true) : setExpanded(value => !value)
        }
        style={[styles.row, {height}]}
        testID="request-thinking-line"
      >
        <Avatar
          directory={directory}
          memberId={progress.agentMemberId}
          size={line.label}
        />
        {chip !== null && isDone ? (
          <Image
            source={CONV_ICONS.check}
            style={styles.check}
            accessible={false}
            testID="request-thinking-done"
          />
        ) : null}
        {chip !== null ? (
          // 보이는 글은 몸과 꼬리표로 나눠 그린다: 좁은 칸에서 몸이 줄임표를 받아도 「에이전트 보고」(숫자가 누구의 말인지)는 남는다.
          <View style={styles.chipLine}>
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              style={styles.chipBody}
              testID="request-thinking-chip-body"
            >
              {`${name} · ${endWord}${chip.body}`}
            </Text>
            {chip.tail !== null ? (
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                style={styles.chipTail}
                testID="request-thinking-chip-tail"
              >
                {` · ${chip.tail}`}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            style={styles.lead}
          >
            {`${name} · ${phaseWord}${detail ? ` · ${detail}` : ''}`}
          </Text>
        )}
        {active &&
        realtime.status === 'connected' &&
        realtime.subscriptionsWanted &&
        (state === 'thinking' || state === 'executing') &&
        progress.leaseState !== 'stale' ? (
          <RespondingDots />
        ) : null}
      </Pressable>
      {/* 펼친 채로 run이 끝나면 인라인 과정은 접힌다: 끝난 요청의 줄은 눌러서 시트를 여는 입구이고(과정은 시트에 있다), 줄을 다시 눌러 접을 길이 없다. */}
      {expanded && !finished ? (
        <View style={styles.process} testID="request-thinking-process">
          <Sentence style={styles.meta}>{RUN_LEDGER_LIMIT_SENTENCE}</Sentence>
          {query.isLoading ? (
            <Text style={styles.meta}>과정을 읽고 있어요</Text>
          ) : query.isError && rows.length === 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void query.refetch()}
              style={styles.retry}
            >
              <Text style={styles.meta}>과정을 읽지 못했어요 · 다시 시도</Text>
            </Pressable>
          ) : rows.length === 0 ? (
            <Text style={styles.meta}>아직 받은 과정이 없어요</Text>
          ) : (
            rows.map(row => (
              <Sentence key={row.key} style={styles.meta}>
                {row.text}
                {row.count ? ` · ${row.count}번` : ''}
              </Sentence>
            ))
          )}
          {active ? (
            <LiveThought key={progress.id} progress={progress} />
          ) : null}
        </View>
      ) : null}
      {recordOpen ? (
        <RunLedgerSheet
          progress={progress}
          directory={directory}
          onClose={() => setRecordOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** 펼친 동안 받은 조각만 React 메모리에 두고, 접기·종결·재연결 때 모두 버려요. */
function LiveThought({
  progress,
}: {
  progress: AgentRunProgress;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId} = useSession();
  const {rail, subscriptionsWanted, status} = useRealtime();
  const [log, setLog] = useState<WorkLog | null>(null);
  useEffect(() => {
    setLog(null);
    if (!rail || !subscriptionsWanted || status !== 'connected') return;
    let current = openWorkLog(
      {
        runId: progress.id,
        memberId: progress.agentMemberId,
        channelId: progress.channelId,
      },
      Date.now(),
    );
    return rail.subscribeAgent(
      workspaceId,
      progress.channelId,
      progress.agentMemberId,
      {
        onEvent: event => {
          if (event.payload.run_id.toLowerCase() !== progress.id.toLowerCase())
            return;
          current = appendProgress(current, event, Date.now());
          setLog(current.closed ? null : current);
        },
      },
    );
  }, [
    rail,
    subscriptionsWanted,
    status,
    workspaceId,
    progress.id,
    progress.channelId,
    progress.agentMemberId,
  ]);
  const text =
    log?.entries
      .filter(entry => entry.kind === 'text')
      .map(entry => entry.text)
      .join('\n') ?? '';
  return (
    <View style={styles.process}>
      <Sentence style={styles.meta}>{STREAM_LIMIT}</Sentence>
      {text !== '' ? (
        <ScrollView
          style={styles.stream}
          nestedScrollEnabled
          testID="request-thinking-stream"
        >
          <Sentence style={styles.meta}>{text}</Sentence>
        </ScrollView>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    lead: {
      flex: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    // 끝난 요청의 요약 칩: 몸은 줄어들 수 있고 꼬리표는 줄지 않는다.
    chipLine: {flex: 1, flexDirection: 'row', alignItems: 'baseline'},
    chipBody: {
      flexShrink: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    chipTail: {
      flexShrink: 0,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    check: {
      width: CONV_ICON_SIZE.check,
      height: CONV_ICON_SIZE.check,
      tintColor: color.ok,
    },
    process: {gap: space.sm, paddingVertical: space.sm},
    meta: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    retry: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    stream: {maxHeight: line.meta * 8},
  });
