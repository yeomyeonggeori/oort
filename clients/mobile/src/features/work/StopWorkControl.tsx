import {
  killWorkSession,
  type WorkKillResult,
  type WorkSession,
} from '@momo/core/lib/api';
import {
  canStopSession,
  STOP_BUSY_LINE,
  STOP_CONFIRM_ASK,
  STOP_CONFIRM_DETAIL,
  STOP_STOPPED_LINE,
  stopFailureLine,
  stopRequestedLine,
} from '@momo/core/features/work/stopWork';
import {useQueryClient} from '@tanstack/react-query';
import React, {useEffect, useState} from 'react';
import {AccessibilityInfo, Pressable, StyleSheet, Text, View} from 'react-native';

import {SectionLabel, Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {agentKeys} from '../agents/queries';

// =============================================================================
// 작업 멈추기 (N4 #3596, ADR-0198 「N4 확정」).
//
// 서명이 없다: `kill`은 일을 거두는 쪽이라 기기를 잃어도 멈출 수 있어야 한다. 그래서
// 서명 플래그·기기 키와 무관하게 소유자의 running/idle 세션에서 항상 보인다.
// 파괴적이라 한 번 확인한다(실수 방지). 햅틱은 확인을 누른 그 탭에 한 번(`warning`).
// `PATCH ended`가 아니다: 그건 원장만 닫고 맥 프로세스를 멈추지 않는다.
// 「멈춤」은 서버가 세션을 ended로 돌려줄 때(N2의 `work.session.ended` 갱신) 보인다.
// =============================================================================

export type StopStage = 'idle' | 'confirm' | 'busy' | 'requested' | 'stopped';

export interface StopWorkInitial {
  stage?: StopStage;
  note?: {failed: boolean; text: string};
}

type KillFn = (workspaceId: string, sessionId: string) => Promise<WorkKillResult>;

/** Product container: owner + running/idle only; the request, its outcome, the refetch. */
export function StopWorkControl({
  workspaceId,
  memberId,
  session,
  initial,
  kill = killWorkSession,
}: {
  workspaceId: string;
  memberId: string;
  session: WorkSession;
  initial?: StopWorkInitial;
  /** Test seam; the product always uses the core wrapper. */
  kill?: KillFn;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<StopStage>(initial?.stage ?? 'idle');
  const [note, setNote] = useState<{failed: boolean; text: string} | null>(
    initial?.note ?? null,
  );
  const stoppable = canStopSession(session, memberId);
  const ended = session.status === 'ended';
  // 내가 멈춘 세션만 「멈춤」을 말한다. 다른 이유로 끝난 세션에는 아무것도 그리지 않는다.
  const effective: StopStage =
    stage === 'requested' && ended ? 'stopped' : stage;

  // 눌린 버튼이 사라지는 자리라 포커스가 잃는다: 상태가 바뀌면 말로 알린다(스크린리더).
  const announce =
    effective === 'confirm'
      ? STOP_CONFIRM_ASK
      : effective === 'requested'
        ? (note?.text ?? '')
        : effective === 'stopped'
          ? STOP_STOPPED_LINE
          : '';
  useEffect(() => {
    if (announce !== '') AccessibilityInfo.announceForAccessibility(announce);
  }, [announce]);

  if (!stoppable && effective !== 'requested' && effective !== 'stopped') {
    return null;
  }

  const confirm = async () => {
    if (stage !== 'confirm') return;
    // 시각과 같은 프레임, 탭 한 번에 한 번(lib/haptics 계약).
    haptics.warning();
    setStage('busy');
    setNote(null);
    try {
      const result = await kill(workspaceId, session.id);
      setStage('requested');
      setNote({failed: false, text: stopRequestedLine(result)});
      void queryClient.invalidateQueries({
        queryKey: agentKeys.workSessions(workspaceId),
      });
    } catch (error) {
      // 실패하면 누르기 전으로 돌아간다: 아직 돌고 있는 작업에 다시 시도할 수 있어야 한다.
      setStage('idle');
      setNote({failed: true, text: stopFailureLine(error)});
    }
  };

  return (
    <StopWorkControlView
      stage={effective}
      note={note}
      onAsk={() => {
        setNote(null);
        setStage('confirm');
      }}
      onCancel={() => setStage('idle')}
      onConfirm={() => void confirm()}
    />
  );
}

/** Presentational: everything above is data. */
export function StopWorkControlView({
  stage,
  note,
  onAsk,
  onCancel,
  onConfirm,
}: {
  stage: StopStage;
  note: {failed: boolean; text: string} | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const busy = stage === 'busy';
  return (
    <View style={styles.card} testID="work-stop">
      <SectionLabel label="작업 멈추기" />
      <View style={styles.body}>
        {stage === 'stopped' ? (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={`멈춤. ${STOP_STOPPED_LINE}`}
            style={styles.stoppedRow}
            testID="work-stop-stopped">
            <Text style={styles.stoppedChip}>멈춤</Text>
            <Text style={styles.line}>{STOP_STOPPED_LINE}</Text>
          </View>
        ) : stage === 'requested' ? (
          <Sentence style={styles.line} testID="work-stop-requested">
            {note?.text ?? ''}
          </Sentence>
        ) : stage === 'idle' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="작업 멈추기"
            accessibilityHint="확인 단계가 한 번 나와요"
            onPress={onAsk}
            style={({pressed}) => [styles.ask, pressed && styles.pressed]}
            testID="work-stop-ask">
            <Text style={styles.askLabel}>멈추기</Text>
          </Pressable>
        ) : (
          <View style={styles.confirm} testID="work-stop-confirm">
            <Text accessibilityRole="header" style={styles.confirmAsk}>
              {STOP_CONFIRM_ASK}
            </Text>
            <Sentence style={styles.hint}>{STOP_CONFIRM_DETAIL}</Sentence>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? STOP_BUSY_LINE : '이 작업 멈추기'}
              accessibilityState={{disabled: busy, busy}}
              disabled={busy}
              onPress={onConfirm}
              style={({pressed}) => [
                styles.danger,
                busy && styles.inert,
                pressed && !busy && styles.dangerPressed,
              ]}
              testID="work-stop-confirm-button">
              <Text style={styles.dangerLabel}>
                {busy ? STOP_BUSY_LINE : '멈추기'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="멈추지 않고 계속 두기"
              accessibilityState={{disabled: busy}}
              disabled={busy}
              onPress={onCancel}
              style={({pressed}) => [
                styles.cancel,
                busy && styles.inert,
                pressed && !busy && styles.pressed,
              ]}
              testID="work-stop-cancel">
              <Text style={styles.cancelLabel}>계속 두기</Text>
            </Pressable>
          </View>
        )}
        {note?.failed ? (
          <Sentence
            accessibilityRole="alert"
            style={[styles.hint, styles.dangerText]}
            testID="work-stop-error">
            {note.text}
          </Sentence>
        ) : null}
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    card: {paddingBottom: space.sm},
    body: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    line: {fontSize: font.label, lineHeight: line.label, color: color.text},
    hint: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    dangerText: {color: color.dangerText},
    ask: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.dangerBorder,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
    },
    askLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.dangerText,
      fontWeight: '600',
    },
    confirm: {gap: space.sm},
    confirmAsk: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    danger: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      backgroundColor: color.dangerFill,
      paddingHorizontal: space.md,
    },
    dangerLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.onDangerFill,
      fontWeight: '600',
    },
    cancel: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
    },
    cancelLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
      fontWeight: '600',
    },
    stoppedRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    stoppedChip: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '700',
      borderWidth: 1,
      borderColor: color.textFaint,
      borderRadius: ds2Radius.row,
      paddingHorizontal: space.sm,
      paddingVertical: space.xs,
    },
    inert: {opacity: 0.5},
    dangerPressed: {opacity: 0.85},
    pressed: {backgroundColor: color.surfacePressed},
  });
