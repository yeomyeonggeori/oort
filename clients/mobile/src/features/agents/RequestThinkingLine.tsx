import type {AgentRunLedgerEvent, AgentRunProgress} from '@momo/core/lib/api';
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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {
  font,
  line,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useSession} from '../../session/useSession';
import {Avatar} from '../conversation/Avatar';
import {RespondingDots} from './RespondingDots';
import {
  RUN_LEDGER_POLL_MS,
  runLedgerQueryOptions,
  useRunLedgerFrames,
} from './runLedgerQuery';

/** 한 줄과 표적을 함께 예약해요. #4620 레일 착륙 때 같은 높이로 연결할 자리예요. */
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

export function requestThinkingSummary(
  progress: AgentRunProgress,
  events?: readonly AgentRunLedgerEvent[],
): string {
  if (thinkingActive(progress)) {
    return requestThinkingWord(progress);
  }
  const parts: string[] = [requestThinkingWord(progress)];
  if (
    progress.startedAtMs !== undefined &&
    progress.finishedAtMs !== undefined
  ) {
    const minutes = Math.floor(
      Math.max(0, progress.finishedAtMs - progress.startedAtMs) / 60_000,
    );
    parts.push(minutes < 1 ? '1분 미만 작업' : `${minutes}분 작업`);
  }
  if (events !== undefined) {
    // 원장이 잘 모르는 새 종류도 rawKind로 보존해요. 없는 수를 run.stepCount로 추측하지 않아요.
    const tools = events.filter(
      event => event.rawKind === 'agent_port.call',
    ).length;
    const approvals = events.filter(
      event => event.kind === 'approval_requested',
    ).length;
    parts.push(`도구 ${tools}`, `승인 ${approvals}`);
  }
  return parts.join(' · ');
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
  const {workspaceId} = useSession();
  const realtime = useRealtime();
  const [expanded, setExpanded] = useState(false);
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
  const summary = requestThinkingSummary(progress, query.data?.events);
  const state = requestBundleState({
    ...runBundleSnapshot(progress),
    run: progress,
  });
  const phaseWord = requestThinkingWord(progress);
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
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name} · ${summary}. 과정 ${
          expanded ? '접기' : '펼치기'
        }`}
        accessibilityState={{expanded}}
        onPress={() => setExpanded(value => !value)}
        style={[styles.row, {height}]}
        testID="request-thinking-line"
      >
        <Avatar
          directory={directory}
          memberId={progress.agentMemberId}
          size={line.label}
        />
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          style={styles.lead}
        >
          {`${name} · ${summary}${detail ? ` · ${detail}` : ''}`}
        </Text>
        {active &&
        realtime.status === 'connected' &&
        realtime.subscriptionsWanted &&
        (state === 'thinking' || state === 'executing') &&
        progress.leaseState !== 'stale' ? (
          <RespondingDots />
        ) : null}
      </Pressable>
      {expanded ? (
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
    process: {gap: space.sm, paddingVertical: space.sm},
    meta: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    retry: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
    stream: {maxHeight: line.meta * 8},
  });
