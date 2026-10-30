import type {AgentRunProgress} from '@momo/core/lib/api';
import {approvalEndState, isOpenRunPhase} from '@momo/core/features/agents/runPhase';
import {
  doorbellFactOf,
  keepsRunReceipt,
  runStatusLine,
  wantsDoorbellFact,
} from '@momo/core/features/agents/runStatusLine';
import {agentLabel, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import {useQuery} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useStyles} from '../../design/theme';
import {font, line, radius, slopTo, space, type Palette} from '../../design/tokens';
import {useSession} from '../../session/useSession';
import {nudgeRunProgress} from './agentRunProgressStore';
import {RunLedgerSheet} from './RunLedgerSheet';
import {runLedgerQueryOptions, useRunLedgerFrames} from './runLedgerQuery';
import {useTickingNow} from './workingSignal';

// =============================================================================
// 보낸 메시지 아래 상태 한 줄의 폰 판 (#3824). 웹 `MessageRunStatus`와 같은 core
// (`runStatusLine`)를 읽는다:
//
//   그록봇 · 받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중 · 12분째 · 마지막 보고 1분 전
//
// #4020: 평소의 영수증(받았어요 → 가져감 → 완료)은 대화 타임라인 본 줄에서 뺐다. 진행은
// 컴포저 위 「답하는 중」이 말한다. 이 줄은 사람이 알아야 하는 상태(실패·시간 초과·승인
// 대기·소식 끊김·깨우는 신호 불발)에만 선다 — 판정은 core `keepsRunReceipt`.
//
// 줄을 누르면 그 run의 기록 시트가 열린다. run 목록은 타임라인이 한 번 모아 행에 넘긴다.
// 진행 읽기를 싣지 않는 옛 서버에서는 넘길 run이 없어 줄이 서지 않는다.
// =============================================================================

/** 내가 방금 보낸 메시지로 보는 시간. 이 안이면 진행을 한 번 당겨 읽는다. */
const FRESH_SEND_MS = 15_000;

/** 상태 줄 한 줄의 상자 높이: `line.meta` + 위아래 `space.xs`. */
const ROW_HEIGHT = line.meta + space.xs * 2;

export function MessageRunStatus({
  messageId,
  channelId,
  createdAtMs,
  runs,
  directory,
}: {
  messageId: string;
  channelId: string;
  createdAtMs: number;
  runs: readonly AgentRunProgress[];
  directory: Directory;
}): React.JSX.Element | null {
  const fresh = Date.now() - createdAtMs < FRESH_SEND_MS;
  const empty = runs.length === 0;
  useEffect(() => {
    if (fresh && empty) {
      nudgeRunProgress(channelId);
    }
    // 메시지 하나에 한 번이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);
  const [opened, setOpened] = useState<AgentRunProgress | null>(null);
  if (runs.length === 0) {
    return null;
  }
  return (
    <View testID="message-run-status">
      {runs.map(progress => (
        <RunStatusRow
          key={progress.id}
          progress={progress}
          directory={directory}
          onOpen={() => setOpened(progress)}
        />
      ))}
      {opened !== null ? (
        <RunLedgerSheet
          progress={opened}
          directory={directory}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </View>
  );
}

function RunStatusRow({
  progress,
  directory,
  onOpen,
}: {
  progress: AgentRunProgress;
  directory: Directory;
  onOpen: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const {workspaceId} = useSession();
  const key = progress.id.toLowerCase();
  const wants = wantsDoorbellFact(progress);
  const ledger = useQuery({...runLedgerQueryOptions(workspaceId, key), enabled: wants});
  useRunLedgerFrames(wants ? key : null, ledger.refetch);
  const doorbell = useMemo(() => doorbellFactOf(ledger.data?.events), [ledger.data]);
  const keeps = keepsRunReceipt(progress, doorbell);
  const nowMs = useTickingNow(keeps && isOpenRunPhase(progress.phase));
  if (!keeps || approvalEndState(progress.endReason) !== null) {
    return null;
  }
  const status = runStatusLine(progress, doorbell, nowMs);
  const name = agentLabel(
    memberNameParts(directory, progress.agentMemberId, UNKNOWN_AGENT_NAME),
  );
  const chain = status.steps.map(step => step.text).join(' → ');
  const lastIndex = status.steps.length - 1;
  return (
    <Pressable
      accessibilityRole="button"
      // 이름을 명시한다: 초마다 바뀌는 「n초째」를 보조기술이 다시 읽지 않게.
      accessibilityLabel={`${name}: ${chain}. 작업 기록 열기`}
      onPress={onOpen}
      // 한 줄(16) + 위아래 여백(4·4)이 상자다. 손가락 높이는 44까지 슬롭으로 채운다.
      hitSlop={{top: slopTo(ROW_HEIGHT), bottom: slopTo(ROW_HEIGHT)}}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID={`message-run-status-row-${progress.id}`}>
      {/* 어절 단위로 접는다: iOS 기본 줄바꿈은 「12분째」를 「12분 / 째」로 가른다
          (#3824 리뷰, 측정 표면 RUN-STATUS 캡처). 이 줄은 낱말 목록이 아니라
          「… 작업 중 · 12분째 · 마지막 보고 1분 전」으로 읽는 한 문장이다. */}
      <Text
        style={styles.text}
        lineBreakStrategyIOS="hangul-word"
        testID="message-run-status-text">
        <Text style={styles.name}>{name}</Text>
        <Text>{' · '}</Text>
        {status.steps.map((step, index) => (
          <Text key={step.key} testID={`message-run-status-step-${step.key}`}>
            {index > 0 ? ' → ' : ''}
            <Text
              style={
                index === lastIndex
                  ? status.needsHuman
                    ? styles.currentWarn
                    : styles.current
                  : undefined
              }>
              {step.text}
            </Text>
          </Text>
        ))}
        {status.detail !== undefined ? (
          <Text testID="message-run-status-detail">{` · ${status.detail}`}</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      alignSelf: 'flex-start',
      marginTop: space.xs,
      paddingVertical: space.xs,
      borderRadius: radius.sm,
    },
    pressed: {backgroundColor: color.surfacePressed},
    text: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    name: {color: color.agent},
    current: {color: color.text, fontWeight: '600'},
    currentWarn: {color: color.warn, fontWeight: '600'},
  });
