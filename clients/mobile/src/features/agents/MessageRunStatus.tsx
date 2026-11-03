import {uuidEq, type AgentLiveness, type AgentRunProgress} from '@momo/core/lib/api';
import {
  nextUncollectedDeadlineMs,
  runException,
  runExceptionText,
} from '@momo/core/features/agents/runException';
import {cancelWordingFor, type CancelOutcome} from '@momo/core/features/agents/runCancel';
import {serverFactsOf} from '@momo/core/features/agents/runPhase';
import {doorbellFactOf, wantsDoorbellFact} from '@momo/core/features/agents/runStatusLine';
import {agentLabel, UNKNOWN_AGENT_NAME} from '@momo/core/features/agents/turnCopy';
import {memberFor, memberNameParts, type Directory} from '@momo/core/features/workspace/directory';
import {useQuery} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {useStyles} from '../../design/theme';
import {font, line, radius, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useSession} from '../../session/useSession';
import {nudgeRunProgress} from './agentRunProgressStore';
import {useFireAt} from './railClock';
import {ICONS} from './RequestStatusChip';
import {RunLedgerSheet} from './RunLedgerSheet';
import {runLedgerQueryOptions, useRunLedgerFrames} from './runLedgerQuery';
import {StopTurnControl} from './StopTurnControl';
import {useAgentLiveness} from './useAgentLiveness';

// =============================================================================
// 에이전트를 부른 메시지 아래 **예외 줄**의 폰 판 (#4620 D, #4577 권장 D). 웹 `MessageRunStatus`와 같은 코어(`runException`)가
// 판정하고 같은 낱말로 말한다:
//
//   ◐ 달무리봇: 아직 받지 않았어요 · 다음 확인 때 가져가요(보통 15분 안)     [에이전트 설정 열기] [취소]
//   ◐ 달무리봇: 깨우는 신호가 닿지 않음                                       [에이전트 설정 열기] [취소]
//   ✕ 달무리봇: 실패 · 에이전트가 오류로 끝냈어요
//   ◷ 달무리봇: 신호 소실 · 가져간 에이전트가 오래 응답하지 않아 서버가 끝냈어요
//
// 평소의 진행(받음 → 가져감 → 작업 중 → 답)에는 이 줄이 **없다**: 실시간 상태는 입력창 레일이, 부른 일이 어디까지 갔나는 메시지 머리의 칩이
// 말한다. 예전 줄은 「받았어요 → 깨우는 신호 보냄 → 가져감 → 작업 중」과 「12분째 · 마지막 보고 1분 전」을 **매초** 다시 그렸다(1초 시계) —
// 계속 떠 있어 어수선하고 입력창 위의 대화를 흔든다는 owner의 판단(2026-10-26)이 이 변경의 이유다. 이 줄의 글자에는 초 단위 숫자가 없고
// 경과를 말하지 않으므로 시계가 없다: 줄은 서고 나면 가만히 있고, 「받음」이 「아직 받지 않았어요」로 넘어가는 유예 마감에 **한 번만** 다시 그린다.
//
// ## 행동
//
// 줄의 글은 그 run의 작업 기록 시트를 여는 입구다. **문장은 모두에게, 행동 단추는 요청자와 워크스페이스 owner/admin에게만** 선다(웹
// `mayAct`와 같은 정책 한 곳): 남이 부른 요청마다 멤버 수만큼의 화면에 같은 단추가 서면 어수선하다.
//
//   에이전트 설정 열기  그 에이전트의 프로필(`onOpenProfile`)
//   취소               `StopTurnControl`(한 겹의 확인, `cancelWordingFor`) — 아직 열려 있는 run에만
//   다시 깨우기         **폰에는 없다**: 도어벨 수동 호출은 연결 목록(owner/admin 전용 읽기)이 필요한 관리 동작이라 데스크탑에 있다
//                      (`AgentLivenessLabel` 머리말). 되지 않는 행동을 죽은 버튼으로 세우지 않는다.
//
// 취소를 확정하면 run이 취소로 넘어가 예외가 걷히지만, **그 결과 문장은 줄이 사라져도 남는다**(영수증): 줄과 함께 확인이 사라지면
// 사람은 취소가 됐는지 모른다.
//
// 이 줄이 서는 행에는 칩도 있다(칩은 예외 run을 반드시 센다). 행은 칩과 단추가 각자 접근성 원소가 되도록 한 덩어리로 합치지 않는다
// (`MessageRow`의 `accessible` 조건).
// =============================================================================

/** 내가 방금 보낸 메시지로 보는 시간. 이 안이면 진행을 한 번 당겨 읽는다. */
const FRESH_SEND_MS = 15_000;

