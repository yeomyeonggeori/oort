import React, {useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {sendMessage} from '@momo/core/lib/api';
import {
  canDelegate,
  delegateButtonLabel,
  delegateMessageBody,
  type TeamAiDelegate,
  type TeamAiDelegateCandidate,
} from '@momo/core/features/timeline/teamAi';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';

// =============================================================================
// 도우미가 넘기는 줄 아래의 「○○에게 맡기기」 — 폰 (ADR-0201 D5, #3836).
//
// 판정은 웹과 같은 코어(`teamAi.ts`)가 한다: 이유 한 줄, 요청자 본인에게만 버튼, 서버가
// 정한 멱등 키, 도우미 멘션을 지운 `@대상 원래 요청` 본문. 렌더만 폰 고유다.
// 워크스페이스를 모르는 표면(측정 하네스)에서는 버튼을 세우지 않는다.
// =============================================================================

type SendState =
  | {kind: 'idle'}
  | {kind: 'sending'; memberId: string}
  | {kind: 'sent'; name: string}
  | {kind: 'error'};

export function TeamAiDelegateStrip({
  delegate,
  workspaceId,
  channelId,
  viewerMemberId,
  sourceBody,
  teamAiHandle,
  offline,
}: {
  delegate: TeamAiDelegate;
  workspaceId: string | undefined;
  channelId: string;
  viewerMemberId: string | undefined;
  sourceBody: string | null;
  teamAiHandle: string | null;
  offline: boolean;
}): React.JSX.Element | null {
  const styles = useStyles(build);
  const palette = usePalette();
  const [state, setState] = useState<SendState>({kind: 'idle'});
  const showButtons =
    workspaceId !== undefined && canDelegate(delegate, viewerMemberId);
  if (delegate.reasonLine === null && !showButtons) return null;

  function press(candidate: TeamAiDelegateCandidate) {
    if (workspaceId === undefined || offline || state.kind === 'sending') return;
    setState({kind: 'sending', memberId: candidate.memberId});
    const body = delegateMessageBody({
      targetHandle: candidate.handle,
      sourceBody,
      teamAiHandles: teamAiHandle !== null ? [teamAiHandle] : [],
    });
    sendMessage(
      workspaceId,
      channelId,
      candidate.clientMsgId,
      body,
      delegate.sourceMessageId !== null
        ? {replyToId: delegate.sourceMessageId}
        : undefined,
    )
      .then(() => setState({kind: 'sent', name: candidate.displayName}))
      .catch(() => setState({kind: 'error'}));
  }

  return (
    <View style={styles.wrap} testID="team-ai-delegate">
      {delegate.reasonLine !== null ? (
        <Sentence style={styles.meta} testID="team-ai-delegate-reason">
          {delegate.reasonLine}
        </Sentence>
      ) : null}
      {showButtons && state.kind === 'sent' ? (
        <Sentence
          style={styles.meta}
          accessibilityLiveRegion="polite"
          testID="team-ai-delegate-sent">
          {`${state.name}에게 맡겼어요. 답은 이 채널에 와요.`}
        </Sentence>
      ) : null}
      {showButtons && state.kind !== 'sent' ? (
        <View style={styles.buttons}>
          {delegate.candidates.map(candidate => {
            const sending =
              state.kind === 'sending' && state.memberId === candidate.memberId;
            const blocked = offline || state.kind === 'sending';
            return (
              <Pressable
                key={candidate.memberId}
                accessibilityRole="button"
                accessibilityState={{disabled: blocked, busy: sending}}
                onPress={() => press(candidate)}
                testID="team-ai-delegate-button"
                style={({pressed}) => [
                  styles.pill,
                  offline && styles.dim,
                  pressed && !blocked && styles.pressed,
                ]}>
                {sending ? (
                  <ActivityIndicator size="small" color={palette.textMuted} />
                ) : null}
                <Text style={styles.pillLabel}>
                  {delegateButtonLabel(candidate)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {showButtons && offline && state.kind !== 'sent' ? (
        <Sentence style={styles.meta}>연결이 끊겨 지금은 맡길 수 없어요.</Sentence>
      ) : null}
      {showButtons && state.kind === 'error' ? (
        <Sentence
          style={styles.error}
          accessibilityRole="alert"
          testID="team-ai-delegate-error">
          보내지 못했어요. 연결을 확인하고 다시 눌러 주세요.
        </Sentence>
      ) : null}
    </View>
  );
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.xs, gap: space.sm},
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    error: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
    buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
    /** 웹 `Button variant="secondary"` 의 폰 번역: 채움 알약, 테두리 없음(ADR-0189 D6). */
    pill: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceMuted,
    },
    pillLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    dim: {opacity: 0.5},
    pressed: {opacity: 0.6},
  });
}