/** 줄 한 줄의 상자 높이: `line.meta` + 위아래 `space.xs`. 손가락 높이 44는 슬롭으로 채운다. */
const ROW_HEIGHT = line.meta + space.xs * 2;

export function MessageRunStatus({
  messageId,
  channelId,
  createdAtMs,
  runs,
  directory,
  requesterId,
  viewerId,
  onOpenProfile,
}: {
  messageId: string;
  channelId: string;
  createdAtMs: number;
  runs: readonly AgentRunProgress[];
  directory: Directory;
  /** 이 메시지를 쓴 사람(요청자). 행동 단추를 세울 자격의 한 줄기. */
  requesterId?: string;
  /** 지금 보는 사람. */
  viewerId?: string;
  /** 에이전트 프로필을 연다. 없으면 설정 단추가 서지 않는다. */
  onOpenProfile?: (memberId: string) => void;
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
  // 취소 영수증은 줄이 사라져도 남아야 하므로(대기 → 취소로 넘어가며 예외가 걷힌다) 줄보다 오래 사는 이 자리가 쥔다.
  const [receipts, setReceipts] = useState<Readonly<Record<string, CancelOutcome>>>({});
  // 유예 마감에 **한 번만** 다시 그린다 — 줄도 칩도 경과를 말하지 않으므로 시계가 필요한 순간은 그 한 번뿐이다.
  const [, setTick] = useState(0);
  const fire = useCallback(() => setTick(tick => tick + 1), []);
  useFireAt(nextUncollectedDeadlineMs(runs, Date.now()), fire);
  const candidates = runs.filter(mayHaveException);
  if (candidates.length === 0) {
    return null;
  }
  return (
    <View testID="message-run-status">
      {candidates.map(progress => {
        const common = {
          progress,
          directory,
          requesterId,
          viewerId,
          receipt: receipts[progress.id.toLowerCase()],
          onReceipt: (outcome: CancelOutcome) =>
            setReceipts(current => ({...current, [progress.id.toLowerCase()]: outcome})),
          onOpen: () => setOpened(progress),
          onOpenProfile,
        };
        return progress.phase === 'queued' ? (
          <QueuedExceptionRow key={progress.id} {...common} />
        ) : (
          <RunExceptionView key={progress.id} {...common} />
        );
      })}
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

/**
 * 줄을 세울 수 있는 run인가. 그 밖의 phase(가져감·작업 중·승인·성공)는 훅도 읽기도 없이 건너뛴다. `cancelled`는 줄을 세우지 않지만
 * **영수증이 남으려면** 대기에서 취소로 넘어가는 동안 같은 행이 마운트된 채여야 해서 포함한다(예외가 없으면 아무것도 그리지 않는다).
 */
function mayHaveException(run: AgentRunProgress): boolean {
  return (
    run.phase === 'queued' ||
    run.phase === 'failed' ||
    run.phase === 'timed_out' ||
    run.phase === 'cancelled'
  );
}

interface RowProps {
  progress: AgentRunProgress;
  directory: Directory;
  requesterId?: string;
  viewerId?: string;
  receipt?: CancelOutcome;
  onReceipt: (outcome: CancelOutcome) => void;
  onOpen: () => void;
  onOpenProfile?: (memberId: string) => void;
}

/**
 * 아직 아무도 가져가지 않은 run의 줄: 깨우는 신호의 원장과 서버의 생존 판정을 읽어 이유를 더한다. 읽기가 필요한 것은 이 phase뿐이라
 * 나머지 phase의 줄은 세션도 질의도 모른다(`RunExceptionView`).
 */
function QueuedExceptionRow(props: RowProps): React.JSX.Element | null {
  const {workspaceId} = useSession();
  const key = props.progress.id.toLowerCase();
  const wants = wantsDoorbellFact(props.progress);
  const ledger = useQuery({...runLedgerQueryOptions(workspaceId, key), enabled: wants});
  useRunLedgerFrames(wants ? key : null, ledger.refetch);
  const doorbell = useMemo(() => doorbellFactOf(ledger.data?.events), [ledger.data]);
  // 서버의 생존 판정은 아직 아무도 가져가지 않은 요청에만 이유를 더한다(「연결이 꺼져 있을 수 있어요」).
  const liveness = useAgentLiveness(props.progress.agentMemberId);
  return <RunExceptionView {...props} doorbell={doorbell} liveness={liveness.liveness} />;
}

function RunExceptionView({
  progress,
  directory,
  requesterId,
  viewerId,
  receipt,
  onReceipt,
  onOpen,
  onOpenProfile,
  doorbell,
  liveness,
}: RowProps & {
  doorbell?: ReturnType<typeof doorbellFactOf>;
  liveness?: Pick<AgentLiveness, 'state'> | null;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const exception = runException(progress, Date.now(), {
    ...(doorbell === undefined ? {} : {doorbell}),
    ...(liveness === undefined ? {} : {liveness}),
  });
  if (exception === null && receipt === undefined) {
    return null;
  }
  const name = agentLabel(
    memberNameParts(directory, progress.agentMemberId, UNKNOWN_AGENT_NAME),
  );
  const viewerRole = memberFor(directory, viewerId)?.role;
  const mayAct =
    viewerId !== undefined &&
    ((requesterId !== undefined && uuidEq(viewerId, requesterId)) ||
      viewerRole === 'owner' ||
      viewerRole === 'admin');
  const text = exception === null ? '' : runExceptionText(name, exception);
  const icon =
    exception === null
      ? undefined
      : exception.kind === 'failed'
        ? 'CircleX'
        : exception.kind === 'timed_out'
          ? 'Clock'
          : 'CircleDot';
  const toneStyle = exception?.kind === 'failed' ? styles.danger : styles.warn;
  return (
    <View testID={`message-run-status-row-${progress.id}`}>
      {exception !== null ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formatMessage('timeline.runException.open', {text})}
            onPress={onOpen}
            // 한 줄(16) + 위아래 여백(4·4)이 상자다. 손가락 높이는 44까지 슬롭으로 채운다.
            hitSlop={{top: slopTo(ROW_HEIGHT), bottom: slopTo(ROW_HEIGHT)}}
            style={({pressed}) => [styles.row, pressed && styles.pressed]}
            testID={`message-run-status-open-${progress.id}`}>
            {icon !== undefined ? (
              <Image
                accessible={false}
                source={ICONS[icon]}
                style={[styles.icon, toneStyle]}
              />
            ) : null}
            {/* 어절 단위로 접는다: iOS 기본 줄바꿈은 「12분째」 같은 낱말을 가른다(#3824 리뷰). 이 줄은 낱말 목록이 아니라
                「달무리봇: 실패 · 에이전트가 오류로 끝냈어요」로 읽는 한 문장이다. */}
            <Text
              style={styles.text}
              lineBreakStrategyIOS="hangul-word"
              testID="message-run-status-text">
              <Text style={styles.name}>{name}</Text>
              <Text>{': '}</Text>
              <Text style={[styles.headline, toneStyle]} testID="message-run-status-headline">
                {exception.headline}
              </Text>
              {exception.reason !== undefined ? (
                <Text testID="message-run-status-reason">{` · ${exception.reason}`}</Text>
              ) : null}
            </Text>
          </Pressable>
          {mayAct && exception.open ? (
            <View style={styles.actions} testID={`message-run-status-actions-${progress.id}`}>
              {exception.actions.includes('settings') && onOpenProfile !== undefined ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={formatMessage('timeline.runException.settings')}
                  onPress={() => onOpenProfile(progress.agentMemberId)}
                  style={({pressed}) => [styles.action, pressed && styles.pressed]}
                  testID={`message-run-status-settings-${progress.id}`}>
                  <Text style={styles.actionText}>{formatMessage('timeline.runException.settings')}</Text>
                </Pressable>
              ) : null}
              {exception.actions.includes('cancel') ? (
                <StopTurnControl
                  runId={progress.id}
                  agentName={name}
                  wording={cancelWordingFor(serverFactsOf(progress))}
                  onOutcome={onReceipt}
                  testIDPrefix={`run-exception-stop-${progress.id}`}
                />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
      {receipt !== undefined ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.receipt, receipt.kind === 'error' && styles.danger]}
          testID={`run-exception-stop-outcome-${receipt.kind}`}>
          {receipt.sentence}
        </Text>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.xs,
      marginTop: space.xs,
      paddingVertical: space.xs,
      borderRadius: radius.sm,
    },
    pressed: {backgroundColor: color.surfacePressed},
    icon: {width: line.meta, height: line.meta, resizeMode: 'contain'},
    text: {flexShrink: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    name: {color: color.agent},
    headline: {fontWeight: '600'},
    warn: {color: color.warn, tintColor: color.warn},
    danger: {color: color.danger, tintColor: color.danger},
    actions: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
    action: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    actionText: {fontSize: font.meta, lineHeight: line.meta, color: color.text, fontWeight: '600'},
    receipt: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted, marginTop: space.xs},
  });
